import type { AutopilotGlance, CardTone } from "./autopilot-card.js";
import type { ProjectRecord, ProjectStatus } from "./types.js";

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

/** A run card's state as a tone, painted like a project's status. */
export const CARD_TONES: Record<CardTone, StatusTone> = {
  active: "active",
  needs_you: "review",
  done: "accepted",
  gaps: "review",
  stopped: "muted",
  failed: "problem",
};

/** Interactive work on a project outranks its last Autopilot run in the list and title. */
const ATTENDED = new Set<ProjectStatus>([
  "planning",
  "awaiting_approval",
  "running",
  "waiting_for_capacity",
  "needs_input",
  "reviewing",
]);

/** The project's Autopilot glance for the list and title, unless interactive work outranks it. */
export function projectGlance(
  project: Pick<ProjectRecord, "id" | "status">,
  glances: Record<string, AutopilotGlance> | undefined,
): AutopilotGlance | undefined {
  return ATTENDED.has(project.status) ? undefined : glances?.[project.id];
}
