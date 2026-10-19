import type { ProjectStatus } from "./types.js";

/**
 * How a project's state reads at a glance, as a tone every front end paints
 * with its own palette: the desktop header pill and the terminal's title bar.
 */
export type StatusTone = "active" | "review" | "accepted" | "problem" | "muted";

/**
 * Tone for a project's status. `active` comes from `projectStatusView` so this
 * never disagrees with the dock's own grouping (for example,
 * `waiting_for_capacity` counts as active in both places).
 */
export function projectStatusTone(status: ProjectStatus, active: boolean): StatusTone {
  if (active) return "active";
  if (["awaiting_approval", "needs_input", "paused"].includes(status)) return "review";
  if (status === "completed") return "accepted";
  if (status === "failed") return "problem";
  return "muted";
}
