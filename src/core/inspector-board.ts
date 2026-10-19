import { isPlaceholderText, taskIdentity } from "@shared/board-changes";
import type { ProjectStatus, TaskRecord } from "@shared/types";

/** Who is asking to change an inspector section. Runtime progress is not a proposal. */
type BoardSource = "manager" | "user" | "runtime";

/**
 * Structural vs in-place writes. Future inspector sections (checks, artifacts,
 * decisions) use the same classes; only identity and retain rules vary.
 */
type BoardKind = "replace" | "upsert" | "progress";

type BoardWrite = "publish" | "amend" | "merge" | "progress";

interface PublishedSection {
  empty: boolean;
  /** True when this section can be replaced without asking: never shown, or the current run already ended. */
  terminal: boolean;
}

/**
 * Decide whether inspector content is written, merged, or staged.
 *
 * - Empty or terminal sections publish immediately (still subject to plan approval for execution).
 * - User-initiated upserts merge into the published section (add/update in place).
 * - Manager replacements of a live section are amendments until the user consents.
 * - Progress never replaces identity.
 */
export function classifyBoardWrite(input: {
  source: BoardSource;
  kind: BoardKind;
  published: PublishedSection;
}): BoardWrite {
  if (input.kind === "progress" || input.source === "runtime") return "progress";
  if (input.published.empty || input.published.terminal) return "publish";
  if (input.source === "user" && input.kind === "upsert") return "merge";
  return "amend";
}

export function tasksSectionState(
  tasks: Array<{ status: string }>,
  projectStatus: ProjectStatus,
  runEnded = false,
): PublishedSection {
  return {
    empty: tasks.length === 0,
    terminal:
      runEnded ||
      ["cancelled", "completed"].includes(projectStatus) ||
      (tasks.length > 0 && tasks.every((task) => ["cancelled", "applied"].includes(task.status))),
  };
}

export function mergeSectionItems<T extends { id: string }>(
  published: T[],
  proposed: T[],
  identityOf: (item: T) => string,
  retain: (current: T, incoming: T) => T,
): T[] {
  const current = new Map(published.map((item) => [identityOf(item), item]));
  return proposed.map((item) => {
    const existing = current.get(identityOf(item));
    return existing ? retain(existing, item) : item;
  });
}

/** Add or update items without dropping the rest of a published section. */
export function upsertSectionItems<T extends { id: string }>(
  published: T[],
  incoming: T[],
  identityOf: (item: T) => string,
  retain: (current: T, incoming: T) => T,
): T[] {
  const next = [...published];
  for (const item of incoming) {
    const index = next.findIndex((current) => identityOf(current) === identityOf(item));
    if (index >= 0) next[index] = retain(next[index], item);
    else next.push(item);
  }
  return next;
}

/**
 * A published task as a proposal restates it: the proposal's content, the
 * task's run state, and its test flags unless the proposal sets them. A local
 * manager restating a fifteen-task board left writesTests off every test task
 * (13 Oct), which would have made their red acceptance impossible.
 */
export function retainTaskIdentity(current: TaskRecord, incoming: TaskRecord): TaskRecord {
  // A restatement that only stands in for the task's content keeps it.
  const content =
    isPlaceholderText(incoming.objective) || isPlaceholderText(incoming.acceptanceCriteria)
      ? {
          objective: current.objective,
          acceptanceCriteria: current.acceptanceCriteria,
          workerPrompt: current.workerPrompt,
          difficulty: current.difficulty,
          taskKind: current.taskKind,
        }
      : {};
  return {
    ...incoming,
    ...content,
    writesTests: incoming.writesTests ?? current.writesTests,
    changesFrozenTests: incoming.changesFrozenTests ?? current.changesFrozenTests,
    filesToTouch: incoming.filesToTouch?.length ? incoming.filesToTouch : current.filesToTouch,
    splitAdvised: current.splitAdvised,
    id: current.id,
    status: current.status,
    repairCount: current.repairCount,
    recoveryCount: current.recoveryCount,
    attempts: current.attempts,
    workerSessionKey: current.workerSessionKey,
    freshWorkerSession: current.freshWorkerSession,
    profileId: current.profileId,
    profileName: current.profileName,
    selectionReason: current.selectionReason,
    escalation: current.escalation,
  };
}

export { taskIdentity };
