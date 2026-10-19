import type { EscalationSettings } from "@shared/escalation";
import type { RoleBinding, RoleMap } from "@shared/roles";
import type { ChatMessage, ProjectRecord, TaskRecord } from "@shared/types";
import { nowIso } from "./ids.js";
import type { FileStore } from "./store.js";

/**
 * Older versions of Dispatch ran tasks as Poundlock jobs on their own: a task
 * routed "durable", a source upload, a job followed to its result, and that
 * result applied to the review workspace and copied back into the folder.
 * Durable jobs are for manual use now (ADR 016, `dispatch jobs`), so none of
 * that runs any more.
 *
 * A project saved by the older code is brought up to date here, when Dispatch
 * starts. Nothing is deleted that is still evidence: attempts and their results
 * stay as history. What goes is what would otherwise block the run:
 * - a durable task becomes an interactive one, and an unfinished one is ready to run again;
 * - an attempt waiting on a job is closed, since jobs are no longer followed;
 * - the job bookkeeping on the project, a standing unattended grant, and any question about
 *   jobs are dropped;
 * - a result that was never copied into the folder is named once, in the conversation.
 */

/** The id of the conversation notice, so it is posted once per conversation. */
export const DURABLE_NOTICE_ID = "notice-durable-results";

/** What an older Dispatch wrote on the project and this one no longer reads. */
interface LegacyProject {
  durableControllerUrl?: string;
  durableConsentRevision?: number;
  /** The walk-away grant, which pre-approved a job upload; nothing reads it any more. */
  unattended?: unknown;
  integration: {
    appliedOriginalRevision?: string;
    combinedJobId?: string;
    combinedRequest?: unknown;
    combinedCancellationPending?: boolean;
  };
}

const LEGACY_FIELDS = ["durableControllerUrl", "durableConsentRevision", "unattended"] as const;
const LEGACY_INTEGRATION_FIELDS = [
  "combinedJobId",
  "combinedRequest",
  "combinedCancellationPending",
] as const;

/** Attempt states that wait on a job; a job is no longer followed to its end. */
const WAITING_ON_JOB = new Set(["pending_submit", "submitted", "running", "paused", "uncertain"]);

/** Task states that were waiting for a job's result or review of it. */
const IN_JOB_FLOW = new Set<TaskRecord["status"]>([
  "queued",
  "running",
  "repairing",
  "needs_review",
]);

function isFinished(task: TaskRecord): boolean {
  return task.status === "applied" || task.status === "cancelled";
}

/**
 * Whether job results were applied to the review workspace and never copied
 * into the project folder: the workspace is ahead of what the folder last got.
 */
function resultsLeftInWorkspace(project: ProjectRecord): boolean {
  if (project.source.kind !== "local_folder") return false;
  const { appliedOriginalRevision } = (project as ProjectRecord & LegacyProject).integration;
  const copied = appliedOriginalRevision ?? project.source.baseRevision;
  return Boolean(
    project.integration.headRevision && copied && project.integration.headRevision !== copied,
  );
}

/**
 * The saved connection's role map and model ladder without the job bindings an
 * older version let the owner save: a "durable" role, and ladder rungs for job
 * profiles. No job profile is bound for work any more, so they are dropped as
 * the connection is read, silently; the next save writes the file without them.
 */
export function withoutJobBindings(saved: { roles: RoleMap; escalation?: EscalationSettings }): {
  roles: RoleMap;
  escalation?: EscalationSettings;
} {
  const isJob = (binding: RoleBinding | undefined) =>
    (binding?.source as string | undefined) === "durable";
  const { escalation } = saved;
  return {
    roles: Object.fromEntries(
      Object.entries(saved.roles).filter(
        ([role, binding]) => role !== "durable" && !isJob(binding),
      ),
    ),
    escalation: escalation && {
      ...escalation,
      profiles: escalation.profiles.filter((profile) => !isJob(profile)),
    },
  };
}

