/**
 * What a case may change. Scope is the plan's, enforced before a checkpoint:
 * a change outside it is a failed attempt, not a commit. Tool caches are
 * neither: running the checks writes `__pycache__` or `.pytest_cache`, and
 * that is not the worker straying, so they are never violations and never
 * committed.
 */
export interface AutoScope {
  /** When set, changes outside these path prefixes are a scope violation. */
  writable?: string[];
  /** Never changed by a case (for example the checks' own fixtures). */
  protectedPaths?: string[];
  /** Changes here alone do not make a checkpoint "substantive" (trackers, notes). */
  bookkeeping?: string[];
}

/** Directory names that only ever hold caches, wherever they appear. */
const CACHE_DIRECTORIES = new Set([
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".hypothesis",
  ".tox",
  ".nox",
]);

/** File names that are caches or tool state. */
const CACHE_FILES = [
  /\.py[co]$/,
  /^\.coverage(\..+)?$/,
  /^\.eslintcache$/,
  /\.tsbuildinfo$/,
  /^\.DS_Store$/,
];

/** The same set, written for `.git/info/exclude` so Git never lists them as new files. */
export const CACHE_EXCLUDE_PATTERNS = [
  ...[...CACHE_DIRECTORIES].map((name) => `${name}/`),
  "node_modules/.cache/",
  "*.py[co]",
  ".coverage",
  ".coverage.*",
  ".eslintcache",
  "*.tsbuildinfo",
  ".DS_Store",
];

export function isCachePath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  if (segments.slice(0, -1).some((segment) => CACHE_DIRECTORIES.has(segment))) return true;
  if (CACHE_DIRECTORIES.has(segments.at(-1) ?? "")) return true;
  if (segments.some((segment, i) => segment === "node_modules" && segments[i + 1] === ".cache"))
    return true;
  const name = segments.at(-1) ?? "";
  return CACHE_FILES.some((pattern) => pattern.test(name));
}

/**
 * Folders and files whose contents run on the owner's machine once the patch
 * is applied, without anyone running them on purpose: Git hook managers,
 * direnv, editor and devcontainer settings, and coding agents' settings and
 * instructions (L28).
 */
const HOST_DIRECTORIES = new Set([
  ".husky",
  ".githooks",
  ".vscode",
  ".idea",
  ".devcontainer",
  ".claude",
  ".cursor",
  ".codex",
  ".pi",
]);
const HOST_FILES = new Set([".pre-commit-config.yaml", ".envrc", "AGENTS.md", "CLAUDE.md"]);

/** Whether a path is one the owner's machine runs or obeys once the patch is applied. */
export function runsOnHost(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  return (
    segments.some((segment) => HOST_DIRECTORIES.has(segment)) ||
    HOST_FILES.has(segments.at(-1) ?? "")
  );
}

/** A writable entry that names such a path's area itself; "." or "src" does not. */
function namesHostPath(path: string, writable: string[]): boolean {
  return writable.some((raw) => {
    const prefix = raw
      .replace(/^\.\//, "")
      .replace(/(\/\*\*?)+$/, "")
      .replace(/\/+$/, "");
    return prefix !== "" && prefix !== "." && runsOnHost(prefix) && under(path, [prefix]);
  });
}

/** Whether a path is one of the prefixes, or inside one. */
export function under(path: string, prefixes: string[]): boolean {
  return prefixes.some((raw) => {
    // "src", "src/", "./src" and "src/**" all mean the folder; "." means everything.
    const prefix = raw
      .replace(/^\.\//, "")
      .replace(/(\/\*\*?)+$/, "")
      .replace(/\/+$/, "");
    return prefix === "" || prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
  });
}

/** Changed paths that count: caches and the prepared environment are left out. */
export function meaningfulChanges(changed: string[], environmentPaths: string[] = []): string[] {
  return changed.filter((path) => !isCachePath(path) && !under(path, environmentPaths));
}

/** Git lists a repository nested in the worktree as its folder with a trailing slash. */
export function isNestedRepository(path: string): boolean {
  return path.endsWith("/");
}

/**
 * The paths a case changed that it may not: protected ones, any outside what
 * it may write, any Git repository nested in the project (never committed),
 * and anything that runs on the owner's machine unless the plan names it.
 */
export function scopeViolations(
  changed: string[],
  scope: AutoScope,
  caseWritable?: string[],
): string[] {
  const writable = caseWritable?.length ? caseWritable : scope.writable;
  return changed.filter(
    (path) =>
      isNestedRepository(path) ||
      under(path, scope.protectedPaths ?? []) ||
      (runsOnHost(path) && !namesHostPath(path, writable ?? [])) ||
      (writable?.length ? !under(path, [...writable, ...(scope.bookkeeping ?? [])]) : false),
  );
}

/** Whether a checkpoint with these changes is real progress rather than notes. */
export function isSubstantive(changed: string[], scope: AutoScope): boolean {
  return changed.some((path) => !under(path, scope.bookkeeping ?? []));
}
