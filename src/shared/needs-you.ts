import type { ProjectStatus } from "./types.js";

/**
 * Statuses projectStatusView can turn into an approval, a resume, or a stuck-task decision —
 * every one of them, "failed" included: a failed run always needs the user to say how to
 * proceed, whether or not the stop happens to be resumable (see projectStatusView's canResume).
 */
const NEEDS_YOU_STATUS: ProjectStatus[] = ["awaiting_approval", "needs_input", "paused", "failed"];

export function projectNeedsYou(
  project: { id: string; status: ProjectStatus; needsInput?: unknown },
  approvals: { projectId: string }[] = [],
): boolean {
  if (approvals.some((item) => item.projectId === project.id)) return true;
  // needsInput can be set alongside a status this list doesn't otherwise cover — for example a
  // cancelled run whose remote cancellation is unconfirmed still asks the user to reconnect.
  if (project.needsInput) return true;
  return NEEDS_YOU_STATUS.includes(project.status);
}

export function countProjectsNeedingYou(
  projects: { id: string; archived?: boolean; status: ProjectStatus; needsInput?: unknown }[],
  approvals: { projectId: string }[] = [],
): number {
  return projects.filter((project) => !project.archived && projectNeedsYou(project, approvals))
    .length;
}
