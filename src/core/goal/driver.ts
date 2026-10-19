/**
 * The goal driver (ADR 016): what Autopilot does when no task can run. It has
 * the Planner plan the next milestone, or review the one whose tasks ran out
 * and plan what closes its gaps, and it ends the run when every milestone is
 * verified, a checkpoint asks to wait, or the gaps will not close.
 */

import { casesFromTasks } from "@core/auto/cases";
import type { Ending, IdleAnswer } from "@core/auto/engine";
import type { AutoLedger } from "@core/auto/ledger";
import { type AutoRunState, unfinishedLine } from "@shared/auto-run";
import type { Milestone, PlanRecord, TaskRecord } from "@shared/types";
import type {
  FrozenAllowance,
  PlannedTask,
  PlannerAnswer,
  PlannerSpec,
  RequirementVerdict,
} from "./planner-prompts";

/** The Planner, as the driver needs it (`runtime/planner.ts`). */
export interface PlannerPort {
  planMilestone(input: {
    spec: PlannerSpec;
    milestone: Milestone;
    done: string[];
    ownerNotes?: string[];
    signal?: AbortSignal;
  }): Promise<PlannerAnswer>;
  reviewMilestone(input: {
    spec: PlannerSpec;
    milestone: Milestone;
    accepted: string[];
    ownerNotes?: string[];
    /** Its tasks that did not finish, each with why. */
    unfinished?: string[];
    /** Its tasks that ended changing nothing: the workers found their work already there. */
    unchanged?: string[];
    signal?: AbortSignal;
  }): Promise<PlannerAnswer>;
  decideFrozenTests(input: {
    spec: PlannerSpec;
    milestone: Milestone;
    task: { title: string; failure: string };
    tests: string[];
    signal?: AbortSignal;
  }): Promise<PlannerAnswer>;
}

/** The project's board, read and written by the run while it holds the project. */
export interface GoalBoard {
  plan(): Promise<PlanRecord | undefined>;
  tasks(): Promise<TaskRecord[]>;
  /** Write planned tasks to the board, returning the records as written. */
  addTasks(
    planned: PlannedTask[],
    milestone: Milestone,
    options?: { frozenChanges?: boolean },
  ): Promise<TaskRecord[]>;
  /** Record the Planner's verdicts on the ledger's requirements. */
  recordVerdicts(verdicts: RequirementVerdict[], advisory: boolean): Promise<void>;
}

export interface GoalDriverOptions {
  planner: PlannerPort;
  board: GoalBoard;
  ledger: AutoLedger;
  checks: string[];
  /** Minutes each worker task gets, so the Planner sizes tasks to fit. */
  workerMinutes?: number;
  /** The previous run's unfinished tasks and why: shown at this run's first review. */
  carriedOver?: string[];
  /** After a verified milestone: go on (notify), or end the run until the owner resumes it (wait). */
  checkpoint: "notify" | "wait";
  /**
   * The Planner is not qualified to gate the goal (the Local tier): its
   * verdicts are recorded and its gap tasks get one round, then the milestone
   * closes, listing what is still not shown rather than chasing it.
   */
  advisory?: boolean;
  /** Reviews per milestone before its gaps stop the run. */
  maxReviews?: number;
  /** The most the Planner may cost over the goal, by the catalog's estimate. */
  spendCapUsd?: number;
  /** Waits between Planner calls that fail for want of Poundlock. */
  waitsMs?: number[];
  isUnavailable?: (error: unknown) => boolean;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onActivity?: (text: string) => void;
}

export const MAX_MILESTONE_REVIEWS = 3;
/**
 * Reviews past MAX_MILESTONE_REVIEWS go on while each one finds newly accepted
 * tasks, up to this many: a milestone can keep progressing past three
 * reviews, and stopping it then needs a person to restart the run.
 */
export const MAX_PROGRESSING_REVIEWS = 8;
const PLANNER_WAITS_MS = [30_000, 60_000, 120_000, 240_000, 480_000];

