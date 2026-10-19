/**
 * Folders granted beyond the attached one.
 *
 * The danger is not that a grant fails to work — it is that a grant works too
 * well: a read root becoming writable, a symlink walking out of a granted
 * folder, or `.env` and `.git` inside a sibling repo becoming readable because
 * the deny expansion only ever ran for the attached project.
 */
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  effectiveAccessRoots,
  grantAccessRoot,
  normalizeAccessRoot,
  rootsForFolderChoice,
} from "@core/access-roots";
import { safeReadFile } from "@core/file-access";
import { resolveToolPath } from "@runtime/path-policy";
import { buildSandboxRequest, sandboxWritablePaths } from "@runtime/sandbox-policy";
import type { AccessRoot, ProjectRecord } from "@shared/types";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

let projectRoot: string;
let sibling: string;
let dataRoot: string;

beforeEach(async () => {
  const base = await realpath(await tempDir("dispatch-roots-"));
  projectRoot = join(base, "project");
  sibling = join(base, "sibling");
  // Kept outside `base` so a refusal about the parent folder is not also a
  // refusal about the data directory; each check is exercised on its own.
  dataRoot = await realpath(await tempDir("dispatch-roots-data-"));
  for (const dir of [projectRoot, sibling]) await mkdir(dir, { recursive: true });
  await writeFile(join(projectRoot, "main.py"), "print('hi')\n");
  await writeFile(join(sibling, "reference.py"), "def helper(): pass\n");
  await writeFile(join(sibling, ".env"), "SIBLING_SECRET=1\n");
});

function project(roots: AccessRoot[] = []): ProjectRecord {
  return {
    id: "proj-1",
    name: "demo",
    policy: { readGrants: [], roots, verification: { commands: [], protectedPaths: [] } },
    source: { kind: "local_folder", originalPath: projectRoot, excludedPatterns: [] },
  } as unknown as ProjectRecord;
}

function root(path: string, mode: AccessRoot["mode"]): AccessRoot {
  return { path, mode, addedAt: "2026-01-01T00:00:00.000Z", grantedBy: "config" };
}

describe("granting a folder", () => {
  it("refuses folders that would widen access far past what was meant", async () => {
    const context = { projectRoot, dataRoot };
    await expect(normalizeAccessRoot(homedir(), context)).rejects.toThrow(/home directory/);
    await expect(normalizeAccessRoot("/", context)).rejects.toThrow(/filesystem root/);
    await expect(normalizeAccessRoot(dataRoot, context)).rejects.toThrow(/own data/);
    await expect(normalizeAccessRoot(join(projectRoot, ".."), context)).rejects.toThrow(
      /contains this project/,
    );
    await expect(normalizeAccessRoot(projectRoot, context)).rejects.toThrow(/already inside/);
    await expect(normalizeAccessRoot(join(sibling, "reference.py"), context)).rejects.toThrow(
      /Grant a folder/,
    );
    await expect(normalizeAccessRoot(join(sibling, "nope"), context)).rejects.toThrow(
      /no folder at/,
    );
  });

  it("accepts a sibling and records it canonically", async () => {
    const roots = await grantAccessRoot(project(), join(sibling, "."), "read", {
      projectRoot,
      dataRoot,
    });
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ path: sibling, mode: "read", grantedBy: "config" });
  });

  it("collapses overlapping grants to the most permissive", () => {
    const nested = join(sibling, "inner");
    expect(effectiveAccessRoots([root(sibling, "read"), root(sibling, "write")])).toEqual([
      root(sibling, "write"),
    ]);
    // A folder inside a granted folder adds nothing unless it widens the mode.
    expect(effectiveAccessRoots([root(sibling, "write"), root(nested, "read")])).toEqual([
      root(sibling, "write"),
    ]);
    expect(
      effectiveAccessRoots([root(sibling, "read"), root(nested, "write")]).map((r) => r.mode),
    ).toEqual(["read", "write"]);
  });
});

