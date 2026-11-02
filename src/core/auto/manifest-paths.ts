import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** The marker on a violation for a dependency a fresh checkout would not have. */
export const UNSHIPPED_DEPENDENCY = "(depends on a path outside what Git keeps)";

/** The local paths a manifest's dependencies point at, as written in it. */
function dependencyPaths(name: string, text: string): string[] {
  if (name === "package.json") {
    const manifest = JSON.parse(text) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
      .flatMap((field) => Object.values((manifest[field] ?? {}) as Record<string, unknown>))
      .filter((spec): spec is string => typeof spec === "string")
      .flatMap((spec) => /^(?:file|link):(.+)$/.exec(spec)?.[1] ?? []);
  }
  return [...text.matchAll(/\bpath\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

/**
 * Changed manifests whose dependencies point at a path a fresh checkout would not
 * have: outside the project, or a folder Git ignores. An offline worker pointed
 * Cargo at crates in the run's own cache (`.cargo-home`), so the product built in
 * the run and nowhere else.
 */
export async function unshippedDependencies(
  worktree: string,
  changed: string[],
  isIgnored: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const found: string[] = [];
  for (const path of changed) {
    const name = basename(path);
    if (!["Cargo.toml", "package.json", "pyproject.toml"].includes(name)) continue;
    const text = await readFile(join(worktree, path), "utf8").catch(() => undefined);
    if (text === undefined) continue;
    let targets: string[];
    try {
      targets = dependencyPaths(name, text);
    } catch {
      continue;
    }
    for (const target of targets) {
      const inProject = relative(worktree, resolve(worktree, dirname(path), target));
      if (inProject === ".." || inProject.startsWith(`..${sep}`) || (await isIgnored(inProject)))
        found.push(`${path}: ${target} ${UNSHIPPED_DEPENDENCY}`);
    }
  }
  return found;
}
