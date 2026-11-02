import type { AutopilotView } from "./auto-run.js";
import { fallbackNotice } from "./spending-limit";
import type { Requirement } from "./types.js";

/**
 * The Autopilot run card (UX research, Oct 2026): what a returning owner needs
 * first. How it stands, time and spend against their limits, a verdict per
 * requirement, what needs them and what was built. Ids, checkpoints and the
 * container stay under Details.
 */
export type CardTone = "active" | "needs_you" | "done" | "gaps" | "stopped" | "failed";

export type VerdictChip = "shown" | "partly" | "not_shown" | "not_reviewed";

export interface AutopilotCard {
  tone: CardTone;
  headline: string;
  summary: string;
  time?: { minutes: number; limitHours: number };
  plannerSpend?: { usd: number; capUsd?: number };
  /** The project's manager, interview and planning included. */
  managerUsd?: number;
  /** The manager and the Planner across all projects in the last 7 days. */
  weekUsd?: number;
  /** Why a run that ended short stopped, when nothing needs the owner (a limit, a full disk). */
  why?: string;
  requirements: Array<{
    id: string;
    text: string;
    verdict: VerdictChip;
    note?: string;
    advisory?: boolean;
  }>;
  now?: string;
  needsYou: string[];
  built: string[];
}

/** One line for a project list or a title bar. */
export interface AutopilotGlance {
  label: string;
  tone: CardTone;
  /** A role moved to the local fallback after a spending refusal. */
  onFallback?: true;
}