export function plannerSpec(
  plan: PlanRecord,
  checks: string[],
  workerMinutes?: number,
  frozenChanges = false,
): PlannerSpec {
  return {
    ...(workerMinutes ? { workerMinutes } : {}),
    ...(frozenChanges ? { frozenChanges } : {}),
    summary: plan.summary,
    architecture: plan.architecture,
    scopeOut: plan.scopeOut,
    checks,
    milestones: plan.milestones ?? [],
    requirements: plan.requirements ?? [],
  };
}

/**
 * A milestone an earlier run verified: every requirement it holds is shown by
 * a verdict that gates. A run's own ledger knows only its own milestones, and a
 * continuation reviewed a milestone the last run had completed.
 */
function verifiedOnBoard(milestone: Milestone, plan: PlanRecord): boolean {
  const byId = new Map((plan.requirements ?? []).map((item) => [item.id.toUpperCase(), item]));
  return (
    milestone.requirementIds.length > 0 &&
    milestone.requirementIds.every((id) => {
      const verdict = byId.get(id.toUpperCase())?.verdict;
      return verdict?.result === "shown" && !verdict.advisory;
    })
  );
}

/** A Planner call, waited out while Poundlock is unavailable. */
function plannerCall(options: GoalDriverOptions) {
  const sleep =
    options.sleep ??
    ((ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      }));

  return async <T>(what: string, call: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    const waits = options.waitsMs ?? PLANNER_WAITS_MS;
    for (let index = 0; ; index++) {
      if (signal.aborted) throw new Error("stopped by the owner");
      try {
        return await call();
      } catch (error) {
        // A call that failed still cost what it used: the cap counts it.
        const cost = (error as { costUsd?: number }).costUsd;
        if (cost) await options.ledger.append({ type: "planner_cost", costUsd: cost });
        // A model busy with other work is waited out however long it takes;
        // the run's hour limits bound it. Only an unreachable one runs out.
        const busy = /capacity_in_use/.test(error instanceof Error ? error.message : String(error));
        if (signal.aborted || !options.isUnavailable?.(error) || (!busy && index >= waits.length))
          throw error;
        options.onActivity?.(`Planner: ${what} waits for Poundlock`);
        await sleep(busy ? waits[0] : waits[index], signal);
        if (busy) index--;
      }
    }
  };
}

