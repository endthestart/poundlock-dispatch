/**
 * Local auto mode (ADR 014): the run ledger's vocabulary, and the pure
 * derivations any front end can show. The ledger (events.jsonl) is the source
 * of truth; the state here is always recomputed from it, so a crash can never
 * leave the two disagreeing.
 *
 * Accepted work is verified, not reviewed: nothing here may say otherwise.
 */

import type { EditGuardEvidence } from "./edit-guard";

/** B1 runs detached only; checkpoint supervision waits for research R6. */
export type Supervision = "detached";

export type AutoOutcome =
  | "objective_met"
  | "limit_reached_with_accepted_work"
  | "limit_reached_without_accepted_work"
  | "blocked_for_input"
  | "cancelled_after_checkpoint"
  | "failed"
  | "indeterminate_needs_reconciliation";

export interface AutoLimits {
  /** Wall clock: no new case starts after the soft limit. */
  softHours: number;
  /** Hard stop: the current attempt is interrupted, its draft saved. */
  hardHours: number;
  /** Cases started. */
  maxCases: number;
  /** Per-case allowance across all its attempts. */
  caseMinutes: number;
  maxRepairsPerCase: number;
  /** Attempts in a row that failed the same way before a case is abandoned. */
  maxSameFailure: number;
  /** Case failures in a row (reset only by a substantive acceptance). */
  maxConsecutiveFailedCases: number;
  /** Time without a substantive accepted checkpoint. */
  noProgressHours: number;
  /** Processed tokens (input + output + cache writes); cache reads never count. */
  maxProcessedTokens?: number;
  /** One shell command in the container. */
  commandMinutes: number;
  /** A model request with no progress (no Pi event and no running tool). */
  stallMinutes: number;
}

/** The hard limit: soft + one case allowance + 15 minutes, capped at 96 hours. */
export function hardHoursFor(softHours: number, caseMinutes: number): number {
  return Math.min(96, softHours + caseMinutes / 60 + 0.25);
}

export const DEFAULT_AUTO_LIMITS: AutoLimits = {
  // A goal runs around the clock: a day, then resume to continue (owner, 15 Oct).
  softHours: 24,
  hardHours: hardHoursFor(24, 90),
  maxCases: 40,
  // Workers are local models on modest hardware (owner, 15 Oct): small tasks, a longer allowance.
  caseMinutes: 90,
  maxRepairsPerCase: 2,
  maxSameFailure: 2,
  maxConsecutiveFailedCases: 3,
  noProgressHours: 4,
  commandMinutes: 20,
  stallMinutes: 15,
};

export interface AutoCase {
  id: string;
  title: string;
  objective: string;
  acceptanceCriteria: string;
  dependsOn: string[];
  /** Paths this case may change, in place of the run's writable paths. */
  writable?: string[];
  /** A tests-first case: once accepted, the tests it wrote are frozen for later cases. */
  writesTests?: boolean;
  /** May change frozen tests on purpose (the owner approved it on the plan). */
  changesFrozenTests?: boolean;
  /** Only these frozen tests may change: the Planner named them, and the report lists them. */
  frozenTestsToChange?: string[];
  /** Why they are out of date, in the Planner's words. */
  frozenChangeReason?: string;
  /** Ledger requirements this case serves (ADR 016). */
  requirementIds?: string[];
  /** The spec milestone it belongs to (ADR 016). */
  milestoneId?: string;
}

export interface AutoUsage {
  input: number;
  output: number;
  cacheWrite: number;
  /** Shown, never counted against a limit. */
  cacheRead: number;
}

export type CaseStage =
  | "pending"
  | "running"
  | "repairing"
  | "accepted"
  | "blocked"
  | "abandoned"
  | "skipped";

/** How an attempt ended, as the worker announced it. Acceptance is decided elsewhere. */
export type FinishStatus = "done" | "partial" | "blocked" | "none";