const VERDICT: Record<NonNullable<Requirement["verdict"]>["result"], VerdictChip> = {
  shown: "shown",
  partly: "partly",
  "not shown": "not_shown",
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function minutesBetween(from: string | undefined, to: Date): number {
  return from ? Math.max(0, Math.round((to.getTime() - Date.parse(from)) / 60000)) : 0;
}

export function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} m` : `${minutes} m`;
}

/**
 * While Autopilot works a project, or owns an approved board it built, its card
 * is the project's status: "Task 1 of 3 is next" or "ready to start" beside it
 * would read as interactive work about to begin.
 */
export function autopilotOwnsStatus(
  autopilot: Pick<AutopilotView, "phase"> | undefined,
  statusCause: string | undefined,
): boolean {
  const live = autopilot?.phase === "preparing" || autopilot?.phase === "running";
  return live || (Boolean(autopilot) && statusCause === "ready_to_start");
}

/** A run's hour limit as a person reads it: "24 h", "30 m", never "0.524 h". */
export function limitText(hours: number): string {
  return Number.isInteger(hours) ? `${hours} h` : duration(Math.round(hours * 60));
}

function chips(requirements: Requirement[]): AutopilotCard["requirements"] {
  return requirements
    .filter((item) => item.status !== "waived")
    .map((item) => ({
      id: item.id,
      text: item.text,
      verdict: item.verdict ? VERDICT[item.verdict.result] : "not_reviewed",
      ...(item.verdict?.note ? { note: item.verdict.note } : {}),
      ...(item.verdict?.advisory ? { advisory: true } : {}),
    }));
}

function standing(
  view: AutopilotView,
  gaps: number,
  unreviewed: number,
  verified: number,
): Pick<AutopilotCard, "tone" | "headline"> {
  // A stop the owner asked for shows on the card, not only inside Details (UX review, 30 Oct).
  if ((view.phase === "preparing" || view.phase === "running") && view.stopRequested)
    return {
      tone: "active",
      headline: view.stopRequested === "now" ? "Stopping now" : "Stopping after this task",
    };
  if (view.phase === "preparing") return { tone: "active", headline: "Preparing" };
  if (view.phase === "running") return { tone: "active", headline: "Building" };
  if (view.phase === "interrupted") return { tone: "needs_you", headline: "Paused" };
  if (view.dropped) return { tone: "stopped", headline: "Dropped" };
  switch (view.outcome) {
    case "objective_met":
      return gaps
        ? { tone: "gaps", headline: `Built, ${plural(gaps, "gap")}` }
        : unreviewed
          ? { tone: "gaps", headline: "Built, not reviewed" }
          : { tone: "done", headline: "Built" };
    case "blocked_for_input":
    case "indeterminate_needs_reconciliation":
      return { tone: "needs_you", headline: "Needs you" };
    case "failed":
    case "limit_reached_without_accepted_work":
      return { tone: "failed", headline: "Nothing verified" };
    default:
      return { tone: "stopped", headline: verified ? "Stopped, work kept" : "Stopped" };
  }
}

export function autopilotCard(
  view: AutopilotView,
  requirements: Requirement[],
  now: Date,
  managerUsd?: number,
  weekUsd?: number,
): AutopilotCard {
  const verified = view.cases.filter((item) => item.stage === "accepted").length;
  const requirementChips = chips(requirements);
  const ended = view.phase === "ended";
  const count = (...verdicts: VerdictChip[]) =>
    ended ? requirementChips.filter((item) => verdicts.includes(item.verdict)).length : 0;
  const { tone, headline } = standing(
    view,
    count("not_shown", "partly"),
    count("not_reviewed"),
    verified,
  );
  // A paused run's clock stops at its last event, as its limits do (UX review, 30 Oct).
  const stoppedAt = view.endedAt ?? (view.phase === "interrupted" ? view.lastEventAt : undefined);
  const minutes = minutesBetween(view.startedAt, stoppedAt ? new Date(stoppedAt) : now);
  const spend = view.plannerUsd ?? 0;
  const milestone = view.milestones?.length
    ? ` · ${view.milestones.filter((item) => item.stage === "done").length} of ${view.milestones.length} milestones`
    : "";
  const summary = ended
    ? [
        view.endedAt
          ? `Ended ${new Date(view.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
          : "Ended",
        duration(minutes),
        ...(spend ? [`$${spend.toFixed(2)}`] : []),
      ].join(" · ")
    : `${verified} of ${plural(view.cases.length, "task")} verified${milestone}`;
  const needsYou = [
    ...(view.phase === "interrupted"
      ? ["Its runner stopped. Resume to go on, or stop the run to work here."]
      : []),
    ...(tone === "needs_you" && view.endReason ? [view.endReason] : []),
    // What the owner must answer, on the card's face, not inside Details (UX review, 30 Oct).
    ...(tone === "needs_you"
      ? view.cases
          .filter((item) => item.stage === "blocked" && item.reason)
          .map((item) => `${item.title}: ${item.reason}`)
      : []),
    ...(view.fallbacks ?? []).map(fallbackNotice),
    ...(ended
      ? requirementChips
          .filter((item) => item.verdict === "not_shown" || item.verdict === "partly")
          .map((item) => `${item.id} ${item.text}: ${item.note ?? `${item.verdict} by the review`}`)
      : []),
  ];
  const shown = requirementChips.filter((item) => item.verdict === "shown").length;
  const unfinished = view.cases.filter((item) =>
    ["blocked", "abandoned", "skipped"].includes(item.stage),
  ).length;
  const built = [
    `${verified} of ${plural(view.cases.length, "task")} verified by the checks${unfinished ? `, ${unfinished} did not finish` : ""}`,
    ...(requirementChips.length
      ? [
          requirementChips.some((item) => item.verdict !== "not_reviewed")
            ? `${shown} of ${plural(requirementChips.length, "requirement")} shown by the Planner`
            : "No requirement reviewed by the Planner yet",
        ]
      : []),
  ];
  const current = view.current
    ? `${view.current.title} · attempt ${view.current.attempt}${view.activity ? ` · ${view.activity}` : ""}`
    : view.activity;
  // The soft limit stops new tasks; the one in flight still finishes.
  const pastLimit =
    view.phase === "running" && view.softHours !== undefined && minutes >= view.softHours * 60;
  const doing = pastLimit
    ? `${current ? `${current} · ` : ""}Time limit reached: this task finishes, then the run stops`
    : current;
  return {
    tone,
    headline,
    summary,
    ...(view.startedAt ? { time: { minutes, limitHours: view.softHours } } : {}),
    ...(view.plannerUsd !== undefined || view.plannerCapUsd !== undefined
      ? {
          plannerSpend: {
            usd: spend,
            ...(view.plannerCapUsd !== undefined ? { capUsd: view.plannerCapUsd } : {}),
          },
        }
      : {}),
    ...(managerUsd ? { managerUsd } : {}),
    ...(weekUsd !== undefined ? { weekUsd } : {}),
    ...(ended && (tone === "stopped" || tone === "failed") && view.endReason
      ? { why: view.endReason }
      : {}),
    requirements: requirementChips,
    // A paused run's last activity is history, not what it is doing now.
    ...(view.phase === "running" && doing ? { now: doing } : {}),
    needsYou,
    built,
  };
}

/**
 * Autopilot holds the project from preparing until the run ends, an
 * interrupted run included: it resumes over the board as it left it, so what
 * the owner types goes to the run, not the manager.
 */
export function autopilotHoldsProject(phase: AutopilotView["phase"] | undefined): boolean {
  return phase === "preparing" || phase === "running" || phase === "interrupted";
}

