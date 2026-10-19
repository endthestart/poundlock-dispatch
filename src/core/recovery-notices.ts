import { projectStatusView } from "@shared/project-status";
import type { ProjectSnapshot, RecoveryNotice } from "@shared/types";
import { isAttemptTimeLimit } from "./attempt-limit.js";
import { isInfrastructureUnavailableError } from "./recovery.js";

/**
 * Recovery notices are presentation over `projectStatusView`, the one
 * authoritative derivation of what a project needs next: a notice may
 * describe *what happened*, from per-attempt history the single status line
 * doesn't carry, but its `nextAction` is always the status view's own `next`
 * text, never a separately worded instruction. Two sentences describing the
 * same moment used to drift (for example "you do not need to press Resume"
 * here against "Resume sends that result to the Project Manager again" in
 * the status line); sharing one source makes that impossible.
 *
 * A route change is no longer detected here by matching prose in
 * `needsInput.question` — it is the structured `needsInput.kind ===
 * "route_change"`, and `projectStatusView` already gives it the specific
 * "Settings → Models and routing… Approve current route" instruction (see
 * project-status.ts), so it needs no separate notice at all.
 */
export function recoveryNoticesFromSnapshot(snapshot?: ProjectSnapshot): RecoveryNotice[] {
  if (!snapshot) return [];
  const nextAction = projectStatusView(snapshot).next;
  const notices: RecoveryNotice[] = [];
  // Only what stands now: each unfinished task's latest attempt. An earlier
  // attempt a later one superseded would contradict the status view.
  for (const task of snapshot.tasks) {
    if (task.status === "applied" || task.status === "cancelled") continue;
    for (const attempt of task.attempts.slice(-1)) {
      if (attempt.status === "uncertain" || attempt.failureClass === "ambiguous_inference") {
        notices.push({
          kind: "ambiguous_inference",
          title: "Inference outcome is uncertain",
          detail: attempt.error || "The request may already have started.",
          nextAction,
        });
      }
      if (isAttemptTimeLimit(attempt)) {
        notices.push({
          kind: "interrupted_command",
          title: "Interactive worker reached the 45-minute limit",
          detail: attempt.error || "The attempt stopped because it used its time budget.",
          nextAction,
        });
        continue;
      }
      if (
        attempt.failureClass === "infrastructure" &&
        isInfrastructureUnavailableError(attempt.error)
      ) {
        const profile = attempt.profileName?.trim() || "The selected worker profile";
        notices.push({
          kind: "interrupted_command",
          title: `${profile} is unavailable`,
          detail: `${
            attempt.error ||
            "Poundlock returned infrastructure_unavailable while preparing that worker profile."
          } Wake or repair that node in Poundlock Machines; Dispatch checks again after /v1 for that profile succeeds.`,
          nextAction,
        });
        continue;
      }
      if (attempt.status === "paused" || attempt.failureClass === "infrastructure") {
        notices.push({
          kind: "interrupted_command",
          title: attempt.profileName?.trim()
            ? `${attempt.profileName} did not finish`
            : "Interactive work is paused",
          detail: attempt.error || "The attempt stopped before a terminal result.",
          nextAction,
        });
      }
    }
  }
  if (snapshot.project.infrastructureIssue) {
    const issue = snapshot.project.infrastructureIssue;
    notices.push({
      kind: issue.code === "capacity" ? "interrupted_command" : "route_change",
      title: issue.title,
      detail: issue.detail,
      nextAction,
    });
  }
  return uniqueNotices(notices);
}

function uniqueNotices(notices: RecoveryNotice[]): RecoveryNotice[] {
  const seen = new Set<string>();
  return notices.filter((notice) => {
    const key = `${notice.kind}:${notice.title}:${notice.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
