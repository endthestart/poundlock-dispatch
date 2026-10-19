/**
 * What a durable job may upload, whatever the project's own `.gitignore` says.
 *
 * Every file in a snapshot is base64'd into the job body and POSTed to the
 * controller, so a miss here sends a credential off this machine. The old
 * standalone `pdcli` shipped exactly that miss: a hand-written matcher anchored
 * `^…$` against a path with no leading slash, so root-anchored rules such as
 * `/.env` matched nothing, and a project's `.env` and `config/secrets.json`
 * went to the controller. These tests pin the floor the terminal `jobs` commands
 * and the desktop app share.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { collectLiveSnapshot, listLiveProjectFiles, previewFolder } from "@core/snapshot";
import { DEFAULT_EXCLUSIONS } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

/** A marker that must never appear in an upload, in any encoding. */
const SECRET = "sk-live-DO-NOT-UPLOAD-1234567890";

const SECRET_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  "config/secrets.json",
  "apps/web/.env",
  "apps/web/config/secrets.json",
  "server/private.pem",
  "deploy/id_ed25519",
  ".envrc",
  "infra/terraform.tfstate",
  "infra/terraform.tfstate.backup",
  "infra/prod.tfvars",
  "infra/prod.tfvars.json",
  ".vault-token",
  "keys/build-service-account.json",
  "keys/ci_service_account.json",
];

const KEPT_FILES = [
  ".env.example",
  "apps/web/.env.example",
  "README.md",
  "src/index.ts",
  "config/settings.json",
  "infra/main.tf",
  "infra/prod.tfvars.example",
];

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function project(gitignore?: string): Promise<string> {
  const root = await tempDir("dispatch-secrets-");
  for (const path of SECRET_FILES) await put(root, path, SECRET);
  for (const path of KEPT_FILES) await put(root, path, "ok\n");
  if (gitignore !== undefined) await put(root, ".gitignore", gitignore);
  return root;
}

/** Every way the code can enumerate files for upload, so none can drift from the others. */
async function uploads(root: string): Promise<Record<string, string[]>> {
  const preview = await previewFolder(root);
  const live = await listLiveProjectFiles(root);
  const collected = await collectLiveSnapshot(root);
  return {
    previewFolder: preview.files.filter((file) => file.included).map((file) => file.path),
    listLiveProjectFiles: live.map((file) => file.path),
    collectLiveSnapshot: collected.map((file) => file.path),
  };
}

function expectFloor(found: Record<string, string[]>): void {
  for (const [source, paths] of Object.entries(found)) {
    for (const secret of SECRET_FILES)
      expect(paths, `${source} must not include ${secret}`).not.toContain(secret);
    for (const kept of KEPT_FILES) expect(paths, `${source} must keep ${kept}`).toContain(kept);
  }
}

describe("snapshot secret floor", () => {
  it("excludes secrets and keeps .env.example in a project with no .gitignore", async () => {
    expectFloor(await uploads(await project()));
  });

  it("still excludes them when .gitignore says nothing about them", async () => {
    expectFloor(await uploads(await project("node_modules/\n*.log\ncoverage/\n")));
  });

  it("does not let a .gitignore negation bring a secret back", async () => {
    const root = await project("!.env\n!.env.*\n!config/secrets.json\n!*.pem\n!id_ed25519\n");
    expectFloor(await uploads(root));
  });

  it("never puts a secret's contents into the collected snapshot, in any encoding", async () => {
    const collected = await collectLiveSnapshot(await project());
    const everything = collected.map((file) => file.content.toString("utf8")).join("\n");
    expect(everything).not.toContain(SECRET);
    const base64 = collected.map((file) => file.content.toString("base64")).join("\n");
    expect(base64).not.toContain(Buffer.from(SECRET).toString("base64"));
  });

  it("covers the credential file names a project is likely to hold", () => {
    const names = [
      "secrets.json",
      "secrets.yml",
      "secrets.yaml",
      "secrets.toml",
      "id_ed25519",
      "id_ecdsa",
      "*.jks",
      "*.keystore",
      ".htpasswd",
      ".pgpass",
      "*.pem",
      "*.key",
      ".npmrc",
    ];
    for (const name of names) expect(DEFAULT_EXCLUSIONS as readonly string[]).toContain(name);
  });
});

describe("snapshot path anchoring", () => {
  // These rules are not in the built-in floor, so only the project's own
  // `.gitignore` can exclude them. The old matcher silently dropped every rule
  // that started with a slash, so each of these files would have been uploaded.
  const ANCHORED = "/private-notes.txt\n/config/prod-settings.json\n/vault/\n/.env\n";
  const ROOT_ONLY = ["private-notes.txt", "config/prod-settings.json", "vault/token.txt"];
  const NESTED = ROOT_ONLY.map((path) => `pkg/${path}`);

  async function anchoredProject(): Promise<string> {
    const root = await project(ANCHORED);
    for (const path of [...ROOT_ONLY, ...NESTED]) await put(root, path, "anchored\n");
    return root;
  }

  it("honours root-anchored .gitignore rules, and only at the root", async () => {
    const found = await uploads(await anchoredProject());
    // The folder preview applies the built-in floor alone and never reads a
    // .gitignore; only the two readers that build a real upload do.
    delete found.previewFolder;
    for (const [source, paths] of Object.entries(found)) {
      for (const gone of ROOT_ONLY)
        expect(paths, `${source} must exclude anchored ${gone}`).not.toContain(gone);
      // A leading slash anchors the rule to the project root: the same name in a
      // sub-package is a different file and stays.
      for (const kept of NESTED)
        expect(paths, `${source} must keep ${kept}, which the rule does not name`).toContain(kept);
    }
  });

  it("keeps secrets excluded when /.env and /config/secrets.json are the only rules", async () => {
    expectFloor(await uploads(await project("/.env\n/config/secrets.json\n")));
  });

  it("reaches the same answer however the root is spelled", async () => {
    const root = await anchoredProject();
    const expected = (await collectLiveSnapshot(root)).map((file) => file.path);
    for (const gone of ROOT_ONLY) expect(expected).not.toContain(gone);

    const relativeRoot = relative(process.cwd(), root);
    const link = join(await tempDir("dispatch-link-"), "via-link");
    await symlink(root, link);
    for (const spelling of [`${root}/`, `${root}/.`, relativeRoot, `${relativeRoot}/`, link]) {
      const paths = (await collectLiveSnapshot(spelling)).map((file) => file.path);
      expect(paths, `root spelled ${spelling}`).toEqual(expected);
    }
  });
});

describe("build output", () => {
  it("is left out of change tracking, as SwiftPM's .build is", async () => {
    const root = await tempDir("build-output-");
    await mkdir(join(root, ".build/out/Products/Debug"), { recursive: true });
    await writeFile(join(root, ".build/out/Products/Debug/App"), "binary");
    await writeFile(join(root, "Package.swift"), "// swift-tools-version:5.9\n");
    const listed = (await listLiveProjectFiles(root)).map((file) => file.path);
    expect(listed).toEqual(["Package.swift"]);
  });
});