export interface CommandExit {
  command: string;
  exitCode: number | null;
}

/** What a front end may ask of a running goal through its inbox. */
export type InboxCommand = "pause" | "stop_now" | "message";

export interface InboxEntry {
  id: string;
  cmd: InboxCommand;
  text?: string;
  at: string;
}

export type AutoEvent =
  | {
      type: "run_started";
      runId: string;
      cases: AutoCase[];
      limits: AutoLimits;
      supervision: Supervision;
      baseCommit: string;
      /** The Poundlock profile the worker uses. */
      model?: string;
      /** Where commands run, as shown to the owner. */
      isolation?: string;
    }
  | {
      type: "preflight";
      /** Setup commands, then the plan's checks at the base commit. */
      phase: "prepare" | "checks";
      passed: boolean;
      commands: CommandExit[];
      /** Paths setup created (an environment); never scope violations, never committed. */
      environmentPaths?: string[];
      /** A greenfield goal: there is nothing to check yet, so the base checks were not run. */
      pending?: boolean;
    }
  /** A worker had setup run again mid-case, after changing dependencies (ADR 016). */
  | {
      type: "environment_prepared";
      caseId: string;
      passed: boolean;
      commands: CommandExit[];
      environmentPaths: string[];
    }
  | { type: "run_resumed" }
  /** Cases that joined the run after it started: the board grew (ADR 016). */
  | { type: "cases_added"; cases: AutoCase[] }
  /** The Planner planned a milestone's tasks (ADR 016). */
  | { type: "milestone_planned"; milestoneId: string; tasks: string[]; costUsd?: number }
  /** The Planner judged a milestone's requirements, and planned what closes the gaps. */
  | {
      type: "milestone_review";
      milestoneId: string;
      complete: boolean;
      verdicts: Array<{
        requirementId: string;
        result: "shown" | "partly" | "not shown";
        note: string;
      }>;
      tasks: string[];
      /** The milestone's tasks accepted when the review ran: the next one measures progress by it. */
      accepted?: number;
      /** Verdicts that do not gate the milestone: the Planner is not qualified (Local tier). */
      advisory?: boolean;
      notes?: string;
      /** What the Planner's call cost, by the catalog's estimate. */
      costUsd?: number;
    }
  | { type: "milestone_done"; milestoneId: string; gaps?: string[] }
  /** A Planner call that failed, and what it cost all the same. */
  | { type: "planner_cost"; costUsd: number }
  | { type: "case_started"; caseId: string }
  | { type: "attempt_started"; caseId: string; attempt: number; sessionKey: string }
  | {
      type: "attempt_finished";
      caseId: string;
      attempt: number;
      finish: FinishStatus;
      summary?: string;
      error?: string;
      usage?: AutoUsage;
      compactions?: number;
      editGuard?: EditGuardEvidence;
      minutes?: number;
      /** Commands an earlier attempt left running; they were stopped, not replayed. */
      interruptedActions?: string[];
    }
  | {
      type: "verification";
      caseId: string;
      attempt: number;
      passed: boolean;
      commands: CommandExit[];
    }
  | { type: "scope"; caseId: string; attempt: number; violations: string[] }
  | { type: "draft_saved"; caseId: string; attempt: number; ref: string; patchSha256: string }
  | { type: "checkpoint"; caseId: string; commit: string; substantive: boolean; reviewed: false }
  /** `already_met`: the worker found the case's work in the code and changed nothing, twice. */
  | {
      type: "case_accepted";
      caseId: string;
      after?: "finalization" | "checkpoint" | "already_met";
    }
  | { type: "case_repair"; caseId: string; reason: string }
  | { type: "case_blocked"; caseId: string; reason: string }
  | { type: "case_abandoned"; caseId: string; reason: string }
  | { type: "case_skipped"; caseId: string; reason: string }
  /** A goal began with its checks failing: its Planner plans their repair first. */
  | { type: "base_failing"; signature: string }
  | {
      type: "inference_wait";
      caseId: string;
      attempt: number;
      error: string;
      seconds: number;
      /** What was unavailable: Poundlock (the default) or the container runtime. */
      on?: "poundlock" | "container";
    }
  /** The prepared environment rebuilt from setup because an attempt changed it. */
  | { type: "environment_restored"; caseId: string; paths: string[]; passed: boolean }
  /** Files an attempt added inside the prepared environment, removed before its checks. */
  | { type: "environment_cleaned"; caseId: string; paths: string[] }
  /** An attempt waited this long for a model other work held. */
  | { type: "capacity_waited"; caseId: string; ms: number }
  | { type: "limit"; kind: string; level: "soft" | "hard" }
  | { type: "stop_requested"; mode: "after_case" | "now" }
  /** Test files frozen after a tests-first case was accepted; later cases may not change them. */
  | { type: "frozen"; caseId: string; paths: string[] }
  /** Frozen tests an accepted case changed because the Planner allowed it, and why. */
  | { type: "frozen_changed"; caseId: string; paths: string[]; reason?: string }
  /** A web search or page fetch the Planner made, or one Dispatch refused. */
  | {
      type: "web_call";
      tool: "web_search" | "web_fetch";
      target: string;
      status: string;
      size?: number;
    }
  /** Checks that failed only in untouched frozen tests, run once more. */
  /** No case: the base checks at the start. */
  | { type: "checks_rerun"; caseId?: string; attempt?: number; tests: string[]; passed: boolean }
  /** The Planner let the rest of the run change these frozen tests (Frontier tier). */
  | { type: "frozen_allowed"; caseId: string; allowed: Array<{ path: string; reason: string }> }
  /** The mutation check on a case's work: each small break tried, and whether the checks caught it. */
  | {
      type: "mutation";
      caseId: string;
      attempt: number;
      mutants: Array<{ path: string; line: number; change: string; caught: boolean }>;
    }
  /** An inbox entry the runner took: pause, stop now, or a message from the owner (ADR 016). */
  | { type: "inbox"; id: string; cmd: InboxCommand; text?: string }
  | { type: "run_ended"; outcome: AutoOutcome; reason: string };

