import type { AutopilotView, CaseStage } from "./auto-run.js";

/** A task's stage in a run, in words: the same in the app and the terminal. */
export const CASE_STAGE_LABEL: Record<CaseStage, string> = {
  pending: "waiting",
  running: "working",
  repairing: "repairing",
  accepted: "verified",
  blocked: "blocked",
  abandoned: "abandoned",
  skipped: "skipped",
};

export const VERIFIED_LEAD = "Verified means the checks passed. The work is on branch ";
export const VERIFIED_TAIL = "; nothing is applied to your folder until you merge it.";

export interface AutopilotDetails {
  /** "Stopping now." or "Stopping after this task.", while a stop is pending. */
  stopping?: string;
  branch: string;
  /** "Planner: P (advising only).", when the run has one. */
  planner?: string;
  lines: string[];
  cases: Array<{ id: string; stage: CaseStage; label: string; title: string; reason?: string }>;
}

/** The run card's Details, in parts each front end can style. */
export function autopilotDetails(view: AutopilotView): AutopilotDetails {
  const stopping =
    view.stopRequested && view.phase !== "ended"
      ? view.stopRequested === "now"
        ? "Stopping now."
        : "Stopping after this task."
      : undefined;
  return {
    ...(stopping ? { stopping } : {}),
    branch: view.branch,
    ...(view.goal
      ? { planner: `Planner: ${view.goal.planner}${view.goal.advisory ? " (advising only)" : ""}.` }
      : {}),
    lines: view.lines,
    cases: view.cases.map((item) => ({
      id: item.id,
      stage: item.stage,
      label: CASE_STAGE_LABEL[item.stage],
      title: item.title,
      ...(item.reason ? { reason: item.reason } : {}),
    })),
  };
}

/** The Details summary as one plain sentence, for the terminal. */
export function autopilotDetailsSummary(details: AutopilotDetails): string {
  return [details.stopping, `${VERIFIED_LEAD}${details.branch}${VERIFIED_TAIL}`, details.planner]
    .filter(Boolean)
    .join(" ");
}
