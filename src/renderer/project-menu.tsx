import { type ProjectAction, projectMenuActions } from "@shared/project-actions";
import type { AppStateView } from "@shared/types";
import { useState } from "react";
import { ConfirmDialog, useMenu } from "./dialog";

type Snapshot = NonNullable<AppStateView["snapshot"]>;

/**
 * The labeled Project menu: infrequent project actions in one place, showing
 * only actions that are valid for the current state.
 */
export function ProjectMenu({
  state,
  selected,
  onHistory,
  onSettings,
  onCompact,
  onState,
  onDraftReset,
}: {
  state: AppStateView;
  selected: Snapshot;
  onHistory: () => void;
  onSettings: () => void;
  onCompact: () => void;
  onState: (state: AppStateView) => void;
  onDraftReset: () => void;
}) {
  const menu = useMenu();
  const [confirm, setConfirm] = useState<ProjectAction>();
  const { actions, blockedReason } = projectMenuActions({
    snapshot: selected,
    approvals: state.approvals,
    busy: state.busy,
  });
  const projectId = selected.project.id;

  async function perform(action: ProjectAction): Promise<void> {
    // Bind to the project the action was opened for; a selection change in
    // the meantime must not redirect it.
    if (state.selectedProjectId !== projectId)
      throw new Error("The selected project changed. Reopen the menu for this project.");
    if (
      action.id !== "newConversation" &&
      action.id !== "newRun" &&
      action.id !== "archive" &&
      action.id !== "remove"
    )
      return;
    const next = await window.poundlockDispatch.projectLifecycle(action.id, {
      projectId,
      workflowId: selected.project.workflowId,
    });
    if (action.id === "newConversation") onDraftReset();
    if (next) onState(next);
  }

  function choose(action: ProjectAction) {
    menu.close();
    if (action.confirm) {
      setConfirm(action);
      return;
    }
    if (action.id === "history") onHistory();
    else if (action.id === "settings") onSettings();
    else if (action.id === "compact") onCompact();
  }

  const primary = actions.filter((item) => !["archive", "remove"].includes(item.id));
  const lifecycle = actions.filter((item) => ["archive", "remove"].includes(item.id));
  return (
    <div className="menu-anchor">
      <button type="button" className="menu-button" {...menu.triggerProps}>
        Project
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
          <path d="M3 4.5l3 3 3-3" />
        </svg>
      </button>
      {menu.open ? (
        <div className="menu-popover project-menu" aria-label="Project actions" {...menu.menuProps}>
          {primary.map((action) => (
            <MenuItem key={action.id} action={action} onChoose={choose} />
          ))}
          {lifecycle.length ? <div className="menu-separator" role="separator" /> : null}
          {lifecycle.map((action) => (
            <MenuItem key={action.id} action={action} onChoose={choose} />
          ))}
          {blockedReason ? <p className="menu-note">{blockedReason}</p> : null}
        </div>
      ) : null}
      {confirm?.confirm ? (
        <ConfirmDialog
          title={confirm.confirm.title}
          body={confirm.confirm.body}
          confirmLabel={confirm.confirm.confirmLabel}
          destructive={confirm.destructive}
          onClose={() => setConfirm(undefined)}
          onConfirm={() => perform(confirm)}
        />
      ) : null}
    </div>
  );
}

function MenuItem({
  action,
  onChoose,
}: {
  action: ProjectAction;
  onChoose: (action: ProjectAction) => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={action.destructive ? "danger-text" : undefined}
      onClick={() => onChoose(action)}
    >
      <strong>{action.label}</strong>
      <span>{action.description}</span>
    </button>
  );
}