/** Brings one saved project up to date with the end of automatic durable routing. */
export async function retireDurableWork(
  store: FileStore,
  projectId: string,
  clock: () => Date = () => new Date(),
): Promise<void> {
  const project = await store.getProject(projectId);
  if (!project) return;
  const tasks = await store.getTasks(projectId);
  const at = nowIso(clock);
  const leftInWorkspace = resultsLeftInWorkspace(project);

  const notAccepted: string[] = [];
  let tasksChanged = false;
  for (const task of tasks) {
    if ((task.route as string | undefined) === "durable") {
      task.route = "interactive";
      tasksChanged = true;
    }
    // A grant for a job profile cannot start a worker on this Mac.
    if ((task.escalation?.profile.source as string | undefined) === "durable") {
      task.escalation = undefined;
      tasksChanged = true;
    }
    for (const attempt of task.attempts) {
      if (attempt.execution === "interactive" || !WAITING_ON_JOB.has(attempt.status)) continue;
      attempt.status = "cancelled";
      attempt.terminalAt = at;
      attempt.error = attempt.jobId
        ? `Sent as Poundlock job ${attempt.jobId} by an earlier Dispatch. This version does not follow jobs; "dispatch jobs status ${attempt.jobId}" shows where it ended.`
        : "An earlier Dispatch was about to send this as a Poundlock job and never did.";
      tasksChanged = true;
    }
    const last = task.attempts.at(-1);
    if (isFinished(task) || !last || last.execution === "interactive") continue;
    if (!IN_JOB_FLOW.has(task.status)) continue;
    if (last.status === "completed" && last.result?.patches.length) notAccepted.push(task.title);
    task.status = "ready";
    tasksChanged = true;
  }

  const legacy = project as ProjectRecord & LegacyProject;
  let projectChanged = false;
  for (const key of LEGACY_FIELDS) {
    if (!(key in legacy)) continue;
    delete legacy[key];
    projectChanged = true;
  }
  for (const key of LEGACY_INTEGRATION_FIELDS) {
    if (!(key in legacy.integration)) continue;
    delete legacy.integration[key];
    projectChanged = true;
  }
  // A question about a job route or a job's submission can no longer be answered.
  const question = project.needsInput;
  if (
    question?.choices?.some((choice) => choice.id === "run_durable") ||
    (question?.kind as string | undefined) === "submission_uncertain"
  ) {
    project.needsInput = undefined;
    if (project.status === "needs_input") pauseForResume(project, at);
    projectChanged = true;
  }
  if ((project.pause?.cause as string | undefined) === "submission_rejected") {
    pauseForResume(project, at);
    projectChanged = true;
  }
  if (/job budget/i.test(project.budget.stopReason ?? "")) {
    project.budget.stopReason = undefined;
    if (project.status === "failed") pauseForResume(project, at);
    projectChanged = true;
  }

  if (tasksChanged) await store.saveTasks(projectId, tasks);
  if (projectChanged) await store.saveProject(project);

  if (!notAccepted.length && !leftInWorkspace) return;
  const messages = await store.getMessages(projectId);
  if (messages.some((message) => message.id === DURABLE_NOTICE_ID)) return;
  const notice: ChatMessage = {
    id: DURABLE_NOTICE_ID,
    role: "system",
    kind: "notice",
    createdAt: at,
    text: noticeText(notAccepted, leftInWorkspace),
  };
  await store.appendMessage(projectId, notice);
}

function pauseForResume(project: ProjectRecord, at: string): void {
  project.status = "paused";
  project.pause = {
    cause: "awaiting_resume",
    detail: "Dispatch no longer runs work as Poundlock jobs. Resume to continue on this Mac.",
    at,
  };
}

function noticeText(notAccepted: string[], leftInWorkspace: boolean): string {
  const parts = [
    "Earlier versions of Dispatch ran work as Poundlock jobs and copied the results into your folder. This version does neither, so some job results will not reach your folder.",
  ];
  if (leftInWorkspace)
    parts.push(
      "Job changes you accepted are still in this project's review workspace and were never copied into your folder. To keep them, export them with the Dispatch you used before (Project menu, Export patch). Otherwise nothing here uses them, and you can ignore them.",
    );
  if (notAccepted.length) {
    const shown = notAccepted
      .slice(0, 5)
      .map((title) => `“${title}”`)
      .join(", ");
    parts.push(
      `Finished job results that were never accepted stay as history: ${shown}${notAccepted.length > 5 ? ", …" : ""}. Those tasks run again on this Mac when you resume.`,
    );
  }
  return parts.join("\n\n");
}
