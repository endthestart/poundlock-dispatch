import type { AutopilotCleanupItem } from "@shared/auto-run";
import { diskSize } from "@shared/disk-size";
import { useEffect, useState } from "react";
import { Dialog } from "./dialog";

const KEPT = "Its verified work stays on its branch and can still be merged or exported.";

/** Confirm dropping the project's newest run, which removes its working copy for good. */
export function AutopilotDropDialog({
  onClose,
  onDrop,
}: {
  onClose: () => void;
  onDrop: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title="Drop this Autopilot run?"
      description={`Removes the run's working copy, with everything setup installed in it, and the run can no longer be resumed. ${KEPT}`}
      onClose={onClose}
      busy={busy}
      initialFocus="[data-cancel]"
    >
      <div className="dialog-actions">
        <button type="button" data-cancel disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onDrop().finally(() => {
              setBusy(false);
              onClose();
            });
          }}
        >
          Drop run
        </button>
      </div>
    </Dialog>
  );
}

/** Pick ended runs, across every project, whose working copies to remove. */
export function AutopilotCleanupDialog({
  onClose,
  onCleanup,
}: {
  onClose: () => void;
  onCleanup: (runIds: string[]) => Promise<unknown>;
}) {
  const [items, setItems] = useState<AutopilotCleanupItem[]>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    window.poundlockDispatch
      .autopilotCleanupList()
      .then(setItems)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught)),
      );
  }, []);
  const toggle = (runId: string, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(runId);
      else next.delete(runId);
      return next;
    });
  const freed = (items ?? [])
    .filter((item) => picked.has(item.runId))
    .reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  return (
    <Dialog
      title="Clean up Autopilot runs"
      description={`Removes the working copies of the runs you pick; those runs can no longer be resumed. ${KEPT}`}
      onClose={onClose}
      busy={busy}
      initialFocus="[data-cancel]"
    >
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : !items ? (
        <p className="hint">Measuring the runs' working copies…</p>
      ) : !items.length ? (
        <p className="hint">No ended run has a working copy left.</p>
      ) : (
        <ul className="autopilot-cleanup">
          {items.map((item) => (
            <li key={item.runId}>
              <label>
                <input
                  type="checkbox"
                  checked={picked.has(item.runId)}
                  disabled={busy}
                  onChange={(event) => toggle(item.runId, event.currentTarget.checked)}
                />{" "}
                <strong>{item.bytes === undefined ? "size unknown" : diskSize(item.bytes)}</strong>{" "}
                {item.runId} · {item.ended}
                <span className="hint"> · {item.source}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <button type="button" data-cancel disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy || picked.size === 0}
          onClick={() => {
            setBusy(true);
            void onCleanup([...picked]).finally(() => {
              setBusy(false);
              onClose();
            });
          }}
        >
          {picked.size ? `Remove ${picked.size} (${diskSize(freed)})` : "Remove"}
        </button>
      </div>
    </Dialog>
  );
}