/** What the owner chooses when Autopilot starts building an approved plan. */
export interface AutopilotStartOptions {
  /** The toolchain image the checks and commands run in. */
  image: string;
  /** The soft time limit; the hard one follows from it. */
  hours?: number;
  /** Let setup download dependencies, in a throwaway container. */
  allowDependencyDownloads?: boolean;
  /**
   * Accept a task whose work is already in the code: a second "done" that
   * changed nothing. Off by default; the milestone's next review judges it.
   */
  acceptAlreadyMet?: boolean;
  /** Setup commands, run before the base checks. */
  prepare?: string[];
  /** Where the run may write; unset, it may write anywhere but protected paths. */
  scope?: { writable?: string[]; bookkeeping?: string[]; protectedPaths?: string[] };
  /** For a plan with milestones: wait at each one, or only say it is done. Notify by default. */
  checkpoint?: "notify" | "wait";
  /** The destination the owner agreed the Planner may send code excerpts to. */
  allowPlannerDestination?: string;
  /** The most the Planner may cost over the goal, in US dollars (an estimate). */
  plannerSpendCapUsd?: number;
}

/** What merging an ended run into its folder brings. */
export interface AutopilotMergePreview {
  /** The run's last verified commit; the folder fast-forwards to it. */
  head: string;
  commits: number;
  files: number;
  /** Changed files that run on this Mac once merged (hooks, scripts): review them first. */
  runsHere: string[];
  /** The run's verified cases. */
  caseIds: string[];
}