describe("reading a granted folder", () => {
  it("reads a file in a read root", async () => {
    const text = await safeReadFile(projectRoot, join(sibling, "reference.py"), [], [], [sibling]);
    expect(text).toContain("helper");
  });

  it("still refuses a secret inside it", async () => {
    await expect(
      safeReadFile(projectRoot, join(sibling, ".env"), [], [], [sibling]),
    ).rejects.toThrow(/excluded/);
  });

  it("refuses a file outside every granted folder", async () => {
    const elsewhere = await tempDir("dispatch-elsewhere-");
    await writeFile(join(elsewhere, "notes.txt"), "not yours");
    await expect(
      safeReadFile(projectRoot, join(elsewhere, "notes.txt"), [], [], [sibling]),
    ).rejects.toThrow(/outside the project/);
  });

  it("refuses a symlink that walks out of a granted folder", async () => {
    const elsewhere = await realpath(await tempDir("dispatch-escape-"));
    await writeFile(join(elsewhere, "target.txt"), "escaped");
    await symlink(join(elsewhere, "target.txt"), join(sibling, "link.txt"));
    await expect(
      safeReadFile(projectRoot, join(sibling, "link.txt"), [], [], [sibling]),
    ).rejects.toThrow(/outside the project/);
  });
});

describe("writing a granted folder", () => {
  const write = (record: ProjectRecord, path: string) =>
    resolveToolPath({ projectRoot, cwd: projectRoot, project: record, writing: true }, path);

  it("writes into a write root", async () => {
    const resolved = await write(project([root(sibling, "write")]), join(sibling, "new.py"));
    expect(resolved).toBe(join(sibling, "new.py"));
  });

  it("refuses to write into a read root", async () => {
    await expect(write(project([root(sibling, "read")]), join(sibling, "new.py"))).rejects.toThrow(
      /outside the attached project/,
    );
  });

  it("refuses to write an excluded path inside a write root", async () => {
    await expect(write(project([root(sibling, "write")]), join(sibling, ".env"))).rejects.toThrow(
      /ignored or excluded/,
    );
  });

  it("refuses a write through a symlink out of a write root", async () => {
    const elsewhere = await realpath(await tempDir("dispatch-wescape-"));
    await symlink(elsewhere, join(sibling, "out"));
    await expect(
      write(project([root(sibling, "write")]), join(sibling, "out", "evil.py")),
    ).rejects.toThrow();
  });
});

describe("the sandbox around granted folders", () => {
  it("makes write roots writable and read roots readable only", async () => {
    const record = project([root(sibling, "read")]);
    const request = await buildSandboxRequest({
      projectRoot,
      project: record,
      privateHome: join(dataRoot, "home"),
      network: "deny",
    });
    expect(request.writable).toContain(projectRoot);
    expect(request.writable).not.toContain(sibling);
    expect(request.readable).toContain(sibling);

    const writable = await buildSandboxRequest({
      projectRoot,
      project: project([root(sibling, "write")]),
      privateHome: join(dataRoot, "home"),
      network: "deny",
    });
    expect(writable.writable).toContain(sibling);
  });

  it("denies secrets inside a granted folder, not only inside the project", async () => {
    await mkdir(join(sibling, ".git"), { recursive: true });
    const request = await buildSandboxRequest({
      projectRoot,
      project: project([root(sibling, "read")]),
      privateHome: join(dataRoot, "home"),
      network: "deny",
    });
    // Without a per-root expansion these would be readable inside the sandbox.
    expect(request.deniedRead).toContain(join(sibling, ".env"));
    expect(request.deniedRead).toContain(join(sibling, ".git"));
  });

  it("lists every write root as writable", () => {
    expect(
      sandboxWritablePaths({
        projectRoot,
        privateHome: "/tmp/home",
        writeRoots: [sibling],
      }),
    ).toEqual([projectRoot, "/tmp/home", sibling]);
  });
});

describe("a folder the manager asked for", () => {
  function asked(mode: "read" | "write"): ProjectRecord {
    return {
      ...project(),
      needsInput: {
        question: "May this project read it?",
        askedAt: "t",
        kind: "folder_access",
        folder: { path: sibling, mode, reason: "Reuse the helper." },
      },
    };
  }
  const context = () => ({ projectRoot, dataRoot });

  it("is granted only in the mode the owner chose, marked as allowed on a card", async () => {
    expect(await rootsForFolderChoice(asked("write"), "folder:read", context())).toEqual([
      expect.objectContaining({ path: sibling, mode: "read", grantedBy: "approval" }),
    ]);
    expect(await rootsForFolderChoice(asked("write"), "folder:write", context())).toEqual([
      expect.objectContaining({ path: sibling, mode: "write", grantedBy: "approval" }),
    ]);
  });

  it("never widens a read request to write, and a refusal changes nothing", async () => {
    expect(await rootsForFolderChoice(asked("read"), "folder:write", context())).toBeUndefined();
    expect(await rootsForFolderChoice(asked("write"), "folder:deny", context())).toBeUndefined();
    expect(await rootsForFolderChoice(project(), "folder:read", context())).toBeUndefined();
  });
});
