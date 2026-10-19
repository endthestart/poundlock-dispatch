import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { readRootsFor, writeRootsFor } from "@core/access-roots";
import { isWithin } from "@core/file-access";
import { preparedWorkerTempDirectory, trustedRuntimeReadRoots } from "@core/host-tools";
import { SECRET_PATHS } from "@shared/secret-paths";
import type { ProjectRecord } from "@shared/types";
import { DEFAULT_EXCLUSIONS } from "@shared/types";
import ignore from "ignore";
import type { NetworkMode } from "./run-command.js";
import type { SandboxRequest } from "./sandbox.js";

export const SENSITIVE_EXCLUSIONS = [".git/", "**/.git/**", ...SECRET_PATHS];

const SECRET_NAMES = [
  ".env",
  ".env.local",
  ".env.production",
  ".git",
  "auth.json",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  ".ssh",
  "secrets",
  ".git-credentials",
  ".netrc",
  "_netrc",
  ".kube",
  ".docker",
  ".envrc",
  ".vault-token",
];

function concreteDeniedProjectPaths(
  projectRoot: string,
  extra: string[] = [],
  protectedPaths: string[] = [],
): string[] {
  const paths = [
    ...SECRET_NAMES.map((name) => join(projectRoot, name)),
    ...protectedPaths.map((path) => resolve(projectRoot, path)),
    ...extra
      .filter(
        (pattern) =>
          pattern && !pattern.startsWith("!") && !pattern.includes("*") && !pattern.includes("?"),
      )
      .map((pattern) => resolve(projectRoot, pattern.replace(/\/$/, ""))),
  ];
  return [...new Set(paths)];
}

/**
 * Turn security-sensitive exclusions into concrete sandbox denies immediately
 * before a process starts. Generated/dependency directories are skipped during
 * this walk because commands must be able to use them and model-facing file
 * tools already exclude them. Project symlinks are denied with their targets.
 */
async function expandedDeniedProjectPaths(
  projectRoot: string,
  extra: string[] = [],
): Promise<string[]> {
  const root = await realpath(projectRoot);
  const matcher = ignore().add(extra);
  const traversalSkip = ignore().add(DEFAULT_EXCLUSIONS);
  const denied = new Set<string>();

  async function walk(directory: string): Promise<void> {
    // A directory this process cannot list is not an empty directory. Treating
    // it as one produced no denies while leaving the subtree readable to the
    // sandboxed command — failing in the one direction a deny list must not.
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      denied.add(directory);
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const rel = relative(root, full).split(sep).join("/");
      if (!rel) continue;
      if (entry.isSymbolicLink()) {
        denied.add(full);
        const target = await realpath(full).catch(() => undefined);
        if (target) denied.add(target);
        continue;
      }
      const matchPath = entry.isDirectory() ? `${rel}/` : rel;
      if (matcher.ignores(matchPath)) {
        denied.add(full);
        continue;
      }
      if (entry.isDirectory() && traversalSkip.ignores(matchPath)) continue;
      if (entry.isDirectory()) await walk(full);
      else {
        const stat = await lstat(full).catch(() => undefined);
        if (stat?.isSymbolicLink()) denied.add(full);
      }
    }
  }

  await walk(root);
  return [...denied];
}

export function credentialDenyPaths(): string[] {
  const home = process.env.HOME ?? homedir();
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".npmrc"),
    join(home, ".pypirc"),
    join(home, ".git-credentials"),
    join(home, ".netrc"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".vault-token"),
    join(home, ".config", "gcloud"),
  ];
}

export function sandboxWritablePaths(input: {
  projectRoot: string;
  privateHome: string;
  virtualenv?: string;
  writeRoots?: string[];
}): string[] {
  const writable = [input.projectRoot, input.privateHome, ...(input.writeRoots ?? [])];
  if (input.virtualenv) writable.push(input.virtualenv);
  return [...new Set(writable)];
}

export async function buildSandboxRequest(input: {
  projectRoot: string;
  cwd?: string;
  project: ProjectRecord;
  privateHome: string;
  network: NetworkMode;
  virtualenv?: string;
}): Promise<SandboxRequest> {
  const excluded =
    input.project.source.kind === "local_folder" ? input.project.source.excludedPatterns : [];
  const projectSpecific = excluded.filter(
    (pattern) => !(DEFAULT_EXCLUSIONS as readonly string[]).includes(pattern),
  );
  const sandboxExclusions = [
    ...SENSITIVE_EXCLUSIONS,
    ...projectSpecific,
    ...input.project.policy.verification.protectedPaths,
  ];
  const virtualenv = input.virtualenv ? resolve(input.virtualenv) : undefined;
  const writeRoots = writeRootsFor(input.project);
  const readRoots = readRootsFor(input.project);
  // Every root gets its own deny expansion. Doing this only for the attached
  // project would leave .env, .git and keys readable inside a granted folder,
  // which is the whole reason a granted folder is not simply "allowed".
  const denied: string[] = [...credentialDenyPaths()];
  for (const root of [input.projectRoot, ...readRoots]) {
    const forRoot = root === input.projectRoot ? sandboxExclusions : SENSITIVE_EXCLUSIONS;
    denied.push(
      ...concreteDeniedProjectPaths(
        root,
        forRoot,
        root === input.projectRoot ? input.project.policy.verification.protectedPaths : [],
      ),
      ...(await expandedDeniedProjectPaths(root, forRoot)),
    );
  }
  // Project environments are explicitly selected by the environment adapter and
  // must remain readable and writable even though they are omitted from model
  // context and source snapshots.
  const deniedRead = denied.filter((path) => !virtualenv || !isWithin(virtualenv, path));
  const readable = [...trustedRuntimeReadRoots(input.project.policy), ...readRoots];
  return {
    projectRoot: input.projectRoot,
    writable: sandboxWritablePaths({ ...input, writeRoots }),
    deniedRead: [...new Set(deniedRead)],
    ...(readable.length ? { readable: [...new Set(readable)] } : {}),
    network: input.network,
    tmp: input.privateHome,
    temp: await preparedWorkerTempDirectory(input.privateHome),
  };
}
