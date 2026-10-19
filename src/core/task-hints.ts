import type { TaskRecord } from "@shared/types";

/**
 * What the manager already knows about a task and can hand its worker, so the
 * worker does not search the code for it: background (`contextNote`), the
 * files the task should change (`filesToTouch`) and existing code to use
 * (`reuse`). All three are optional; a plan stored before they existed carries
 * none and produces exactly the brief it always did.
 */
export const MAX_CONTEXT_NOTE_CHARS = 2_000;
export const MAX_FILES_TO_TOUCH = 20;
export const MAX_FILE_HINT_CHARS = 200;
export const MAX_REUSE_HINTS = 12;
export const MAX_REUSE_HINT_CHARS = 300;

export interface TaskHintIssue {
  field: "filesToTouch" | "reuse";
  reason: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function entryIssue(field: TaskHintIssue["field"], value: unknown, limit: number) {
  if (typeof value !== "string" || !value.trim())
    return `every ${field} entry must be a non-empty string.`;
  if (value.trim().length > limit)
    return `a ${field} entry is longer than ${limit} characters; shorten it.`;
  if (CONTROL_CHARACTERS.test(value)) return `a ${field} entry contains a control character.`;
  return undefined;
}

/** A project-relative path or glob: never absolute, never leaving the project. */
function pathIssue(value: string): string | undefined {
  const path = value.trim();
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path))
    return `filesToTouch entry "${path}" must be relative to the project folder.`;
  if (path.split(/[\\/]/).includes(".."))
    return `filesToTouch entry "${path}" must stay inside the project folder.`;
  return undefined;
}

/**
 * The first reason a task's `filesToTouch` or `reuse` is unusable, or
 * `undefined`. The one statement of these rules: the plan compiler enforces it
 * and the manager's plan correction quotes it.
 */
export function taskHintIssue(task: {
  filesToTouch?: unknown;
  reuse?: unknown;
}): TaskHintIssue | undefined {
  const lists: Array<[TaskHintIssue["field"], number, number]> = [
    ["filesToTouch", MAX_FILES_TO_TOUCH, MAX_FILE_HINT_CHARS],
    ["reuse", MAX_REUSE_HINTS, MAX_REUSE_HINT_CHARS],
  ];
  for (const [field, maxEntries, maxChars] of lists) {
    const value = task[field];
    if (value === undefined) continue;
    if (!Array.isArray(value))
      return { field, reason: `${field} must be a JSON array of strings.` };
    if (value.length > maxEntries)
      return { field, reason: `${field} has ${value.length} entries; list at most ${maxEntries}.` };
    for (const entry of value) {
      const reason =
        entryIssue(field, entry, maxChars) ??
        (field === "filesToTouch" ? pathIssue(entry as string) : undefined);
      if (reason) return { field, reason };
    }
  }
  return undefined;
}

/**
 * The validated, trimmed, de-duplicated `filesToTouch` and `reuse` of a
 * proposed task, with an absent or empty list left out. Throws with the
 * reason when a list is unusable, so an invalid plan is refused whole and the
 * manager corrects it.
 */
export function compileTaskHints(task: {
  title: string;
  filesToTouch?: readonly string[];
  reuse?: readonly string[];
}): { filesToTouch?: string[]; reuse?: string[] } {
  const issue = taskHintIssue(task);
  if (issue) throw new Error(`Task “${task.title}”: ${issue.reason}`);
  const clean = (value: readonly string[] | undefined) => {
    const entries = [...new Set((value ?? []).map((entry) => entry.trim()))];
    return entries.length ? entries : undefined;
  };
  const filesToTouch = clean(task.filesToTouch);
  const reuse = clean(task.reuse);
  return { ...(filesToTouch ? { filesToTouch } : {}), ...(reuse ? { reuse } : {}) };
}

/** `text` cut to `limit` characters, saying so when it was. */
export function boundedNote(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit).trimEnd()}\n[note truncated: first ${limit.toLocaleString("en-US")} of ${trimmed.length.toLocaleString("en-US")} characters]`;
}

/** The hint fields as the worker's JSON brief carries them; absent ones are left out. */
export function workerHintFields(
  task: Pick<TaskRecord, "contextNote" | "filesToTouch" | "reuse">,
): {
  contextFromManager?: string;
  filesToTouch?: string[];
  reuseExistingCode?: string[];
} {
  const note = boundedNote(task.contextNote ?? "", MAX_CONTEXT_NOTE_CHARS);
  return {
    ...(note ? { contextFromManager: note } : {}),
    ...(task.filesToTouch?.length ? { filesToTouch: task.filesToTouch } : {}),
    ...(task.reuse?.length ? { reuseExistingCode: task.reuse } : {}),
  };
}
