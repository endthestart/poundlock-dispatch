/**
 * Folders beyond the attached one that a project may read, or write.
 *
 * ADR 007 made a project *a* path, which is right for the common case and
 * wrong for the real one: a manager coordinating `poundlock-dispatch` usually
 * needs `poundlock-dispatch-cli` too, and work on one service often needs
 * read-only sight of reference code it must not touch. The alternative — an
 * artificial umbrella directory — makes the tool shape the repository layout,
 * which is backwards.
 *
 * This is deliberately *not* `ProjectPolicy.readGrants`. A read grant names one
 * exact file and bypasses the exclusion filter to reach it; a root is a
 * directory the ordinary rules still apply inside, so `.env`, `.git` and keys
 * stay unreadable there just as they are in the attached folder.
 */
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { type AccessRoot, FOLDER_CHOICE, type ProjectRecord } from "@shared/types";
import { isWithin } from "./file-access.js";

/** More than this and the per-root deny expansion stops being cheap. */
const MAX_ACCESS_ROOTS = 8;

function isAncestorOf(candidate: string, path: string): boolean {
  return candidate !== path && isWithin(candidate, path);
}

/**
 * Reject a grant that would widen access far past what was meant, and
 * canonicalize the rest. Every check is about the path the user chose, not
 * about what is inside it — `$HOME` is refused because granting it grants
 * every project and every credential on the machine at once.
 */
export async function normalizeAccessRoot(
  requested: string,
  context: { projectRoot: string; dataRoot: string },
): Promise<string> {
  const canonical = await realpath(resolve(requested)).catch(() => {
    throw new Error(`There is no folder at ${requested}.`);
  });
  if (!(await stat(canonical)).isDirectory())
    throw new Error("Grant a folder. One exact file is a read grant instead.");
  if (canonical === sep || canonical === homedir())
    throw new Error("Granting the whole home directory or the filesystem root is not allowed.");
  if (isAncestorOf(canonical, homedir()))
    throw new Error("That folder contains your home directory.");
  if (canonical === context.dataRoot || isAncestorOf(canonical, context.dataRoot))
    throw new Error("That folder contains Poundlock Dispatch's own data.");
  if (isAncestorOf(canonical, context.projectRoot))
    throw new Error(
      "That folder contains this project. Granting it would silently widen the whole tree.",
    );
  if (isWithin(context.projectRoot, canonical))
    throw new Error("That folder is already inside this project.");
  return canonical;
}

/**
 * The effective root list: write implies read, an overlapping pair collapses
 * to the most permissive, and the attached folder is never listed because it
 * is always writable.
 */
export function effectiveAccessRoots(roots: AccessRoot[] | undefined): AccessRoot[] {
  const byPath = new Map<string, AccessRoot>();
  for (const root of roots ?? []) {
    const existing = byPath.get(root.path);
    if (!existing || (existing.mode === "read" && root.mode === "write"))
      byPath.set(root.path, root);
  }
  const sorted = [...byPath.values()].sort((a, b) => a.path.length - b.path.length);
  const kept: AccessRoot[] = [];
  for (const root of sorted) {
    const covering = kept.find((other) => isWithin(other.path, root.path));
    // A root inside a granted root adds nothing unless it widens the mode.
    if (covering && (covering.mode === "write" || root.mode === "read")) continue;
    kept.push(root);
  }
  return kept;
}

export function readRootsFor(project: ProjectRecord): string[] {
  return effectiveAccessRoots(project.policy.roots).map((root) => root.path);
}

export function writeRootsFor(project: ProjectRecord): string[] {
  return effectiveAccessRoots(project.policy.roots)
    .filter((root) => root.mode === "write")
    .map((root) => root.path);
}

/**
 * Add a root to a project's policy, or widen one it already has. Returns the
 * new list; the caller saves it, so a refusal never half-applies.
 */
export async function grantAccessRoot(
  project: ProjectRecord,
  requested: string,
  mode: AccessRoot["mode"],
  context: {
    projectRoot: string;
    dataRoot: string;
    now?: () => Date;
    grantedBy?: AccessRoot["grantedBy"];
  },
): Promise<AccessRoot[]> {
  const path = await normalizeAccessRoot(requested, context);
  const existing = (project.policy.roots ?? []).filter((root) => root.path !== path);
  if (existing.length >= MAX_ACCESS_ROOTS)
    throw new Error(`A project may use at most ${MAX_ACCESS_ROOTS} extra folders.`);
  return [
    ...existing,
    {
      path,
      mode,
      addedAt: (context.now?.() ?? new Date()).toISOString(),
      grantedBy: context.grantedBy ?? "config",
    },
  ];
}

/**
 * The roots after the owner answered a manager's folder request with
 * `choiceId`, or `undefined` when nothing changes (a refusal, or no request).
 * The path is checked again here: the folder may have moved since it was asked for.
 */
export async function rootsForFolderChoice(
  project: ProjectRecord,
  choiceId: string,
  context: { projectRoot: string; dataRoot: string; now?: () => Date },
): Promise<AccessRoot[] | undefined> {
  const folder =
    project.needsInput?.kind === "folder_access" ? project.needsInput.folder : undefined;
  if (!folder) return undefined;
  const mode =
    choiceId === FOLDER_CHOICE.write && folder.mode === "write"
      ? "write"
      : choiceId === FOLDER_CHOICE.read
        ? "read"
        : undefined;
  if (!mode) return undefined;
  return grantAccessRoot(project, folder.path, mode, { ...context, grantedBy: "approval" });
}
