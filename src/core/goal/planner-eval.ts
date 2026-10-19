/**
 * Planner evaluation: one Planner call (a milestone review or a frozen-test
 * decision) against a fixed commit, scored against what a good answer must
 * hold. The fixture and the result are plain, versioned JSON, so the Toolkit
 * can run and compare them as a capability measurement later; only running
 * the call needs Dispatch, whose Planner prompts and tools it uses.
 *
 * Criteria (owner, 18 Oct): (a) the review finds the known gaps and calls
 * nothing shown that is not; (b) the answer is usable within the correction
 * rounds and the Planner's time and read limits; (c) its tasks are accepted at
 * a rate near the Frontier runs, measured only in a live run; (d) its
 * frozen-test decisions are sensible.
 */
import type { PlannerAnswer, PlannerSpec } from "./planner-prompts";

export const PLANNER_EVAL_SCHEMA = "poundlock.planner-eval/1";

export interface PlannerEvalFixture {
  schema: typeof PLANNER_EVAL_SCHEMA;
  name: string;
  /** A Git repository and the commit the Planner reads, read-only. */
  repo: { path: string; commit: string };
  spec: PlannerSpec;
  milestone: string;
  kind: "review" | "frozen";
  /** A review's inputs, as a run gives them. */
  accepted?: string[];
  unfinished?: string[];
  /** A frozen-test decision's inputs. */
  frozen?: { task: string; failure: string; tests: string[] };
  expect: {
    /** Requirements a correct review must not judge shown. */
    notShown?: string[];
    /** Gaps a correct review names: each matches when any of its words appears in a verdict note or a task. */
    gaps?: Array<{ name: string; anyOf: string[] }>;
    /** Frozen tests a correct decision allows, and ones it keeps. */
    allow?: string[];
    keep?: string[];
  };
}

export interface PlannerEvalRun {
  model: string;
  /** The answer, or why there was none. */
  answer?: PlannerAnswer;
  error?: string;
  seconds: number;
  replies: number;
  toolCalls: number;
  /** Replies cut off at the output limit. */
  cutOffs: number;
  tokens: { input: number; output: number; cacheRead: number; reasoning: number };
  costUsd: number;
}

export interface PlannerEvalResult extends PlannerEvalRun {
  schema: typeof PLANNER_EVAL_SCHEMA;
  fixture: string;
  at: string;
  scores: {
    /** (b) An answer came back within the limits and passed validation. */
    usable: boolean;
    /** (a) Known gaps named, of those listed. */
    gapsFound?: { found: string[]; missed: string[] };
    /** (a) Requirements judged shown that must not be. */
    falseShown?: string[];
    /** (d) Frozen-test decisions that disagree with the expected ones. */
    wrongDecisions?: string[];
    tasks: number;
  };
}

export function scorePlannerEval(
  fixture: PlannerEvalFixture,
  run: PlannerEvalRun,
  at = new Date().toISOString(),
): PlannerEvalResult {
  const answer = run.answer;
  const scores: PlannerEvalResult["scores"] = {
    usable: Boolean(answer) && !run.error,
    tasks: answer?.tasks.length ?? 0,
  };
  if (answer && fixture.kind === "review") {
    const text = [
      ...answer.verdicts.map((verdict) => verdict.note),
      ...answer.tasks.flatMap((task) => [task.title, task.objective, task.acceptanceCriteria]),
      answer.notes ?? "",
    ]
      .join("\n")
      .toLowerCase();
    if (fixture.expect.gaps?.length) {
      const found = fixture.expect.gaps.filter((gap) =>
        gap.anyOf.some((word) => text.includes(word.toLowerCase())),
      );
      scores.gapsFound = {
        found: found.map((gap) => gap.name),
        missed: fixture.expect.gaps.filter((gap) => !found.includes(gap)).map((gap) => gap.name),
      };
    }
    const mustNot = new Set((fixture.expect.notShown ?? []).map((id) => id.toUpperCase()));
    scores.falseShown = answer.verdicts
      .filter(
        (verdict) => verdict.result === "shown" && mustNot.has(verdict.requirementId.toUpperCase()),
      )
      .map((verdict) => verdict.requirementId);
    if (answer.complete && mustNot.size) scores.falseShown.push("milestone called complete");
  }
  if (answer && fixture.kind === "frozen") {
    const allowed = new Set((answer.allowFrozenTests ?? []).map((item) => item.path));
    scores.wrongDecisions = [
      ...(fixture.expect.allow ?? []).filter((path) => !allowed.has(path)).map((p) => `kept ${p}`),
      ...(fixture.expect.keep ?? []).filter((path) => allowed.has(path)).map((p) => `allowed ${p}`),
    ];
  }
  return { schema: PLANNER_EVAL_SCHEMA, fixture: fixture.name, at, ...run, scores };
}

/** One line per result, for an evidence table. */
export function plannerEvalRow(result: PlannerEvalResult): string {
  const s = result.scores;
  const gaps = s.gapsFound
    ? `${s.gapsFound.found.length}/${s.gapsFound.found.length + s.gapsFound.missed.length}`
    : "–";
  const wrong = [...(s.falseShown ?? []), ...(s.wrongDecisions ?? [])];
  return `| ${result.model} | ${s.usable ? "yes" : `no (${(result.error ?? "no answer").slice(0, 60)})`} | ${gaps} | ${wrong.length ? wrong.join("; ") : "none"} | ${s.tasks} | ${Math.round(result.seconds / 60)} min | ${result.toolCalls} | ${result.cutOffs} | $${result.costUsd.toFixed(2)} |`;
}

export const PLANNER_EVAL_HEADER = [
  "| Model | Usable (b) | Gaps found (a) | Wrong calls (a, d) | Tasks | Time | Tool calls | Cut off | Cost |",
  "|---|---|---|---|---|---|---|---|---|",
].join("\n");
