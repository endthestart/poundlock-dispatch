/**
 * The Planner's acceptance tests in the worktree. A case's tests go in when it
 * starts and before each attempt, as the Planner wrote them: in the project any
 * sooner, they would fail every earlier case's checks.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { AcceptanceTest } from "@shared/types";

/** A relative path that stays in the project and out of Dispatch's own folder. */
export function insideProject(path: string): boolean {
  return (
    !!path &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").some((part) => part === ".." || part === "." || part === "") &&
    !path.startsWith(".dispatch/")
  );
}

/** The tests whose file in `root` is missing or not as the Planner wrote it. */
export async function acceptanceDrift(root: string, tests: AcceptanceTest[]): Promise<string[]> {
  const drifted: string[] = [];
  for (const test of tests) {
    const now = await readFile(join(root, test.path), "utf8").catch(() => undefined);
    if (now !== test.content) drifted.push(test.path);
  }
  return drifted;
}

/** The nearest folder of `path` that exists, resolved, must be `root` or inside it. */
async function assertInside(root: string, path: string): Promise<void> {
  const top = await realpath(root);
  let folder = dirname(join(root, path));
  for (;;) {
    const found = await realpath(folder).catch(() => undefined);
    if (found) {
      const rel = relative(top, found);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new Error(`${path} leads outside the project.`);
      return;
    }
    folder = dirname(folder);
  }
}

/**
 * Write each drifted test into `root`, except those in `free`: the Planner let
 * the case change them. Returns the paths written. Throws when a path is not
 * inside the project or ends in a link.
 */
export async function placeAcceptanceTests(
  root: string,
  tests: AcceptanceTest[],
  free: readonly string[] = [],
): Promise<string[]> {
  const drifted = new Set(await acceptanceDrift(root, tests));
  const written: string[] = [];
  for (const test of tests) {
    if (!drifted.has(test.path) || free.includes(test.path)) continue;
    if (!insideProject(test.path)) throw new Error(`${test.path} is not a path in the project.`);
    await assertInside(root, test.path);
    const full = join(root, test.path);
    if ((await lstat(full).catch(() => undefined))?.isSymbolicLink())
      throw new Error(`${test.path} is a link.`);
    await mkdir(dirname(full), { recursive: true });
    const file = await open(
      full,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await file.writeFile(test.content);
    } finally {
      await file.close();
    }
    written.push(test.path);
  }
  return written;
}
