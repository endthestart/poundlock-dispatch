import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

/**
 * Modal dialog with a focus trap, Escape to close and focus return to the
 * element that opened it. `busy` blocks dismissal while an action runs.
 */
export function Dialog({
  title,
  description,
  onClose,
  busy = false,
  className = "",
  children,
  initialFocus,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  className?: string;
  children: ReactNode;
  /** CSS selector inside the dialog to focus first. */
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current;
    if (root) {
      const preferred = initialFocus
        ? root.querySelector<HTMLElement>(initialFocus)
        : root.querySelector<HTMLElement>("[data-autofocus]");
      (preferred ?? focusables(root)[0] ?? root).focus();
    }
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [initialFocus]);

  // Keep focus inside while open. Saving can disable the focused button, and
  // the browser then drops focus outside the modal, where Escape and Tab
  // would no longer reach this dialog.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const reclaim = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.contains(event.target))
        (focusables(root)[0] ?? root).focus();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || root.contains(document.activeElement)) return;
      event.preventDefault();
      if (!busyRef.current) closeRef.current();
    };
    document.addEventListener("focusin", reclaim);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("focusin", reclaim);
      document.removeEventListener("keydown", escape);
    };
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      if (!busyRef.current) closeRef.current();
      return;
    }
    if (event.key !== "Tab" || !ref.current) return;
    const items = focusables(ref.current);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) closeRef.current();
      }}
    >
      <div
        ref={ref}
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h1 className="dialog-title" id={titleId}>
          {title}
        </h1>
        {description ? (
          <div className="dialog-description" id={descriptionId}>
            {description}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  destructive = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Dialog
      title={title}
      description={body}
      onClose={onClose}
      busy={busy}
      className="confirm"
      initialFocus="[data-cancel]"
    >
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" data-cancel disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={destructive ? "danger solid" : "primary"}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            void onConfirm()
              .then(() => onClose())
              .catch((caught: unknown) => {
                setError(caught instanceof Error ? caught.message : String(caught));
                setBusy(false);
              });
          }}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * Menu button behavior: arrow keys, Home/End, Escape and Tab close and return
 * focus to the trigger, outside clicks close.
 */
export function useMenu() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target))
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useLayoutEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [open]);

  function items(): HTMLElement[] {
    return [
      ...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ??
        []),
    ];
  }

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  const triggerProps = {
    ref: triggerRef,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": open ? menuId : undefined,
    onClick: () => setOpen((value) => !value),
    onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
    },
  };

  const menuProps = {
    ref: menuRef,
    id: menuId,
    role: "menu" as const,
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const list = items();
      const index = list.indexOf(document.activeElement as HTMLElement);
      const move = (next: number) => {
        event.preventDefault();
        list[(next + list.length) % list.length]?.focus();
      };
      if (event.key === "ArrowDown") move(index + 1);
      else if (event.key === "ArrowUp") move(index - 1);
      else if (event.key === "Home") move(0);
      else if (event.key === "End") move(list.length - 1);
      else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") close(false);
    },
  };

  return { open, setOpen, close, triggerProps, menuProps };
}

type SaveState =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

/** Save feedback for explicit-save forms and immediately saved preferences. */
export function useSaveState() {
  const [state, setState] = useState<SaveState>({ kind: "clean" });
  async function save<T>(work: () => Promise<T>): Promise<T | undefined> {
    setState({ kind: "saving" });
    try {
      const result = await work();
      setState({ kind: "saved", at: Date.now() });
      return result;
    } catch (caught) {
      setState({
        kind: "error",
        message: caught instanceof Error ? caught.message : String(caught),
      });
      return undefined;
    }
  }
  return {
    state,
    saving: state.kind === "saving",
    markDirty: () =>
      setState((current) => (current.kind === "saving" ? current : { kind: "dirty" })),
    reset: () => setState({ kind: "clean" }),
    save,
  };
}

export function SaveStatus({
  state,
  savedText = "Saved",
  dirtyText = "Unsaved changes",
}: {
  state: SaveState;
  savedText?: string;
  dirtyText?: string;
}) {
  const text =
    state.kind === "dirty"
      ? dirtyText
      : state.kind === "saving"
        ? "Saving…"
        : state.kind === "saved"
          ? `${savedText} · ${new Date(state.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : state.kind === "error"
            ? `Not saved: ${state.message}`
            : "";
  return (
    <span
      className={`save-status ${state.kind}`}
      role={state.kind === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      {text}
    </span>
  );
}