/** A project's newest Autopilot run, as the app and the terminal client show it. */
export interface AutopilotView {
  runId: string;
  runDir: string;
  /** Preparing: setup and the base checks. Interrupted: unfinished, with no runner. */
  phase: "preparing" | "running" | "interrupted" | "ended";
  outcome?: AutoOutcome;
  outcomeLabel?: string;
  endReason?: string;
  stopRequested?: "after_case" | "now";
  /** The progress card's lines. */
  lines: string[];
  cases: Array<{ id: string; title: string; stage: CaseStage; reason?: string }>;
  branch: string;
  mirror: string;
  baseCommit: string;
  image: string;
  model: string;
  /** The run works the project's board: tasks added there join it. */
  board?: boolean;
  /** A goal (ADR 016): its Planner and checkpoint, and each milestone as the run has it. */
  goal?: { planner: string; advisory: boolean; checkpoint: "notify" | "wait" };
  milestones?: MilestoneState[];
  /** The morning report, once the run has ended and written it. */
  report?: string;
}

export interface LedgerEntry {
  seq: number;
  at: string;
  event: AutoEvent;
}

export interface CaseState {
  id: string;
  title: string;
  stage: CaseStage;
  attempts: number;
  repairs: number;
  checkpoints: string[];
  drafts: string[];
  lastFailure?: string;
  sameFailure: number;
  reason?: string;
  /** What the worker last reported, kept so an unfinished case's findings reach the Planner. */
  lastReport?: string;
  /** The session the case's attempts continue; a new key is a new session. */
  sessionKey?: string;
}

/**
 * An unfinished case as the Planner reads it: why it stopped and what its
 * worker last reported. A worker that fixed a defect but tripped a frozen test,
 * or traced a cause and ran out of time, had its findings dropped.
 */
export function unfinishedLine(
  title: string,
  item: Pick<CaseState, "stage" | "reason" | "lastReport">,
): string {
  const reason = item.reason ? `: ${item.reason.slice(0, 600)}` : "";
  const report =
    item.lastReport && item.stage !== "skipped"
      ? ` The worker's last report: ${item.lastReport.slice(0, 600)}`
      : "";
  return `${title} (${item.stage}${reason})${report}`;
}

export interface MilestoneState {
  id: string;
  stage: "planned" | "done";
  reviews: number;
  /** The last review's verdicts, by requirement. */
  verdicts: Array<{
    requirementId: string;
    result: "shown" | "partly" | "not shown";
    note: string;
  }>;
  /** Requirements left not shown when the milestone was closed. */
  gaps?: string[];
  notes?: string[];
  /** The milestone's accepted tasks when it was last reviewed. */
  acceptedAtReview?: number;
}

export interface AutoRunState {
  runId?: string;
  supervision: Supervision;
  limits: AutoLimits;
  baseCommit?: string;
  model?: string;
  isolation?: string;
  startedAt?: string;
  endedAt?: string;
  outcome?: AutoOutcome;
  endReason?: string;
  /** Unset until setup and the base checks have run; "failed" ends the run before any case. */
  preflight?: "passed" | "failed";
  environmentPaths: string[];
  cases: CaseState[];
  current?: { caseId: string; attempt: number; startedAt: string };
  /** Poundlock or the model was unavailable; the attempt waits and is retried. */
  waiting?: { caseId: string; error: string; until: string; on: "poundlock" | "container" };
  usage: AutoUsage;
  compactions: number;
  substantiveAccepted: number;
  lastSubstantiveAt?: string;
  consecutiveFailedCases: number;
  stopRequested?: "after_case" | "now";
  /** Messages the owner sent the run, in order, as the runner took them. */
  ownerMessages?: Array<{ id: string; text: string; at: string }>;
  /** Frozen tests changed with the Planner's leave, for the report. */
  frozenChanges?: Array<{ caseId: string; paths: string[]; reason?: string }>;
  /** The checks failed at the start of this goal run, until a case is accepted. */
  baseFailing?: string;
  limitsHit: Array<{ kind: string; level: "soft" | "hard" }>;
  /** The spec's milestones as the run has worked them, in the order it reached them. */
  milestones?: MilestoneState[];
  /** What the Planner has cost so far, by the catalog's estimate. */
  plannerUsd?: number;
  /** Every checkpoint commit on the run branch, oldest first. */
  checkpoints: Array<{ caseId: string; commit: string }>;
}

