import { dirname, relative, resolve } from "node:path";
import { readRootsFor, writeRootsFor } from "@core/access-roots";
import {
  authorizedReadPath,
  canonicalDestination,
  canonicalRoots,
  excludedPath,
  isWithin,
} from "@core/file-access";
import type { ProjectRecord } from "@shared/types";

export const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
export const MUTATING_FILE_TOOLS = new Set(["write", "edit"]);

interface PathPolicyContext {
  projectRoot: string;
  cwd: string;
  project: ProjectRecord;
  writing: boolean;
  /** Frozen test files, project-relative: readable, never writable. */
  frozenPaths?: string[];
}

export async function resolveToolPath(
  ctx: PathPolicyContext,
  requested: string | undefined,
): Promise<string> {
  const target = requested && requested.trim() ? requested : ".";
  const excluded =
    ctx.project.source.kind === "local_folder" ? ctx.project.source.excludedPatterns : [];
  if (ctx.writing) {
    const full = resolve(ctx.cwd, target);
    // Writable roots are checked one at a time, and the symlink-escape check
    // runs against whichever root actually contains the path. Checking it
    // against the wrong root is how a link out of a granted folder would pass.
    const roots = [ctx.projectRoot, ...(await canonicalRoots(writeRootsFor(ctx.project)))];
    for (const root of roots) {
      if (!isWithin(root, full)) continue;
      const parent = dirname(full);
      await canonicalDestination(root, parent === root ? "." : parent);
      const canonical = await canonicalDestination(root, full);
      if (!isWithin(root, canonical)) continue;
      if (await excludedPath(canonical, root === ctx.projectRoot ? excluded : [], root))
        throw new Error("This path is ignored or excluded.");
      if (root === ctx.projectRoot && ctx.frozenPaths?.includes(relative(root, canonical)))
        throw new Error(
          "This file holds frozen tests, accepted before the implementation: read and run them, but do not change them. If the code they call does not exist yet, create it in the source files.",
        );
      return canonical;
    }
    throw new Error("That path is outside the attached project.");
  }
  return authorizedReadPath(
    ctx.projectRoot,
    target,
    ctx.project.policy.readGrants,
    excluded,
    readRootsFor(ctx.project),
  );
}
