import type { CaseStage } from "./auto-run.js";
import type { AttemptRecord, TaskRecord, TaskStatus } from "./types.js";

type TaskStateTone =
  | "accepted"
  | "verified"
  | "active"
  | "review"
  | "waiting"
  | "queued"
  | "problem"
  | "muted";

export interface TaskStateView {
  /** Short visible label; state is never conveyed by color or icon alone. */
  label: string;
  tone: TaskStateTone;
  /** Icon key rendered by the UI. */
  icon:
    | "check"
    | "verified"
    | "running"
    | "review"
    | "repair"
    | "queued"
    | "blocked"
    | "failed"
    | "cancelled";
  /** Only manager-accepted work gets a completion checkmark. */
  accepted: boolean;
}

export function taskStateView(status: TaskStatus): TaskStateView {
  switch (status) {
    case "applied":
      return { label: "Accepted", tone: "accepted", icon: "check", accepted: true };
    case "running":
      return { label: "Running", tone: "active", icon: "running", accepted: false };
    case "repairing":
      return { label: "Repairing", tone: "active", icon: "repair", accepted: false };
    case "needs_review":
      return { label: "Manager reviewing", tone: "review", icon: "review", accepted: false };
    case "queued":
      return { label: "Queued", tone: "waiting", icon: "queued", accepted: false };
    case "ready":
      return { label: "Up next", tone: "waiting", icon: "queued", accepted: false };
    case "blocked":
      return {
        label: "Blocked by earlier tasks",
        tone: "waiting",
        icon: "blocked",
        accepted: false,
      };
    case "failed":
      return { label: "Failed", tone: "problem", icon: "failed", accepted: false };
    case "cancelled":
      return { label: "Cancelled", tone: "muted", icon: "cancelled", accepted: false };
  }
}

/**
 * A board task as Autopilot's run has it. Its work is on the run's branch,
 * verified by the checks but not reviewed, so it never gets the checkmark.
 */
export function autopilotTaskView(stage: CaseStage): TaskStateView {
  switch (stage) {
    case "accepted":
      // An outlined check: done by the checks, but not the manager's filled one.
      return {
        label: "Verified by Autopilot, not reviewed",
        tone: "verified",
        icon: "verified",
        accepted: false,
      };
    case "running":
      return { label: "Autopilot working", tone: "active", icon: "running", accepted: false };
    case "repairing":
      return { label: "Autopilot repairing", tone: "active", icon: "repair", accepted: false };
    case "pending":
      return { label: "To do", tone: "queued", icon: "queued", accepted: false };
    case "blocked":
      return { label: "Autopilot: blocked", tone: "problem", icon: "blocked", accepted: false };
    case "abandoned":
      return { label: "Autopilot gave up", tone: "problem", icon: "failed", accepted: false };
    case "skipped":
      return {
        label: "Autopilot skipped: an earlier task did not finish",
        tone: "muted",
        icon: "cancelled",
        accepted: false,
      };
  }
}

/** Tasks that ended without their work kept: shown apart, so they do not crowd the list. */
export function autopilotUnfinished(stage: CaseStage | undefined): boolean {
  return stage === "abandoned" || stage === "skipped";
}

/**
 * The line above a board Autopilot is working, counted from its own stages.
 * The board's statuses are interactive work's, so they would call verified
 * tasks "next" (owner, 16 Oct).
 */
export function autopilotProgressLine(stages: CaseStage[], prefix = "Autopilot: "): string {
  const count = (wanted: CaseStage[]) => stages.filter((stage) => wanted.includes(stage)).length;
  const verified = count(["accepted"]);
  const working = count(["running", "repairing"]);
  const todo = count(["pending"]);
  const blocked = count(["blocked"]);
  const unfinished = count(["abandoned", "skipped"]);
  const parts = [
    `${verified} verified`,
    working ? `${working} in progress` : "",
    todo ? `${todo} to do` : "",
    blocked ? `${blocked} blocked` : "",
  ].filter(Boolean);
  const tail = unfinished
    ? ` ${unfinished} ${unfinished === 1 ? "task" : "tasks"} did not finish.`
    : "";
  return `${prefix}${parts.join(", ")}.${tail}`;
}

/** Paths touched by a unified diff, in order, without duplicates. */
export function changedFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split("\n")) {
    const match = /^\+\+\+ (?:b\/)?(.+)$/.exec(line) ?? /^--- (?:a\/)?(.+)$/.exec(line);
    if (!match) continue;
    const path = match[1].trim();
    if (path === "/dev/null" || files.includes(path)) continue;
    files.push(path);
  }
  return files;
}

export function attemptStatusLabel(status: AttemptRecord["status"]): string {
  switch (status) {
    case "pending_submit":
      return "Preparing";
    case "submitted":
      return "Submitted";
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "completed":
      return "Worker finished";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "uncertain":
      return "Outcome unconfirmed";
  }
}

/** The manager's decision on this task, from persisted workflow state only. */
export function managerDecisionText(task: Pick<TaskRecord, "status" | "attempts">): string {
  switch (task.status) {
    case "applied":
      return "Accepted by the Project Manager.";
    case "needs_review":
      return "Waiting for the Project Manager's review.";
    case "repairing":
      return "Returned for a bounded repair.";
    case "failed":
      return "Not accepted. The run stopped on this task.";
    case "cancelled":
      return "Cancelled before acceptance.";
    default:
      return task.attempts.length ? "No decision yet." : "Not started.";
  }
}