const EMPTY_USAGE: AutoUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

export function processedTokens(usage: AutoUsage): number {
  return usage.input + usage.output + usage.cacheWrite;
}

/** The run's last checkpoint commit, or undefined before the first one. */
export function lastCheckpoint(
  state: AutoRunState,
): { caseId: string; commit: string } | undefined {
  return state.checkpoints.at(-1);
}

/** Recompute the run's state from its ledger. Pure: the same entries always give the same state. */
export function reduceAutoEvents(entries: LedgerEntry[]): AutoRunState {
  const state: AutoRunState = {
    supervision: "detached",
    limits: DEFAULT_AUTO_LIMITS,
    environmentPaths: [],
    cases: [],
    usage: { ...EMPTY_USAGE },
    compactions: 0,
    substantiveAccepted: 0,
    consecutiveFailedCases: 0,
    limitsHit: [],
    checkpoints: [],
  };
  const byId = (id: string) => state.cases.find((c) => c.id === id);
  let lastAt: string | undefined;
  for (const { at, event } of entries) {
    switch (event.type) {
      case "run_started":
        state.runId = event.runId;
        state.supervision = event.supervision;
        state.limits = { ...DEFAULT_AUTO_LIMITS, ...event.limits };
        state.baseCommit = event.baseCommit;
        state.model = event.model;
        state.isolation = event.isolation;
        state.startedAt = at;
        state.cases = event.cases.map((c) => ({
          id: c.id,
          title: c.title,
          stage: "pending",
          attempts: 0,
          repairs: 0,
          checkpoints: [],
          drafts: [],
          sameFailure: 0,
        }));
        break;
      case "planner_cost":
        state.plannerUsd = (state.plannerUsd ?? 0) + event.costUsd;
        break;
      case "milestone_planned":
      case "milestone_review":
      case "milestone_done": {
        state.milestones ??= [];
        let milestone = state.milestones.find((item) => item.id === event.milestoneId);
        if (!milestone) {
          milestone = { id: event.milestoneId, stage: "planned", reviews: 0, verdicts: [] };
          state.milestones.push(milestone);
        }
        if (event.type !== "milestone_done" && event.costUsd)
          state.plannerUsd = (state.plannerUsd ?? 0) + event.costUsd;
        if (event.type === "milestone_review") {
          milestone.reviews++;
          milestone.verdicts = event.verdicts;
          if (event.accepted !== undefined) milestone.acceptedAtReview = event.accepted;
          if (event.notes) (milestone.notes ??= []).push(event.notes);
        }
        if (event.type === "milestone_done") {
          milestone.stage = "done";
          if (event.gaps?.length) milestone.gaps = event.gaps;
        }
        break;
      }
      case "cases_added":
        for (const c of event.cases)
          if (!byId(c.id))
            state.cases.push({
              id: c.id,
              title: c.title,
              stage: "pending",
              attempts: 0,
              repairs: 0,
              checkpoints: [],
              drafts: [],
              sameFailure: 0,
            });
        break;
      case "preflight":
        if (!event.passed) state.preflight = "failed";
        else if (event.phase === "checks") state.preflight = "passed";
        state.environmentPaths.push(...(event.environmentPaths ?? []));
        break;
      case "environment_prepared":
        for (const path of event.environmentPaths)
          if (!state.environmentPaths.includes(path)) state.environmentPaths.push(path);
        break;
      case "case_started": {
        const c = byId(event.caseId);
        if (c) c.stage = "running";
        break;
      }
      case "attempt_started": {
        const c = byId(event.caseId);
        if (c) {
          c.attempts = Math.max(c.attempts, event.attempt);
          c.sessionKey = event.sessionKey;
        }
        state.current = { caseId: event.caseId, attempt: event.attempt, startedAt: at };
        state.waiting = undefined;
        break;
      }
      case "attempt_finished":
        if (event.usage) {
          state.usage.input += event.usage.input;
          state.usage.output += event.usage.output;
          state.usage.cacheWrite += event.usage.cacheWrite;
          state.usage.cacheRead += event.usage.cacheRead;
        }
        state.compactions += event.compactions ?? 0;
        if (state.current?.caseId === event.caseId && state.current.attempt === event.attempt)
          state.current = undefined;
        if (event.summary?.trim()) {
          const c = byId(event.caseId);
          if (c) c.lastReport = event.summary.trim();
        }
        break;
      case "draft_saved":
        byId(event.caseId)?.drafts.push(event.ref);
        break;
      case "checkpoint":
        byId(event.caseId)?.checkpoints.push(event.commit);
        state.checkpoints.push({ caseId: event.caseId, commit: event.commit });
        if (event.substantive) {
          state.baseFailing = undefined;
          state.substantiveAccepted++;
          state.lastSubstantiveAt = at;
          state.consecutiveFailedCases = 0;
        }
        break;
      case "case_accepted": {
        const c = byId(event.caseId);
        if (c) c.stage = "accepted";
        break;
      }
      case "case_repair": {
        const c = byId(event.caseId);
        if (c) {
          c.stage = "repairing";
          c.repairs++;
          c.sameFailure = c.lastFailure === event.reason ? c.sameFailure + 1 : 1;
          c.lastFailure = event.reason;
        }
        break;
      }
      case "case_blocked":
      case "case_abandoned":
      case "case_skipped": {
        const c = byId(event.caseId);
        if (c) {
          c.stage =
            event.type === "case_blocked"
              ? "blocked"
              : event.type === "case_abandoned"
                ? "abandoned"
                : "skipped";
          c.reason = event.reason;
        }
        if (event.type !== "case_skipped") state.consecutiveFailedCases++;
        break;
      }
      case "inference_wait":
        state.waiting = {
          caseId: event.caseId,
          on: event.on ?? "poundlock",
          error: event.error,
          until: new Date(Date.parse(at) + event.seconds * 1000).toISOString(),
        };
        break;
      case "base_failing":
        state.baseFailing = event.signature;
        break;
      case "frozen_changed":
        (state.frozenChanges ??= []).push({
          caseId: event.caseId,
          paths: event.paths,
          ...(event.reason ? { reason: event.reason } : {}),
        });
        break;
      case "capacity_waited": {
        // A busy model is not a stuck run: the no-progress clock leaves the wait out.
        const from = state.lastSubstantiveAt ?? state.startedAt;
        if (from) state.lastSubstantiveAt = new Date(Date.parse(from) + event.ms).toISOString();
        break;
      }
      case "limit":
        state.limitsHit.push({ kind: event.kind, level: event.level });
        break;
      case "inbox":
        if (event.cmd === "message" && event.text)
          (state.ownerMessages ??= []).push({ id: event.id, text: event.text, at });
        break;
      case "stop_requested":
        state.stopRequested =
          event.mode === "now" || state.stopRequested === "now" ? "now" : "after_case";
        break;
      case "run_resumed": {
        // Limits count time the run was worked: a stopped or crashed run's pause is left out.
        const paused = lastAt ? Math.max(0, Date.parse(at) - Date.parse(lastAt)) : 0;
        const shift = (value: string | undefined) =>
          value ? new Date(Date.parse(value) + paused).toISOString() : value;
        state.startedAt = shift(state.startedAt);
        state.lastSubstantiveAt = shift(state.lastSubstantiveAt);
        state.endedAt = undefined;
        state.outcome = undefined;
        state.endReason = undefined;
        state.stopRequested = undefined;
        state.waiting = undefined;
        break;
      }
      case "run_ended":
        state.endedAt = at;
        state.outcome = event.outcome;
        state.endReason = event.reason;
        state.current = undefined;
        state.waiting = undefined;
        break;
      default:
        break;
    }
    lastAt = at;
  }
  return state;
}

