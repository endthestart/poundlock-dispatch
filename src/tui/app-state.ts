/** What the terminal client reads off the state it is shown. */

import type { ToolApproval } from "@shared/permissions";
import { projectStatusView } from "@shared/project-status";
import type { AppStateView } from "@shared/types";

/** The decision this client must answer before anything else can happen. */
export function pendingDecision(state: AppStateView | undefined): ToolApproval | undefined {
  if (!state) return undefined;
  return (state.approvals ?? []).find(
    (item) => !item.projectId || item.projectId === state.selectedProjectId,
  );
}

/** The task the current status offers to retry, if any. */
export function retryableTask(state: AppStateView | undefined): string | undefined {
  const snapshot = state?.snapshot;
  if (!snapshot) return undefined;
  const status = projectStatusView(snapshot, { approvals: state.approvals });
  return status.actions.find((action) => action.id === "retry_task")?.taskId;
}

/** The folder this screen has open, when it is a local folder. */
export function localFolder(state: AppStateView | undefined): string | undefined {
  const project = state?.snapshot?.project;
  return project?.source.kind === "local_folder" ? project.source.originalPath : undefined;
}