export function goalDriver(
  options: GoalDriverOptions,
): (state: AutoRunState, signal: AbortSignal) => Promise<IdleAnswer> {
  const maxReviews = options.advisory ? 1 : (options.maxReviews ?? MAX_MILESTONE_REVIEWS);
  const ask = plannerCall(options);

  const idle = async (state: AutoRunState, signal: AbortSignal): Promise<IdleAnswer> => {
    const plan = await options.board.plan();
    const milestones = plan?.milestones ?? [];
    const spent = state.plannerUsd ?? 0;
    if (options.spendCapUsd !== undefined && spent >= options.spendCapUsd)
      return {
        end: {
          outcome: state.substantiveAccepted
            ? "limit_reached_with_accepted_work"
            : "limit_reached_without_accepted_work",
          reason: `the Planner has cost about $${spent.toFixed(2)}, the goal's $${options.spendCapUsd.toFixed(2)} cap`,
        },
      };
    // A plan with no milestones is a single board: the run ends with its cases.
    if (!plan || !milestones.length) return { cases: [] };
    // Only a Planner whose verdicts count may let a task change frozen tests.
    const spec = plannerSpec(plan, options.checks, options.workerMinutes, !options.advisory);
    const progress = new Map((state.milestones ?? []).map((item) => [item.id, item]));
    const current = milestones.find(
      (item) => progress.get(item.id)?.stage !== "done" && !verifiedOnBoard(item, plan),
    );
    if (!current) {
      // An advisory review closes a milestone with its gaps: not a goal met.
      const gaps = (state.milestones ?? []).flatMap((item) => item.gaps ?? []);
      return {
        end: gaps.length
          ? {
              outcome: state.substantiveAccepted
                ? "limit_reached_with_accepted_work"
                : "limit_reached_without_accepted_work",
              reason: `every milestone closed after one advisory review; not shown: ${gaps.join(", ")}`,
            }
          : {
              outcome: "objective_met",
              reason: `every milestone verified (${milestones.map((item) => item.id).join(", ")})`,
            },
      };
    }
    const tasks = await options.board.tasks();
    const stage = new Map(state.cases.map((item) => [item.id, item.stage]));
    const entries = await options.ledger.read();
    // Taken on the worker's word that the work was already there (the "already
    // met" setting): shown to the review as unverified, and not progress.
    const takenOnWord = new Set(
      entries.flatMap(({ event }) =>
        event.type === "case_accepted" && event.after === "already_met" ? [event.caseId] : [],
      ),
    );
    const acceptedTasks = (milestone?: string) =>
      tasks.filter(
        (task) =>
          (task.status === "applied" || stage.get(task.id) === "accepted") &&
          (!milestone || task.milestoneId === milestone),
      );
    const accepted = (milestone?: string) =>
      acceptedTasks(milestone).map((task) =>
        takenOnWord.has(task.id)
          ? `${task.title} (accepted without changes: the worker said its work is already in the code; unverified)`
          : task.title,
      );
    const verified = (milestone: string) =>
      acceptedTasks(milestone).filter((task) => !takenOnWord.has(task.id)).length;
    const ownerNotes = (state.ownerMessages ?? []).map((message) => message.text);
    const mine = tasks.filter((task) => task.milestoneId === current.id);
    const seen = progress.get(current.id);

    // Not reached yet: plan it.
    if (!mine.length && !seen) {
      const answer = await ask(
        `planning ${current.id}`,
        () =>
          options.planner.planMilestone({
            spec,
            milestone: current,
            done: accepted(),
            ownerNotes,
            signal,
          }),
        signal,
      );
      const added = await options.board.addTasks(answer.tasks, current, {
        frozenChanges: !options.advisory,
      });
      await options.ledger.append({
        type: "milestone_planned",
        milestoneId: current.id,
        tasks: added.map((task) => task.title),
        ...(answer.costUsd ? { costUsd: answer.costUsd } : {}),
      });
      return { cases: casesFromTasks(added) };
    }

    const close = async (gaps: string[]): Promise<IdleAnswer> => {
      await options.ledger.append({
        type: "milestone_done",
        milestoneId: current.id,
        ...(gaps.length ? { gaps } : {}),
      });
      const next = milestones[milestones.indexOf(current) + 1];
      if (next && options.checkpoint === "wait")
        return {
          end: {
            outcome: "cancelled_after_checkpoint",
            reason: `${current.id} is done; Autopilot waits for you at each milestone. Resume to go on to ${next.id}.`,
          },
        };
      return idle(await options.ledger.state(), signal);
    };

    // Its tasks ran out: review it, at most so many times, or more while it progresses.
    const reviews = seen?.reviews ?? 0;
    const progressing =
      !options.advisory &&
      verified(current.id) > (seen?.acceptedAtReview ?? Number.POSITIVE_INFINITY);
    if (reviews >= MAX_PROGRESSING_REVIEWS || (reviews >= maxReviews && !progressing)) {
      const gaps = (seen?.verdicts ?? [])
        .filter((item) => item.result !== "shown")
        .map((item) => item.requirementId);
      if (options.advisory) return close(gaps);
      return stuck(current, gaps, seen?.reviews ?? 0);
    }
    // Tasks that ended without their work since the milestone's last review:
    // the review must plan to finish them. Earlier ones went to that review,
    // which planned their replacements; counted again, they kept a milestone
    // whose replacements were all accepted from ever closing. A task that changed nothing found its work already there.
    const caseState = new Map(state.cases.map((item) => [item.id, item]));
    const lastReview =
      entries.findLast(
        ({ event }) => event.type === "milestone_review" && event.milestoneId === current.id,
      )?.seq ?? -1;
    const endedSince = new Set(
      entries.flatMap(({ seq, event }) =>
        seq > lastReview &&
        (event.type === "case_abandoned" ||
          event.type === "case_blocked" ||
          event.type === "case_skipped")
          ? [event.caseId]
          : [],
      ),
    );
    const unfinished = [
      ...(!seen?.reviews && options.carriedOver?.length
        ? options.carriedOver.map((line) => `from the last run: ${line}`)
        : []),
      ...(state.baseFailing
        ? [
            `the project's checks, which fail before any task (repair this first): ${state.baseFailing}`,
          ]
        : []),
      ...mine.flatMap((task) => {
        const run = caseState.get(task.id);
        return run &&
          ["abandoned", "blocked", "skipped"].includes(run.stage) &&
          endedSince.has(task.id) &&
          run.reason !== "no changes"
          ? [unfinishedLine(task.title, run)]
          : [];
      }),
    ];
    // Ended because it changed nothing: shown apart, for the review to check
    // in the code, rather than as work it must plan again.
    const unchanged = mine.flatMap((task) => {
      const run = caseState.get(task.id);
      return run?.stage === "abandoned" && endedSince.has(task.id) && run.reason === "no changes"
        ? [unfinishedLine(task.title, run)]
        : [];
    });
    const answer = await ask(
      `reviewing ${current.id}`,
      () =>
        options.planner.reviewMilestone({
          spec,
          milestone: current,
          accepted: accepted(current.id),
          ownerNotes,
          unfinished,
          unchanged,
          signal,
        }),
      signal,
    );
    await options.board.recordVerdicts(answer.verdicts, Boolean(options.advisory));
    const added = answer.tasks.length
      ? await options.board.addTasks(answer.tasks, current, { frozenChanges: !options.advisory })
      : [];
    await options.ledger.append({
      type: "milestone_review",
      milestoneId: current.id,
      complete: answer.complete,
      verdicts: answer.verdicts,
      tasks: added.map((task) => task.title),
      accepted: verified(current.id),
      ...(options.advisory ? { advisory: true } : {}),
      ...(answer.notes ? { notes: answer.notes } : {}),
      ...(answer.costUsd ? { costUsd: answer.costUsd } : {}),
    });
    const gaps = answer.verdicts
      .filter((item) => item.result !== "shown")
      .map((item) => item.requirementId);
    if (answer.complete) return close(gaps);
    // Gaps get their tasks; for an advisory Planner this is the one round.
    if (added.length) return { cases: casesFromTasks(added) };
    if (options.advisory) return close(gaps);
    return stuck(current, gaps, (seen?.reviews ?? 0) + 1);
  };

  const stuck = (milestone: Milestone, gaps: string[], reviews: number): IdleAnswer => ({
    end: {
      outcome: "blocked_for_input",
      reason: `${milestone.id} still has gaps after ${reviews} review${reviews === 1 ? "" : "s"}${gaps.length ? ` (${gaps.join(", ")})` : ""}: Autopilot needs you to look.`,
    } satisfies Ending,
  });

  return idle;
}

