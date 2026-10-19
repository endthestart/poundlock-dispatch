/**
 * What a board update would change, task by task, and the text that stands in
 * for content instead of stating it. Shown on the plan card so an owner
 * approving an update sees what it rewrites, not only what it removes.
 */
import type { TaskRecord } from "./types";

/** A task's title as the board matches it across revisions. */
export function taskIdentity(task: { title: string }): string {
  return task.title.trim().toLowerCase();
}

const PLACEHOLDER =
  /^(?:placeholder|tbd|todo|n\/?a|none|same|unchanged|(?:same as|as) before|\.{3}|…|-+)\.?$/i;

/**
 * True for text that stands in for a task's content. A local manager restated
 * fifteen published tasks with the objective "placeholder" to flag one of
 * them, and the board took it as their new specification (13 Oct).
 */
export function isPlaceholderText(text: string | undefined): boolean {
  const trimmed = (text ?? "").trim();
  return !trimmed || PLACEHOLDER.test(trimmed);
}

export interface TaskChange {
  title: string;
  change: "added" | "removed" | "changed";
  /** For a changed task, what differs, in words the owner reads. */
  fields: string[];
}

/** A worker brief without the repair findings Dispatch appends to it. */
function brief(prompt: string | undefined): string {
  return (prompt ?? "").split("\n\nRepair findings from review:\n")[0].trim();
}

function list(values: readonly string[] | undefined): string {
  return [...(values ?? [])].sort().join("\n");
}

/** How `next` differs from `current`, task by task, in board order. */
export function boardChanges(current: TaskRecord[], next: TaskRecord[]): TaskChange[] {
  const titles = (board: TaskRecord[]) => new Map(board.map((task) => [task.id, task.title]));
  const currentTitles = titles(current);
  const nextTitles = titles(next);
  const depends = (task: TaskRecord, names: Map<string, string>) =>
    list((task.dependsOn ?? []).map((id) => taskIdentity({ title: names.get(id) ?? id })));
  const byIdentity = new Map(current.map((task) => [taskIdentity(task), task]));
  const changes: TaskChange[] = [];
  for (const task of next) {
    const before = byIdentity.get(taskIdentity(task));
    if (!before) {
      changes.push({ title: task.title, change: "added", fields: [] });
      continue;
    }
    const fields = [
      before.objective.trim() !== task.objective.trim() && "objective",
      before.acceptanceCriteria.trim() !== task.acceptanceCriteria.trim() && "acceptance criteria",
      brief(before.workerPrompt) !== brief(task.workerPrompt) && "worker brief",
      depends(before, currentTitles) !== depends(task, nextTitles) && "dependencies",
      list(before.filesToTouch) !== list(task.filesToTouch) && "files",
      list(before.requirementIds) !== list(task.requirementIds) && "requirements served",
      Boolean(before.writesTests) !== Boolean(task.writesTests) && "writes tests",
      Boolean(before.changesFrozenTests) !== Boolean(task.changesFrozenTests) &&
        "may change frozen tests",
      before.difficulty !== task.difficulty && "size",
    ].filter((field): field is string => Boolean(field));
    if (fields.length) changes.push({ title: task.title, change: "changed", fields });
  }
  const kept = new Set(next.map(taskIdentity));
  for (const task of current)
    if (!kept.has(taskIdentity(task)))
      changes.push({ title: task.title, change: "removed", fields: [] });
  return changes;
}
