/**
 * Fixed loop-budget limits.
 *
 * `maxManagerTurns`, `maxRepairsPerTask` and `maxRecoveriesPerTask` used to
 * live on `ProjectPolicy`, persisted per project, but no UI ever wrote a
 * project-specific value for any of them — every saved project just carried
 * the one default, which forced a one-off migration (`migrateProjectPolicy`)
 * the day that default changed. They are named constants instead: one place
 * to change the number, no dead per-project storage, no settings nobody can
 * reach.
 *
 * If a real per-project need for one of these shows up, give it a writer
 * (settings UI or API) and move it back onto `ProjectPolicy` deliberately.
 */

/** Manager turns allowed in one run before Dispatch stops for the user. */
export const MAX_MANAGER_TURNS = 24;

/** The manager-turn stop's wording; Resume continues past it with a fresh allowance. */
export const TURN_BUDGET_STOP =
  "The manager-turn budget is exhausted. Remaining worker results are kept. Resume continues with a fresh allowance.";

/**
 * Manager turns for a plan: each task takes a dispatch, a review and the odd
 * repair or question, so a fixed 24 stopped a fifteen-task plan two tasks in.
 */
/** A turn-budget stop, including ones recorded before Resume could continue past it. */
export function isTurnBudgetStop(reason: string | undefined): boolean {
  return Boolean(reason?.startsWith("The manager-turn budget is exhausted"));
}

export function managerTurnsForPlan(taskCount: number): number {
  return Math.max(MAX_MANAGER_TURNS, 8 + 4 * taskCount);
}

/**
 * Fix rounds Dispatch itself grants a task: the manager sending a task back
 * for corrections after reviewing a finished attempt.
 */
export const MAX_REPAIRS_PER_TASK = 2;

/** The owner may set fix rounds per task from 0 to this, in Settings or per project. */
export const MAX_FIX_ROUNDS_SETTING = 5;

/**
 * Fix rounds a task gets: the project's override, else the app default from
 * Settings, else `MAX_REPAIRS_PER_TASK`. Out-of-range values fall back.
 */
export function fixRoundsPerTask(
  projectOverride: number | undefined,
  appDefault: number | undefined,
): number {
  const valid = (value: number | undefined) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_FIX_ROUNDS_SETTING;
  if (valid(projectOverride)) return projectOverride as number;
  if (valid(appDefault)) return appDefault as number;
  return MAX_REPAIRS_PER_TASK;
}

/** Retries after an interruption outside the worker's control (Phase 1: retry-after-interruption). */
export const MAX_RECOVERIES_PER_TASK = 3;
