/**
 * `/new`, `/new-run`, `/archive` and `/remove`: the desktop app's Project menu
 * entries. Whether one may run now, what it says it will do and what its
 * confirmation says all come from the shared `projectMenuActions`; the host
 * re-checks before acting.
 */
import type { DispatchHost } from "@core/host/dispatch-host";
import type { SelectItem, TUI } from "@earendil-works/pi-tui";
import { projectMenuActions } from "@shared/project-actions";
import type { AppStateView } from "@shared/types";
import type { Colours } from "./colour.js";
import { showPicker } from "./picker.js";

export type ConfirmedProjectAction = "newConversation" | "newRun" | "archive" | "remove";

export async function confirmProjectAction(
  id: ConfirmedProjectAction,
  context: { host: DispatchHost; tui: TUI; colours: Colours; state: AppStateView },
): Promise<boolean> {
  const { host, state } = context;
  const snapshot = state.snapshot;
  const projectId = state.selectedProjectId;
  if (!snapshot || !projectId) throw new Error("Open a project first.");
  const menu = projectMenuActions({ snapshot, approvals: state.approvals, busy: state.busy });
  const action = menu.actions.find((item) => item.id === id);
  if (!action?.confirm)
    throw new Error(menu.blockedReason ?? "That is not available for this project now.");
  const items: SelectItem[] = [
    { value: "confirm", label: action.confirm.confirmLabel, description: action.confirm.body },
    { value: "cancel", label: "Cancel" },
  ];
  const picked = await showPicker(context.tui, context.colours, items, {
    title: action.confirm.title,
  });
  if (picked?.value !== "confirm") return false;
  await host.projectLifecycle(id, { projectId });
  return true;
}
