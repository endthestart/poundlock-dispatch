export const PANEL_HANDLE_PX = 6;
export const MIN_MAIN_PX = 280;
/** Conversation width to protect before honoring wide stored panel widths. */
export const COMFORT_MAIN_PX = 440;
export const LEFT_PANEL = { min: 180, max: 480, fallback: 240 };
export const RIGHT_PANEL = { min: 320, max: 760, fallback: 420 };
/** Keyboard resize step for the panel separators; Shift uses the large step. */
const RESIZE_STEP_PX = 16;
const RESIZE_LARGE_STEP_PX = 64;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Keep the conversation column usable at the supported minimum window width.
 * Stored sidebar preferences are retained; only the displayed widths shrink.
 */
export function fitPanelWidths(
  windowWidth: number,
  left: number,
  right: number,
): { left: number; right: number } {
  const budget = Math.max(0, windowWidth - PANEL_HANDLE_PX * 2 - MIN_MAIN_PX);
  let nextLeft = clamp(left, LEFT_PANEL.min, LEFT_PANEL.max);
  let nextRight = clamp(right, RIGHT_PANEL.min, RIGHT_PANEL.max);
  if (nextLeft + nextRight <= budget) return { left: nextLeft, right: nextRight };
  const overflow = nextLeft + nextRight - budget;
  const shrinkRight = Math.min(overflow, Math.max(0, nextRight - RIGHT_PANEL.min));
  nextRight -= shrinkRight;
  nextLeft = Math.max(LEFT_PANEL.min, nextLeft - (overflow - shrinkRight));
  return { left: nextLeft, right: nextRight };
}

/** What the user asked for. Stored separately from what is displayed. */
export interface PanelPreferences {
  left: number;
  right: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

/** What the window can actually show right now. */
export interface PanelFit {
  left: number;
  right: number;
  /** Panel is laid out beside the conversation. */
  leftDocked: boolean;
  rightDocked: boolean;
  /** Panel is wanted open but the window is too narrow to dock it. */
  leftSqueezed: boolean;
  rightSqueezed: boolean;
}

/**
 * Fit the combined panel widths to the window. A panel the user collapsed stays
 * collapsed. When even the minimum widths do not leave room for the
 * conversation (for example at 200% text zoom), the status panel undocks
 * first, then the projects panel. Undocked panels remain reachable as an
 * overlay; the stored preferences are never rewritten by fitting.
 */
export function fitPanels(windowWidth: number, prefs: PanelPreferences): PanelFit {
  const fits = (left: boolean, right: boolean) =>
    (left ? LEFT_PANEL.min + PANEL_HANDLE_PX : 0) +
      (right ? RIGHT_PANEL.min + PANEL_HANDLE_PX : 0) +
      MIN_MAIN_PX <=
    Math.max(0, windowWidth);
  let leftDocked = !prefs.leftCollapsed;
  let rightDocked = !prefs.rightCollapsed;
  if (!fits(leftDocked, rightDocked)) rightDocked = false;
  if (!fits(leftDocked, rightDocked)) leftDocked = false;
  const handles = (leftDocked ? PANEL_HANDLE_PX : 0) + (rightDocked ? PANEL_HANDLE_PX : 0);
  const room = Math.max(0, windowWidth - handles);
  let left = clamp(prefs.left, LEFT_PANEL.min, LEFT_PANEL.max);
  let right = clamp(prefs.right, RIGHT_PANEL.min, RIGHT_PANEL.max);
  const minimums = (leftDocked ? LEFT_PANEL.min : 0) + (rightDocked ? RIGHT_PANEL.min : 0);
  // Protect a comfortable conversation first, never below the usable minimum.
  const main = Math.max(MIN_MAIN_PX, Math.min(COMFORT_MAIN_PX, room - minimums));
  const budget = Math.max(0, room - main);
  const used = (leftDocked ? left : 0) + (rightDocked ? right : 0);
  if (used > budget) {
    let overflow = used - budget;
    if (rightDocked) {
      const shrink = Math.min(overflow, right - RIGHT_PANEL.min);
      right -= shrink;
      overflow -= shrink;
    }
    if (leftDocked) left = Math.max(LEFT_PANEL.min, left - overflow);
  }
  return {
    left,
    right,
    leftDocked,
    rightDocked,
    leftSqueezed: !prefs.leftCollapsed && !leftDocked,
    rightSqueezed: !prefs.rightCollapsed && !rightDocked,
  };
}

/** Keyboard resize for a separator; returns the new stored preference. */
export function resizeByKey(
  key: string,
  width: number,
  bounds: { min: number; max: number },
  options: { shift?: boolean; direction: 1 | -1 },
): number | undefined {
  const step = options.shift ? RESIZE_LARGE_STEP_PX : RESIZE_STEP_PX;
  switch (key) {
    case "ArrowRight":
      return clamp(width + step * options.direction, bounds.min, bounds.max);
    case "ArrowLeft":
      return clamp(width - step * options.direction, bounds.min, bounds.max);
    case "Home":
      return bounds.min;
    case "End":
      return bounds.max;
    default:
      return undefined;
  }
}
