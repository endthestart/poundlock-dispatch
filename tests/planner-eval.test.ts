import {
  PLANNER_EVAL_SCHEMA,
  type PlannerEvalFixture,
  type PlannerEvalRun,
  plannerEvalRow,
  scorePlannerEval,
} from "@core/goal/planner-eval";
import { parseAutoArgs } from "@tui/auto";
import { describe, expect, it } from "vitest";

const fixture = (extra: Partial<PlannerEvalFixture> = {}): PlannerEvalFixture => ({
  schema: PLANNER_EVAL_SCHEMA,
  name: "m2-review",
  repo: { path: "/repo", commit: "abc" },
  spec: { summary: "Library", checks: ["npm test"], milestones: [], requirements: [] },
  milestone: "M2",
  kind: "review",
  expect: {
    notShown: ["R4"],
    gaps: [
      { name: "folder browser in the shell", anyOf: ["FolderBrowserPanel", "folder browser"] },
      { name: "virtual copies e2e", anyOf: ["virtual copies real-browser", "virtual copy e2e"] },
    ],
  },
  ...extra,
});

const run = (
  answer: PlannerEvalRun["answer"],
  extra: Partial<PlannerEvalRun> = {},
): PlannerEvalRun => ({
  model: "local-35b",
  answer,
  seconds: 600,
  replies: 20,
  toolCalls: 40,
  cutOffs: 0,
  tokens: { input: 1, output: 2, cacheRead: 3, reasoning: 0 },
  costUsd: 0,
  ...extra,
});

describe("planner evaluation", () => {
  it("scores a review by the gaps it names and what it wrongly calls shown", () => {
    const result = scorePlannerEval(
      fixture(),
      run({
        tasks: [
          {
            title: "Integrate FolderBrowserPanel into the shell",
            objective: "o",
            acceptanceCriteria: "a",
            requirementIds: ["R4"],
          },
        ],
        verdicts: [{ requirementId: "R4", result: "shown", note: "all done" }],
        complete: false,
      }),
      "2026-10-18T00:00:00Z",
    );
    expect(result.scores).toMatchObject({
      usable: true,
      gapsFound: { found: ["folder browser in the shell"], missed: ["virtual copies e2e"] },
      falseShown: ["R4"],
      tasks: 1,
    });
    expect(plannerEvalRow(result)).toBe(
      "| local-35b | yes | 1/2 | R4 | 1 | 10 min | 40 | 0 | $0.00 |",
    );
  });

  it("counts a call that gave no answer as unusable", () => {
    const result = scorePlannerEval(
      fixture(),
      run(undefined, { error: "The Planner took longer than 30 minutes." }),
    );
    expect(result.scores.usable).toBe(false);
    expect(plannerEvalRow(result)).toContain("no (The Planner took longer than 30 minutes.)");
  });

  it("scores a frozen-test decision against the tests it should allow and keep", () => {
    const result = scorePlannerEval(
      fixture({
        kind: "frozen",
        frozen: {
          task: "Stacks UI",
          failure: "FAIL security.test.ts",
          tests: ["security.test.ts"],
        },
        expect: { allow: ["catalog.test.ts"], keep: ["security.test.ts"] },
      }),
      run({
        tasks: [],
        verdicts: [],
        complete: false,
        allowFrozenTests: [{ path: "security.test.ts", reason: "flaky" }],
      }),
    );
    expect(result.scores.wrongDecisions).toEqual([
      "kept catalog.test.ts",
      "allowed security.test.ts",
    ]);
  });

  it("is run from the command line with a fixture and a model", () => {
    expect(parseAutoArgs(["eval-planner", "m2.json", "--profile", "local-35b"])).toMatchObject({
      command: "eval-planner",
      profile: "local-35b",
    });
    expect(() => parseAutoArgs(["eval-planner", "m2.json"])).toThrow(/--profile/);
  });
});
