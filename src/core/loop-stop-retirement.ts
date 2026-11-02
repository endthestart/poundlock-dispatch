import { categorizeStuckTask } from "@shared/stuck-task";
import type { TaskRecord } from "@shared/types";
import { nowIso } from "./ids.js";
import type { FileStore } from "./store.js";

/**
 * Before 6c0d0c5 (19 Sep), a task that used up its fix rounds or its retries
 * after interruption failed, and the run stopped with a "Repair budget
 * exhausted" or "Recovery budget exhausted" stopReason. Since then such a task
 * stays reviewable and is marked stuck, and the undecided-review pause is the
 * only stop.
 *
 * A project saved in the old dead end is rewritten to that once, when Dispatch
 * starts, so nothing else reads the old stopReason: each failed task becomes a
 * stuck one awaiting review, the stop is cleared, and a stopped run is paused
 * for the owner's decision. Attempts stay as evidence.
 */
const LEGACY_LOOP_STOP = /repair budget exhausted|recovery budget exhausted/i;

export async function retireLegacyLoopStop(
  store: FileStore,
  projectId: string,
  clock: () => Date = () => new Date(),
): Promise<void> {
  const project = await store.getProject(projectId);
  const reason = project?.budget.stopReason;
  if (!project || !reason || !LEGACY_LOOP_STOP.test(reason)) return;
  const at = nowIso(clock);
  const outcome = /recovery budget/i.test(reason) ? "recovery" : "repair";
  const tasks = await store.getTasks(projectId);
  const stuck = tasks.filter((task) => task.status === "failed");
  for (const task of stuck) {
    const sentence = stopSentence(outcome, task);
    task.stuck = {
      since: at,
      category: categorizeStuckTask(outcome, task.attempts.at(-1)?.failureClass),
      reason: sentence,
      brief: sentence,
    };
    task.status = "needs_review";
  }
  project.budget.stopReason = undefined;
  if (stuck.length && (project.status === "failed" || project.status === "paused"))
    project.pause = {
      cause: "undecided_review",
      detail: "An earlier Dispatch stopped this run when a task ran out of attempts.",
      at,
    };
  else if (project.status === "failed")
    project.pause = {
      cause: "awaiting_resume",
      detail: "An earlier Dispatch stopped this run. Resume to continue.",
      at,
    };
  if (project.status === "failed") project.status = "paused";
  if (stuck.length) await store.saveTasks(projectId, tasks);
  await store.saveProject(project);
}

/** What happened to the task, in the words the stuck-task card shows. */
function stopSentence(outcome: "repair" | "recovery", task: TaskRecord): string {
  const last = task.attempts.at(-1);
  const failedCheck = last?.result?.verification?.commands?.find(
    (command) => command.error || (command.exitCode ?? 0) !== 0,
  );
  const issue = last?.error
    ? ` The last attempt ended with: ${last.error}`
    : failedCheck
      ? ` The last check, ${failedCheck.command}, failed (exit ${failedCheck.exitCode ?? "unknown"}).`
      : "";
  const why =
    outcome === "recovery"
      ? "stopped after it was interrupted too many times."
      : "used all its fix rounds without passing review.";
  return `“${task.title}” ${why}${issue}`;
}
