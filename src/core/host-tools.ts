import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ProjectPolicy, RuntimeCandidate, TrustedRuntimeKind } from "@shared/types";
import { isWithin } from "./file-access.js";

/**
 * Fixed host tool directories. Dispatch never inherits the user's shell PATH or
 * shell startup files; Finder-launched apps get the same tools as a terminal.
 */
export function approvedHostToolDirectories(home = homedir()): string[] {
  return [
    join(home, ".cargo/bin"),
    join(home, ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

/**
 * Where an approved host toolchain keeps its installed versions, for tools
 * whose PATH entry is only a proxy. A worker runs with a private HOME, so
 * rustup's proxies in ~/.cargo/bin looked for toolchains in that empty HOME
 * and refused to run ("no default is configured"). Read-only use: the private
 * HOME still holds every cache and download.
 */
export function hostToolchainEnvironment(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const rustup = env.RUSTUP_HOME || join(home, ".rustup");
  return existsSync(rustup) ? { RUSTUP_HOME: rustup } : {};
}

/**
 * A worker's TMPDIR: a folder of its own in this Mac's temp folder, named the
 * way a terminal names it. Inside the private home, checks saw a temp path
 * with no link in it, so a project's tests could pass under Dispatch and fail
 * in a terminal, where /var is a link to /private/var.
 */
export function workerTempDirectory(privateHome: string, base = tmpdir()): string {
  const id = createHash("sha256").update(privateHome).digest("hex").slice(0, 16);
  return join(base, "poundlock-dispatch", id);
}

/** Create a worker's TMPDIR and return its real path, which the sandbox matches on. */
export async function preparedWorkerTempDirectory(privateHome: string): Promise<string> {
  const directory = workerTempDirectory(privateHome);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return realpath(directory);
}

export function executableSearchDirectories(home = homedir()): string[] {
  return approvedHostToolDirectories(home);
}

export type { RuntimeCandidate, TrustedRuntimeKind };

const RUNTIME_EXECUTABLE: Record<TrustedRuntimeKind, string> = {
  node: process.platform === "win32" ? "node.exe" : "node",
};

/**
 * Explicitly selected runtime directories for a project, ahead of the fixed
 * host tool directories. This is how an NVM-only Node becomes available
 * without inheriting the whole shell PATH or adding a version manager.
 */
export function trustedRuntimeDirectories(policy?: Pick<ProjectPolicy, "runtimes">): string[] {
  return Object.values(policy?.runtimes ?? {}).filter(
    (directory): directory is string => typeof directory === "string" && isAbsolute(directory),
  );
}

/** Installation roots the OS sandbox must be able to read for selected runtimes. */
export function trustedRuntimeReadRoots(policy?: Pick<ProjectPolicy, "runtimes">): string[] {
  return trustedRuntimeDirectories(policy).map((directory) =>
    /[\\/]bin$/.test(directory) ? dirname(directory) : directory,
  );
}

function compareVersions(a: string, b: string): number {
  const left = a.replace(/^v/, "").split(".").map(Number);
  const right = b.replace(/^v/, "").split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (right[index] ?? 0) - (left[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

async function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

/** List NVM-installed Node runtimes, newest first, from the NVM directory in `home`. */
export async function discoverNodeRuntimes(home = homedir()): Promise<RuntimeCandidate[]> {
  const root = join(home, ".nvm", "versions", "node");
  const versions = await readdir(root).catch(() => [] as string[]);
  const found: RuntimeCandidate[] = [];
  for (const version of versions) {
    if (!/^v\d+\.\d+\.\d+$/.test(version)) continue;
    const directory = join(root, version, "bin");
    if (await executable(join(directory, RUNTIME_EXECUTABLE.node)))
      found.push({ kind: "node", directory, version, source: "nvm" });
  }
  return found.sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Validate a runtime directory the user selected. It must be an absolute,
 * existing directory with the runtime executable, and it must not live inside
 * the project or Dispatch's own data, where project code could plant it.
 * Returns the canonical directory to store.
 */
export async function validateTrustedRuntime(
  kind: TrustedRuntimeKind,
  directory: string,
  boundaries: { projectRoot?: string; dataRoot?: string } = {},
): Promise<string> {
  if (!isAbsolute(directory)) throw new Error("Choose an absolute runtime directory.");
  const canonical = await realpath(directory).catch(() => {
    throw new Error(`${directory} does not exist.`);
  });
  if (!(await stat(canonical)).isDirectory())
    throw new Error("Choose the directory that contains the runtime, not the executable.");
  if (!(await executable(join(canonical, RUNTIME_EXECUTABLE[kind]))))
    throw new Error(`${canonical} does not contain an executable ${RUNTIME_EXECUTABLE[kind]}.`);
  for (const boundary of [boundaries.projectRoot, boundaries.dataRoot]) {
    if (!boundary) continue;
    const root = await realpath(boundary).catch(() => boundary);
    if (isWithin(root, canonical))
      throw new Error("A trusted runtime cannot live inside the project or Dispatch data.");
  }
  return canonical;
}
