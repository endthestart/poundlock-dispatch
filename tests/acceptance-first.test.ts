import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { placeAcceptanceTests } from "@core/auto/acceptance";
import { AutoRunEngine } from "@core/auto/engine";
import type { AutoVerifierPort } from "@core/auto/ports";
import { acceptanceProblems } from "@core/goal/acceptance";
import { plannerSpec } from "@core/goal/driver";
import { milestonePlanPrompt, type PlannerAnswer } from "@core/goal/planner-prompts";
import { type AutoCase, DEFAULT_AUTO_LIMITS } from "@shared/auto-run";
import type { Milestone, PlanRecord } from "@shared/types";
import { describe, expect, it } from "vitest";
import { type Env, git, type Script, setup, worker } from "./support/auto-engine-harness";
import { tempDir } from "./support/temp-dir";

const TEST = { path: "acceptance_test.txt", content: "expects the feature\n" };

/** Fails while the acceptance test is in the worktree and the feature it expects is not. */
const verifier: AutoVerifierPort = {
  async verify(worktree) {
    const red =
      readFileSync(join(worktree, TEST.path), "utf8").includes("expects the feature") &&
      !existsSync(join(worktree, "feature.txt"));
    return {
      passed: !red,
      commands: [
        {
          command: "npm test",
          exitCode: red ? 1 : 0,
          output: red ? `FAIL ${TEST.path} > shows the feature` : "ok",
        },
      ],
    };
  },
};
const presentOrNot: AutoVerifierPort = {
  verify: (worktree, signal) =>
    existsSync(join(worktree, TEST.path))
      ? verifier.verify(worktree, signal)
      : Promise.resolve({
          passed: true,
          commands: [{ command: "npm test", exitCode: 0, output: "ok" }],
        }),
};

const base: AutoCase = {
  id: "C1",
  title: "setup",
  objective: "write setup.txt",
  acceptanceCriteria: "setup.txt exists",
  dependsOn: [],
};

function run(env: Env, cases: AutoCase[], script: Script) {
  return new AutoRunEngine({
    runId: "r1",
    ledger: env.ledger,
    worker: worker(script),
    verifier: presentOrNot,
    repo: env.repo,
    mirror: env.mirror,
    runsRoot: env.runsRoot,
    controlPollMs: 20,
  }).start({ cases, limits: { ...DEFAULT_AUTO_LIMITS, caseMinutes: 60 }, model: "orion" });
}

const frozenEvents = async (env: Env) =>
  (await env.ledger.read()).flatMap(({ event }) => (event.type === "frozen" ? [event] : []));

