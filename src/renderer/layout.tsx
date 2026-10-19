import {
  fitPanels,
  LEFT_PANEL,
  type PanelPreferences,
  RIGHT_PANEL,
  resizeByKey,
} from "@shared/panel-layout";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";

const KEYS = {
  left: "lockkeep.layout.left",
  right: "lockkeep.layout.right",
  leftCollapsed: "lockkeep.layout.leftCollapsed",
  rightCollapsed: "lockkeep.layout.rightCollapsed",
};

function readNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = Number(window.localStorage.getItem(key));
    if (Number.isFinite(raw) && raw >= min) return Math.min(max, raw);
  } catch {
    /* storage unavailable */
  }
  return fallback;
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

type Side = "left" | "right";

/**
 * Panel layout: stored preferences (width, collapsed) stay separate from the
 * displayed, window-fitted layout. Panels that cannot dock at the current
 * window width (for example at 200% text zoom) open as an overlay instead.
 */
export function usePanelLayout() {
  const [prefs, setPrefs] = useState<PanelPreferences>(() => ({
    left: readNumber(KEYS.left, LEFT_PANEL.fallback, LEFT_PANEL.min, LEFT_PANEL.max),
    right: readNumber(KEYS.right, RIGHT_PANEL.fallback, RIGHT_PANEL.min, RIGHT_PANEL.max),
    leftCollapsed: readFlag(KEYS.leftCollapsed),
    rightCollapsed: readFlag(KEYS.rightCollapsed),
  }));
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  const [overlay, setOverlay] = useState<Side>();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useLayoutEffect(() => {
    const sync = () => setWindowWidth(window.innerWidth);
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  const fit = fitPanels(windowWidth, prefs);

  function setWidth(side: Side, value: number, persist: boolean) {
    setPrefs((current) => ({ ...current, [side]: value }));
    if (persist) write(KEYS[side], String(value));
  }

  function setCollapsed(side: Side, collapsed: boolean) {
    const key = side === "left" ? "leftCollapsed" : "rightCollapsed";
    setPrefs((current) => ({ ...current, [key]: collapsed }));
    write(KEYS[key], collapsed ? "1" : "0");
  }

  function docked(side: Side) {
    return side === "left" ? fit.leftDocked : fit.rightDocked;
  }

  /** Show or hide a panel. Docks when there is room, otherwise opens an overlay. */
  function toggle(side: Side) {
    if (docked(side)) {
      setCollapsed(side, true);
      return;
    }
    if (overlay === side) {
      setOverlay(undefined);
      return;
    }
    const next = fitPanels(windowWidth, {
      ...prefs,
      [side === "left" ? "leftCollapsed" : "rightCollapsed"]: false,
    });
    const wouldDock = side === "left" ? next.leftDocked : next.rightDocked;
    if (wouldDock) {
      setCollapsed(side, false);
      setOverlay(undefined);
    } else setOverlay(side);
  }

  function startDrag(side: Side, event: { clientX: number; preventDefault: () => void }) {
    event.preventDefault();
    const bounds = side === "left" ? LEFT_PANEL : RIGHT_PANEL;
    const direction = side === "left" ? 1 : -1;
    const origin = event.clientX;
    const originWidth = side === "left" ? fit.left : fit.right;
    let latest = originWidth;
    const move = (next: MouseEvent) => {
      latest = Math.min(
        bounds.max,
        Math.max(bounds.min, originWidth + direction * (next.clientX - origin)),
      );
      setWidth(side, latest, false);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("col-resizing");
      write(KEYS[side], String(latest));
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function onSeparatorKey(side: Side, event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle(side);
      return;
    }
    const bounds = side === "left" ? LEFT_PANEL : RIGHT_PANEL;
    const next = resizeByKey(event.key, side === "left" ? fit.left : fit.right, bounds, {
      shift: event.shiftKey,
      direction: side === "left" ? 1 : -1,
    });
    if (next === undefined) return;
    event.preventDefault();
    setWidth(side, next, true);
  }

  function separatorProps(side: Side, label: string) {
    const bounds = side === "left" ? LEFT_PANEL : RIGHT_PANEL;
    return {
      role: "separator" as const,
      tabIndex: 0,
      "aria-orientation": "vertical" as const,
      "aria-label": label,
      "aria-valuemin": bounds.min,
      "aria-valuemax": bounds.max,
      "aria-valuenow": side === "left" ? fit.left : fit.right,
      title: `${label}. Drag or use arrow keys to resize; Enter hides the panel.`,
      className: "resize-handle",
      onMouseDown: (event: { clientX: number; preventDefault: () => void }) =>
        startDrag(side, event),
      onKeyDown: (event: KeyboardEvent) => onSeparatorKey(side, event),
    };
  }

  return {
    fit,
    overlay,
    closeOverlay: () => setOverlay(undefined),
    toggle,
    visible: (side: Side) => docked(side) || overlay === side,
    separatorProps,
  };
}