/**
 * Where the owner's words go: to the run while it holds the project, and while it
 * waits on the owner's answer, as its card's "Needs you" says. Typed then, guidance
 * went to a manager turn and never reached the run (UX review, 30 Oct). A run the
 * owner stopped hands the composer back to the manager.
 */
export function autopilotTakesMessages(
  view: Pick<AutopilotView, "phase" | "outcome" | "dropped"> | undefined,
): boolean {
  if (!view || view.dropped) return false;
  return autopilotHoldsProject(view.phase) || view.outcome === "blocked_for_input";
}

/** Dollars as a cap is set: whole dollars bare, a $0.50 cap as 0.50, never rounded up to 1. */
export function dollars(usd: number): string {
  return Number.isInteger(usd) ? usd.toFixed(0) : usd.toFixed(2);
}

/**
 * Whether Resume can go on: a run that hit a limit stops again at once, so it is
 * built again instead (UX review, 30 Oct).
 */
export function autopilotResumable(view: AutopilotView | undefined): boolean {
  if (!view || view.dropped) return false;
  if (view.phase === "interrupted") return true;
  return (
    view.phase === "ended" &&
    view.outcome !== "objective_met" &&
    !view.outcome?.startsWith("limit_reached")
  );
}

/** The composer's hint while Autopilot takes the owner's words, the same in the app and the terminal. */
export function autopilotMessageHint(phase: AutopilotView["phase"]): string {
  if (phase === "ended") return "Answer Autopilot: the run reads your answer when you resume it…";
  return phase === "interrupted"
    ? "Message Autopilot: the run reads it when you resume…"
    : "Message Autopilot: the worker hears it now, later tasks and the Planner’s next review read it…";
}

/** The card's state in a few words, for the project list and the title bar. */
export function autopilotGlance(view: AutopilotView, requirements: Requirement[]): AutopilotGlance {
  const card = autopilotCard(view, requirements, new Date());
  if (card.tone !== "active") return { label: card.headline, tone: card.tone };
  const verified = view.cases.filter((item) => item.stage === "accepted").length;
  const label = `${card.headline} ${verified}/${view.cases.length}`;
  return view.fallbacks?.length
    ? { label: `${label} · on local fallback`, tone: card.tone, onFallback: true }
    : { label, tone: card.tone };
}

/**
 * Runs that just stopped building: the moments worth an alert. A run seen
 * first already ended is not news (the app was closed while it ended).
 */
export function autopilotArrivals(
  previous: Record<string, AutopilotGlance>,
  next: Record<string, AutopilotGlance>,
): Array<{ projectId: string; glance: AutopilotGlance }> {
  // A run that stops being active, or one that moved to the local fallback.
  return Object.entries(next).flatMap(([projectId, glance]) => {
    const before = previous[projectId];
    return (before?.tone === "active" && glance.tone !== "active") ||
      (before && !before.onFallback && glance.onFallback)
      ? [{ projectId, glance }]
      : [];
  });
}

const VERDICT_WORDS: Record<VerdictChip, string> = {
  shown: "shown",
  partly: "partly",
  not_shown: "not shown",
  not_reviewed: "not reviewed",
};

/** The run card as plain lines, for the terminal client. */
export function autopilotCardLines(card: AutopilotCard): string[] {
  const meters = [
    ...(card.time
      ? [`Time ${duration(card.time.minutes)} of ${limitText(card.time.limitHours)}`]
      : []),
    ...(card.managerUsd ? [`Manager $${card.managerUsd.toFixed(2)}`] : []),
    ...(card.plannerSpend
      ? [
          `Planner $${card.plannerSpend.usd.toFixed(2)}${card.plannerSpend.capUsd !== undefined ? ` of $${dollars(card.plannerSpend.capUsd)}` : ""}`,
        ]
      : []),
    ...(card.weekUsd !== undefined ? [`Last 7 days $${card.weekUsd.toFixed(2)}`] : []),
  ];
  return [
    `${card.headline} · ${card.summary}`,
    ...(card.why ? [`Why it stopped: ${card.why}`] : []),
    ...(meters.length ? [meters.join(" · ")] : []),
    ...(card.requirements.length
      ? [
          `Requirements: ${card.requirements.map((item) => `${item.id} ${VERDICT_WORDS[item.verdict]}`).join(" · ")}`,
        ]
      : []),
    ...(card.now ? [`Now: ${card.now}`] : []),
    ...card.needsYou.map((line) => `Needs you: ${line}`),
    ...(card.tone !== "active" ? card.built.map((line) => `Built: ${line}`) : []),
  ];
}