describe("acceptance first in the engine", () => {
  it("adds a case's acceptance tests when it starts and freezes them once it is accepted", async () => {
    const env = await setup();
    const saw: boolean[] = [];
    await run(
      env,
      [base, { ...base, id: "C2", title: "feature", dependsOn: ["C1"], acceptanceTests: [TEST] }],
      async (input) => {
        saw.push(existsSync(join(input.worktree, TEST.path)));
        await writeFile(
          join(input.worktree, input.case.id === "C1" ? "setup.txt" : "feature.txt"),
          "ok\n",
        );
        return { finish: "done", summary: "done" };
      },
    );
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["accepted", "accepted"]);
    expect(saw).toEqual([false, true]);
    expect(git(env.worktree, "show", `HEAD:${TEST.path}`)).toBe(TEST.content.trim());
    expect(await frozenEvents(env)).toEqual([{ type: "frozen", caseId: "C2", paths: [TEST.path] }]);
  });

  it.each([
    ["weakened", (path: string) => writeFile(path, "expects nothing\n")],
    ["deleted", (path: string) => rm(path)],
  ])("puts back an acceptance test a worker %s and refuses that attempt", async (_, change) => {
    const env = await setup();
    const saw: string[] = [];
    await run(env, [{ ...base, acceptanceTests: [TEST] }], async (input) => {
      const path = join(input.worktree, TEST.path);
      saw.push(readFileSync(path, "utf8"));
      if (input.attempt === 1) {
        await change(path);
        await writeFile(join(input.worktree, "setup.txt"), "ok\n");
      } else await writeFile(join(input.worktree, "feature.txt"), "ok\n");
      return { finish: "done", summary: "done" };
    });
    const events = (await env.ledger.read()).map(({ event }) => event);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "scope", violations: [`${TEST.path} (frozen test)`] }),
    );
    expect(saw).toEqual([TEST.content, TEST.content]);
    expect((await env.ledger.state()).cases[0].stage).toBe("accepted");
  });

  it("takes an abandoned case's acceptance tests out of the project, unfrozen", async () => {
    const env = await setup();
    await run(
      env,
      [
        { ...base, acceptanceTests: [TEST] },
        { ...base, id: "C2", title: "next" },
      ],
      async (input) => {
        await writeFile(join(input.worktree, `${input.case.id}.txt`), "work\n");
        return { finish: "done", summary: "done" };
      },
    );
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["abandoned", "accepted"]);
    expect(existsSync(join(env.worktree, TEST.path))).toBe(false);
    expect(await frozenEvents(env)).toEqual([]);
  });

  it("never writes an acceptance test through a link out of the project", async () => {
    const root = await tempDir("acceptance-root-");
    const outside = await tempDir("acceptance-outside-");
    await symlink(outside, join(root, "tests"));
    await expect(
      placeAcceptanceTests(root, [{ path: "tests/acceptance_test.txt", content: "x" }]),
    ).rejects.toThrow("leads outside the project");
    await mkdir(join(root, "e2e"));
    await writeFile(join(outside, "target"), "kept\n");
    await symlink(join(outside, "target"), join(root, "e2e", "acceptance.spec.ts"));
    await expect(
      placeAcceptanceTests(root, [{ path: "e2e/acceptance.spec.ts", content: "x" }]),
    ).rejects.toThrow("is a link");
    expect(existsSync(join(outside, "acceptance_test.txt"))).toBe(false);
    expect(readFileSync(join(outside, "target"), "utf8")).toBe("kept\n");
  });
});

const M1: Milestone = {
  id: "M1",
  title: "Stack",
  goal: "stack frames",
  requirementIds: ["R1", "R2"],
};
const task = (
  title: string,
  requirementIds: string[],
  tests?: { path: string; content: string }[],
) => ({
  title,
  objective: "build it",
  acceptanceCriteria: "a user sees it",
  requirementIds,
  ...(tests ? { acceptanceTests: tests } : {}),
});
const answer = (...tasks: ReturnType<typeof task>[]): PlannerAnswer => ({
  tasks,
  verdicts: [],
  complete: false,
});

describe("acceptance first in the Planner's answer", () => {
  it("needs an acceptance test for every requirement of a planned milestone", () => {
    const covered = answer(
      task("Align", ["R1"], [{ path: "tests/align_acceptance_test.rs", content: "fn t() {}" }]),
    );
    expect(acceptanceProblems(covered, M1, [], true)).toEqual([
      "No acceptance test covers R2: write one on the task that wires each into the app, citing it.",
    ]);
    expect(acceptanceProblems(covered, M1, [], false)).toEqual([]);
  });

  it("refuses a test that is not a new acceptance test file in the project", () => {
    const problems = acceptanceProblems(
      answer(
        task(
          "A",
          ["R1", "R2"],
          [
            { path: "e2e/stack.spec.ts", content: "test()" },
            { path: "tests/acceptance_test.rs", content: "fn t() {}" },
            { path: "../acceptance_test.rs", content: "fn t() {}" },
            { path: "tests/empty_acceptance_test.rs", content: " " },
          ],
        ),
      ),
      M1,
      ["tests/acceptance_test.rs"],
      true,
    );
    expect(problems).toEqual([
      expect.stringContaining(
        "e2e/stack.spec.ts must be a test file outside build output with acceptance",
      ),
      "tests/acceptance_test.rs is already in the project: name a new file.",
      '“A” names "../acceptance_test.rs": give a path inside the project.',
      "Write the content of tests/empty_acceptance_test.rs.",
    ]);
  });

  it("asks only a gating Planner to write acceptance tests", () => {
    const plan = {
      summary: "a stacker",
      requirements: [],
      milestones: [M1],
    } as unknown as PlanRecord;
    const rule = "Acceptance first: you write each feature's acceptance test yourself";
    expect(milestonePlanPrompt(plannerSpec(plan, [], 90, true), M1, [])).toContain(rule);
    expect(milestonePlanPrompt(plannerSpec(plan, [], 90, false), M1, [])).not.toContain(rule);
  });
});
