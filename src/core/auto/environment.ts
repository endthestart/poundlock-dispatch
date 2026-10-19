/**
 * What setup left in the run's environment folders, such as `.venv` and
 * `node_modules` (L32). Cases run without network, so none of them has a
 * reason to change those folders, and a change there could alter the test
 * runner the checks trust while staying invisible to scope. A case that
 * changes them is refused like any other scope violation.
 *
 * Only what can change which code runs is recorded: scripts and modules,
 * native libraries, package manifests, executables and links. Data a tool
 * keeps there as it works (a browser's locales, caches, lockfile records) is
 * left out; recording everything would refuse tasks over such files.
 *
 * Each entry records size, modification time, change time, inode and mode.
 * The change time cannot be set by an unprivileged process, so restoring a
 * modification time does not hide an edit, and nothing is read or hashed.
 */
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type EnvironmentManifest = Record<string, string>;

/** Past this many entries the environment is too large to check, and that is reported. */
const MAX_ENTRIES = 1_000_000;
const TOO_LARGE = "(the prepared environment is too large to check)";

/**
 * State tools keep inside `node_modules` as they run: Vitest's results, the
 * config Vite bundles into `.vite-temp` before loading it, and the package
 * managers' own records of what they installed, which npm rewrites whenever it
 * looks at the tree. None decides what code runs, so none may refuse a task.
 */
const TOOL_STATE = new Set([
  ".vite",
  ".vite-temp",
  ".vitest",
  ".cache",
  ".tmp",
  ".package-lock.json",
  ".yarn-integrity",
  ".modules.yaml",
]);

function isToolState(path: string): boolean {
  const segments = path.split("/");
  return segments.some(
    (segment, i) => segment === "node_modules" && TOOL_STATE.has(segments[i + 1] ?? ""),
  );
}

/** Files that are code or decide which code loads. */
const CODE_FILE =
  /\.(c|m)?[jt]sx?$|\.node$|\.wasm$|\.so(\.\d+)*$|\.dylib$|\.py[cod]?$|\.pth$|^package\.json$|^pyvenv\.cfg$/;

/** Whether a manifest entry is one the check compares: code, an executable or a link. */
function counts(path: string, entry: string): boolean {
  if (entry.startsWith("link:")) return true;
  if (!entry.startsWith("file:")) return false;
  const segments = path.split("/");
  if (CODE_FILE.test(segments.at(-1) ?? "")) return true;
  // Whatever sits in bin/ or .bin/ is run by name, whatever its mode.
  if (segments.slice(0, -1).some((segment) => segment === "bin" || segment === ".bin")) return true;
  const mode = Number(entry.split(":").at(-1));
  return Number.isFinite(mode) && (mode & 0o111) !== 0;
}

/** A manifest cut to the entries that count, so older records compare like new ones. */
function comparable(manifest: EnvironmentManifest): EnvironmentManifest {
  return Object.fromEntries(
    Object.entries(manifest).filter(([path, entry]) => !isToolState(path) && counts(path, entry)),
  );
}

export async function environmentManifest(
  root: string,
  paths: string[],
): Promise<EnvironmentManifest> {
  const manifest: EnvironmentManifest = {};
  let count = 0;
  const visit = async (relative: string): Promise<void> => {
    // Caches count here: cases write bytecode under /tmp, so one in the
    // environment was planted. Only test tools' own state is ignored.
    if (isToolState(relative)) return;
    if (count >= MAX_ENTRIES) {
      manifest[TOO_LARGE] = "";
      return;
    }
    const absolute = join(root, relative);
    const stat = await lstat(absolute, { bigint: true }).catch(() => undefined);
    if (!stat) return;
    count++;
    const identity = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.mode}`;
    if (stat.isSymbolicLink()) {
      manifest[relative] = `link:${await readlink(absolute).catch(() => "")}:${identity}`;
    } else if (stat.isDirectory()) {
      const entries = await readdir(absolute).catch(() => []);
      for (const entry of entries.sort()) await visit(`${relative}/${entry}`);
    } else {
      const entry = `file:${identity}`;
      if (counts(relative, entry)) manifest[relative] = entry;
    }
  };
  for (const path of [...paths].sort()) await visit(path.replace(/\/+$/, ""));
  return manifest;
}

/**
 * The topmost paths in `after` that `before` did not have: what a case added
 * inside the environment, each folder named once rather than file by file.
 */
export function environmentAdditions(
  before: EnvironmentManifest,
  after: EnvironmentManifest,
): string[] {
  if (TOO_LARGE in before || TOO_LARGE in after) return [];
  const known = comparable(before);
  const added = Object.keys(comparable(after))
    .filter((path) => !(path in known))
    .sort();
  return added.filter(
    (path) => !added.some((other) => other !== path && path.startsWith(`${other}/`)),
  );
}

/** Paths added, removed or changed since `before`, at most `limit` of them. */
export function environmentChanges(
  before: EnvironmentManifest,
  after: EnvironmentManifest,
  limit = 20,
): string[] {
  if (TOO_LARGE in before || TOO_LARGE in after) return [TOO_LARGE];
  // Both sides cut to what counts: a record saved before a path was left out
  // still lists it, and it must not read as removed.
  const was = comparable(before);
  const now = comparable(after);
  const changed = new Set<string>();
  for (const [path, entry] of Object.entries(now)) if (was[path] !== entry) changed.add(path);
  for (const path of Object.keys(was)) if (!(path in now)) changed.add(path);
  return [...changed].sort().slice(0, limit);
}

export async function saveManifest(file: string, manifest: EnvironmentManifest): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
}

export async function loadManifest(file: string): Promise<EnvironmentManifest | undefined> {
  return readFile(file, "utf8")
    .then((text) => JSON.parse(text) as EnvironmentManifest)
    .catch(() => undefined);
}
