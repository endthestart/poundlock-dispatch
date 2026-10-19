import { constants } from "node:fs";
import { access, lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DEFAULT_EXCLUSIONS } from "@shared/types";
import ignore from "ignore";

export async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export function isWithin(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Inspect all ancestors, including ancestors of a not-yet-created destination. */
export async function canonicalDestination(root: string, requested: string): Promise<string> {
  const full = resolve(root, requested);
  let ancestor = full;
  const tail: string[] = [];
  while (true) {
    try {
      const stat = await lstat(ancestor);
      if (stat.isSymbolicLink())
        throw new Error("Symbolic link paths require an explicit approval.");
      const canonical = await realpath(ancestor);
      if (canonical !== ancestor)
        throw new Error("Symbolic link paths require an explicit approval.");
      return resolve(canonical, ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      tail.push(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}

/** The rule that excluded a path, and where it came from. */
export interface ExclusionMatch {
  kind: "gitignore" | "default" | "project";
  /** The pattern as written, for example `demo/*\/`. */
  rule: string;
  /** The `.gitignore` file it is in, or a plain-English name for a built-in or project rule. */
  source: string;
}

const DEFAULT_RULES_SOURCE = "built-in default exclusions";
const PROJECT_RULES_SOURCE = "this project's excluded patterns";

/** For error messages: `the rule "demo/*\/" in /outer/.gitignore`. */
export function describeExclusion(match: ExclusionMatch): string {
  return match.kind === "gitignore"
    ? `the rule "${match.rule}" in ${match.source}`
    : `the rule "${match.rule}" (${match.source})`;
}

/**
 * The pattern that ignored `path`. The decision comes from `ignores()`, as it
 * always has; `test()` is asked only to name the rule.
 */
function ignoredBy(matcher: ReturnType<typeof ignore>, path: string): string | undefined {
  if (!matcher.ignores(path)) return undefined;
  return matcher.test(path).rule?.pattern ?? "(unnamed rule)";
}

/**
 * Why `full` is excluded, or `undefined` when it is not.
 *
 * A path inside `projectRoot` is judged by where it sits under the root, and
 * only the `.gitignore` files from its folder up to the root apply. Nothing at
 * or above the root can exclude the project itself: an enclosing repository's
 * `.gitignore`, or a parent folder that happens to be called `build`, says
 * nothing about a project deliberately opened there. Any other path keeps its
 * whole absolute path and every ancestor `.gitignore`, so a secret is refused
 * wherever it lives.
 */
export async function exclusionMatch(
  full: string,
  extra: string[] = [],
  projectRoot?: string,
): Promise<ExclusionMatch | undefined> {
  const inRoot = projectRoot !== undefined && isWithin(projectRoot, full);
  const subject = inRoot ? relative(projectRoot, full) : full;
  const defaults = ignore().add(DEFAULT_EXCLUSIONS);
  // Check each suffix so absolute and out-of-project reads get the same defaults.
  const parts = subject.split(sep).join("/").split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const rule = ignoredBy(defaults, parts.slice(i).join("/"));
    if (rule) return { kind: "default", rule, source: DEFAULT_RULES_SOURCE };
  }
  if (inRoot) {
    const rel = relative(projectRoot, full).split(sep).join("/");
    const rule = rel ? ignoredBy(ignore().add(extra), rel) : undefined;
    if (rule) return { kind: "project", rule, source: PROJECT_RULES_SOURCE };
    // The root has no path under itself, and no rule above it applies.
    if (full === projectRoot) return undefined;
  }
  let directory = dirname(full);
  while (true) {
    const source = resolve(directory, ".gitignore");
    const rules = await readFile(source, "utf8").catch(() => "");
    const rel = relative(directory, full).split(sep).join("/");
    const rule = rules && rel ? ignoredBy(ignore().add(rules), rel) : undefined;
    if (rule) return { kind: "gitignore", rule, source };
    if (inRoot && directory === projectRoot) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

export async function excludedPath(
  full: string,
  extra: string[] = [],
  projectRoot?: string,
): Promise<boolean> {
  return (await exclusionMatch(full, extra, projectRoot)) !== undefined;
}

/**
 * `root` is the attached project folder; `extraRoots` are folders granted
 * beyond it. Exclusion and symlink-escape checks always run against the root
 * the file was actually found under, never the first one in the list — using
 * the wrong root is how a symlink out of a granted sibling would slip past.
 */
export async function authorizedReadPath(
  root: string,
  requested: string,
  grants: string[] = [],
  extra: string[] = [],
  extraRoots: string[] = [],
): Promise<string> {
  const canonicalRoot = await realpath(root);
  const full = resolve(root, requested);
  const canonical = await realpath(full);
  // Grants name the selected target, not a symlink that can later be redirected.
  const granted = grants.includes(canonical);
  if (granted) return canonical;

  // An excluded name is refused wherever it lives, before location is
  // considered, so a secret is never reported merely as "outside".
  if (await excludedPath(canonical, extra, canonicalRoot)) {
    throw new Error(
      "This file is excluded. Grant this exact file in Project settings before reading it.",
    );
  }
  const roots = [canonicalRoot, ...(await canonicalRoots(extraRoots))];
  const matched = roots.find((candidate) => isWithin(candidate, canonical));
  if (!matched) {
    throw new Error(
      "This file is outside the project. Grant this exact file, or the folder it is in, in Project settings before reading it.",
    );
  }
  // A granted folder keeps the default exclusions and its own .gitignore,
  // which excludedPath walks up to that folder rather than to the project.
  if (matched !== canonicalRoot && (await excludedPath(canonical, [], matched))) {
    throw new Error(
      "This file is excluded. Grant this exact file in Project settings before reading it.",
    );
  }
  await canonicalDestination(matched, canonical);
  return canonical;
}

/** Roots that no longer exist cannot authorize anything, so they drop out. */
export async function canonicalRoots(roots: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    const canonical = await realpath(root).catch(() => undefined);
    if (canonical) resolved.push(canonical);
  }
  return resolved;
}

export async function safeReadFile(
  root: string,
  requested: string,
  grants: string[] = [],
  extra: string[] = [],
  extraRoots: string[] = [],
): Promise<string> {
  const canonical = await authorizedReadPath(root, requested, grants, extra, extraRoots);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    // `O_NOFOLLOW` guards only the final component, so an ancestor swapped
    // between authorization and open can still redirect the descriptor. The
    // worker path has checked this since it was written
    // (`validateOpenedProjectFile`); the manager path, which may be an
    // off-box frontier model, never did.
    const [stat, current] = await Promise.all([handle.stat(), lstat(canonical)]);
    if (!stat.isFile() || !current.isFile())
      throw new Error("Read a regular file, not a directory.");
    if (stat.dev !== current.dev || stat.ino !== current.ino)
      throw new Error("The file changed while it was being opened.");
    if (stat.size > 256_000)
      throw new Error("This file is too large for one read. Choose a smaller source file.");
    return (await handle.readFile("utf8")).slice(0, 24_000);
  } finally {
    await handle.close();
  }
}