/** What each outcome means, in words that never imply review. */
export const OUTCOME_LABELS: Record<AutoOutcome, string> = {
  objective_met: "every case verified (not reviewed)",
  limit_reached_with_accepted_work: "stopped at a limit; verified work kept",
  limit_reached_without_accepted_work: "stopped at a limit before any case was verified",
  blocked_for_input: "needs you",
  cancelled_after_checkpoint: "stopped; verified work kept",
  failed: "no case could be verified",
  indeterminate_needs_reconciliation: "unclear; check the run before resuming",
};

function minutesBetween(from: string | undefined, now: Date): number {
  return from ? Math.max(0, Math.round((now.getTime() - Date.parse(from)) / 60000)) : 0;
}

function hm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  return h ? `${h}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

function compact(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

/**
 * The progress card's lines, for any front end: run, supervision and model;
 * cases; the last checkpoint; tokens with cache reads apart; where commands
 * run; then what is happening now, or how it ended.
 */
export function autoProgressView(
  state: AutoRunState,
  now: Date,
  details: { activity?: string; runnerStopped?: boolean } = {},
): string[] {
  const count = (stage: CaseStage) => state.cases.filter((c) => c.stage === stage).length;
  const elapsed = minutesBetween(state.startedAt, state.endedAt ? new Date(state.endedAt) : now);
  const head = `Auto ${state.runId ?? "?"} · ${state.supervision}${state.model ? ` · ${state.model}` : ""} · ${hm(elapsed)} of ${state.limits.softHours}h`;
  const counts = `Cases ${count("accepted")}/${state.cases.length} verified, not reviewed · ${count("blocked")} blocked · ${count("abandoned")} abandoned`;
  const current = state.current
    ? (() => {
        const c = state.cases.find((x) => x.id === state.current?.caseId);
        return ` · ${c?.title ?? state.current.caseId} attempt ${state.current.attempt}${c?.repairs ? ` (repair ${c.repairs}/${state.limits.maxRepairsPerCase})` : ""} · ${hm(minutesBetween(state.current.startedAt, now))}`;
      })()
    : "";
  const last = lastCheckpoint(state);
  const lines = [
    head,
    counts + current,
    last ? `Last checkpoint ${last.commit.slice(0, 7)} ${last.caseId}` : "No checkpoint yet",
    `${compact(processedTokens(state.usage))} processed tokens (${compact(state.usage.cacheRead)} cache reads not counted) · compactions ${state.compactions}`,
  ];
  if (state.milestones?.length)
    lines.push(
      `Milestones: ${state.milestones
        .map(
          (item) =>
            `${item.id} ${item.stage === "done" ? (item.gaps?.length ? `done, gaps ${item.gaps.join(", ")}` : "verified") : item.reviews ? `review ${item.reviews}` : "planned"}`,
        )
        .join(" · ")}${state.plannerUsd ? ` · Planner about $${state.plannerUsd.toFixed(2)}` : ""}`,
    );
  if (state.isolation) lines.push(`Commands run in ${state.isolation}`);
  if (state.outcome)
    lines.push(`Ended: ${OUTCOME_LABELS[state.outcome]} — ${state.endReason ?? ""}`);
  else if (details.runnerStopped) lines.push("The runner is not running. Resume the run to go on.");
  else if (state.preflight === undefined && state.startedAt)
    lines.push("Now: preparing the container and running the checks at the base commit");
  else if (state.waiting)
    lines.push(
      `Now: waiting for ${state.waiting.on === "container" ? "the container runtime" : "Poundlock"} (${state.waiting.error.slice(0, 120)})`,
    );
  else if (details.activity) lines.push(`Now: ${details.activity}`);
  return lines;
}
