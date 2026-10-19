/**
 * Soft task sizing. The manager manages: it breaks work into tasks it can name
 * the files of, instead of handing a worker a large job. Nothing here rejects a
 * plan; oversized tasks get a note back to the manager when proposed, and a
 * split suggestion once if they fail. See releases/0.2.2/MANAGED-WORK-SPEC.md
 * in the planning repository for the evidence behind the numbers.
 */

/** Files with new logic one task may change before it gets a note. Loose on purpose. */
export const SOFT_LOGIC_FILE_LIMIT = 5;

interface SizedTask {
  title: string;
  difficulty: string;
  taskKind?: string;
  route?: string;
  filesToTouch?: string[];
  acceptanceCriteria?: string;
}

/** A criterion about an artifact rather than what a user can do. */
const ARTIFACT =
  /\b(exists?|is created|(swift|cargo|npm|go) (build|check|test)|builds?|compiles?|\d+\+? (tests?|test cases|cases)|tests? (pass|passes|succeed)|does not crash|no crash|is (modified|unchanged)|links?)\b/i;

/**
 * True when every clause of a task's acceptance criteria names a file, a
 * build, a test count or "does not crash". Work accepted on criteria like
 * "Package.swift exists" and "5+ test cases" can still have swapped keys and
 * dialogs that never close.
 */
export function artifactOnlyCriteria(criteria: string | undefined): boolean {
  const clauses = (criteria ?? "")
    .split(/[;\n]|\.\s|,\s(?=[A-Z])/)
    .map((clause) => clause.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter((clause) => clause.length > 3);
  return clauses.length > 0 && clauses.every((clause) => ARTIFACT.test(clause));
}

/** Test files and fixtures do not count toward the limit. */
export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec|fixtures?)\//i.test(path) ||
    /(^|\/)test_[^/]*$|_test\.[a-z0-9]+$|\.(test|spec)\.[a-z0-9]+$/i.test(path)
  );
}

function isImplementation(task: SizedTask): boolean {
  // Investigations, plans and snippets are not implementation work.
  return task.route !== "snippet" && (!task.taskKind || task.taskKind === "closed_implementation");
}

/** Why a task is too big for one worker attempt, or undefined when it is not. */
export function oversizeReason(task: SizedTask): string | undefined {
  if (!isImplementation(task)) return undefined;
  const files = (task.filesToTouch ?? []).filter((path) => !isTestPath(path));
  if (task.difficulty === "large") return "is marked large";
  if (files.length > SOFT_LOGIC_FILE_LIMIT)
    return `names ${files.length} files with new logic (the guide is ${SOFT_LOGIC_FILE_LIMIT})`;
  return undefined;
}

/** What to tell the manager about a proposed task: oversized, unnamed files, or criteria about artifacts. */
function proposalNote(task: SizedTask): string | undefined {
  const notes = [
    oversizeReason(task) ??
      (isImplementation(task) && !task.filesToTouch?.length
        ? "names no files in filesToTouch"
        : undefined),
    isImplementation(task) && artifactOnlyCriteria(task.acceptanceCriteria)
      ? "has acceptance criteria about files, builds or test counts, not what a user can do and see"
      : undefined,
  ].filter(Boolean);
  return notes.length ? notes.join(" and ") : undefined;
}

/** A note for the manager's tool result, or an empty string when every task fits. */
export function taskSizeNotes(tasks: SizedTask[]): string {
  const notes = tasks
    .map((task) => ({ task, reason: proposalNote(task) }))
    .filter((item) => item.reason)
    .map((item) => `“${item.task.title}” ${item.reason}`);
  if (!notes.length) return "";
  return `\n\nPlan note (not blocking): ${notes.join("; ")}. A worker does best with a task it can finish in one attempt: name its files, keep it to about ${SOFT_LOGIC_FILE_LIMIT} files of new logic (tests and trivial edits aside), and split anything larger. If one of these fails, split it before repairing. Write criteria as what a user does and sees when it works.`;
}
