import { approvalIgnoresKeyboardTarget, approvalShortcut } from "@shared/approval-copy";
import { approvalView } from "@shared/approval-view";
import type { AppStateView } from "@shared/types";
import { useEffect, useRef, useState } from "react";

/** Elements whose own Enter/Escape behavior must win over approval shortcuts. */
const OWN_KEYS =
  'button, a, summary, [role="menu"], [role="menuitem"], [role="separator"], [role="dialog"]';

export function ApprovalPanel({
  state,
  onState,
  selectedProjectId,
}: {
  state: AppStateView;
  onState: (state: AppStateView) => void;
  selectedProjectId?: string;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string>();
  if (!state.approvals?.length) return null;
  const request = state.approvals[0];
  return (
    <ApprovalCard
      total={state.approvals.length}
      request={request}
      otherProject={Boolean(selectedProjectId) && request.projectId !== selectedProjectId}
      pending={pending}
      error={error}
      onPending={setPending}
      onError={setError}
      onState={onState}
    />
  );
}

function ApprovalCard({
  total,
  request,
  otherProject,
  pending,
  error,
  onPending,
  onError,
  onState,
}: {
  total: number;
  request: NonNullable<AppStateView["approvals"]>[number];
  otherProject: boolean;
  pending?: string;
  error: string;
  onPending: (id?: string) => void;
  onError: (text: string) => void;
  onState: (state: AppStateView) => void;
}) {
  const view = approvalView(request);
  const decide = (decision: "once" | "always" | "deny") => {
    onPending(request.id);
    onError("");
    void window.poundlockDispatch
      .decideApproval(request.id, decision)
      .then(onState)
      .catch((caught) => onError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => onPending(undefined));
  };
  const decideRef = useRef(decide);
  decideRef.current = decide;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (pending) return;
      const target = event.target as HTMLElement | null;
      if (approvalIgnoresKeyboardTarget(target)) return;
      if (target?.closest?.(OWN_KEYS)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const shortcut = approvalShortcut(event);
      if (!shortcut) return;
      event.preventDefault();
      event.stopPropagation();
      decideRef.current(shortcut);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending]);

  const busy = Boolean(pending);
  return (
    <section
      className="approval-card"
      aria-labelledby={`approval-${request.id}`}
      aria-busy={busy}
      key={request.id}
    >
      <div className="approval-meta">
        <span className="state-pill review">Approval needed</span>
        <span>
          {total > 1 ? `1 of ${total}` : null}
          {otherProject ? ` · ${request.projectName}` : null}
        </span>
      </div>
      <h3 id={`approval-${request.id}`}>{view.headline}</h3>
      <dl className="facts">
        <dt>Action</dt>
        <dd>{view.action}</dd>
        <dt>Reason</dt>
        <dd>{view.reason}</dd>
        <dt>Scope</dt>
        <dd>{view.scope}</dd>
        <dt>Destination</dt>
        <dd>{view.destination}</dd>
        <dt>Consequences</dt>
        <dd>{view.consequences}</dd>
      </dl>
      <details className="disclosure">
        <summary>Exact request</summary>
        <pre className="code-block">{view.exact}</pre>
        {view.requested ? (
          <p className="hint">
            The worker asked for <code>{view.requested}</code>. Dispatch will run the form shown
            above.
          </p>
        ) : null}
      </details>
      {pending === request.id ? (
        <p role="status" className="action-receipt">
          Decision registered — processing…
        </p>
      ) : null}
      <div className="approval-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => decide("once")}>
          {view.once}
        </button>
        <button type="button" disabled={busy} onClick={() => decide("deny")}>
          {view.deny}
        </button>
      </div>
      <div className="approval-remember">
        <button type="button" className="quiet" disabled={busy} onClick={() => decide("always")}>
          {view.remember}
        </button>
        <span className="hint">{view.rememberDetail}</span>
      </div>
      <p className="hint shortcut-hint">
        Keyboard: Enter allows once · Esc denies · Shift-Enter saves the permission
      </p>
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