/**
 * When a task fails only on frozen tests, the Planner decides at once which of
 * them the rest of the run may change, rather than at the round's review, by
 * which time every task touching the same detail has failed on it. Never in
 * the Local tier, whose Planner does not gate.
 */
export function frozenDecider(
  options: GoalDriverOptions,
): (
  input: { title: string; failure: string; tests: string[] },
  signal: AbortSignal,
) => Promise<FrozenAllowance[]> {
  const ask = plannerCall(options);
  return async (input, signal) => {
    if (options.advisory) return [];
    const plan = await options.board.plan();
    const state = await options.ledger.state();
    if (options.spendCapUsd !== undefined && (state.plannerUsd ?? 0) >= options.spendCapUsd)
      return [];
    const progress = new Map((state.milestones ?? []).map((item) => [item.id, item]));
    const current = plan?.milestones?.find(
      (item) => progress.get(item.id)?.stage !== "done" && !verifiedOnBoard(item, plan),
    );
    if (!plan || !current) return [];
    const spec = plannerSpec(plan, options.checks, options.workerMinutes, true);
    const answer = await ask(
      `deciding on ${input.tests.join(", ")}`,
      () =>
        options.planner.decideFrozenTests({
          spec,
          milestone: current,
          task: { title: input.title, failure: input.failure },
          tests: input.tests,
          signal,
        }),
      signal,
    );
    if (answer.costUsd)
      await options.ledger.append({ type: "planner_cost", costUsd: answer.costUsd });
    return answer.allowFrozenTests ?? [];
  };
}
