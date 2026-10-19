/**
 * The goal driver (ADR 016): when no task can run, review the milestone,
 * plan its gaps or the next one, and end only for the reasons in the plan's
 * stop table.
 */
import { AutoLedger } from "@core/auto/ledger";
import { frozenDecider, type GoalBoard, goalDriver, type PlannerPort } from "@core/goal/driver";
import type { PlannedTask, PlannerAnswer } from "@core/goal/planner-prompts";
import { autoProgressView, DEFAULT_AUTO_LIMITS } from "@shared/auto-run";
import type { Milestone, PlanRecord, TaskRecord } from "@shared/types";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const milestones: Milestone[] = [
  { id: "M1", title: "Skeleton", goal: "import", requirementIds: ["R1"] },
  { id: "M2", title: "Rate", goal: "rate", requirementIds: ["R2"] },
];

function board() {
  const plan: PlanRecord = {
    revision: 1,
    summary: "Library",
    acceptanceCriteria: [],
    authority: "",
    approved: true,
    createdAt: "now",
    milestones,
    requirements: [
      { id: "R1", text: "Import", scenarios: [], status: "open" },
      { id: "R2", text: "Rate", scenarios: [], status: "open" },
    ],
  };
  const tasks: TaskRecord[] = [
    {
      id: "T1",
      title: "Import",
      milestoneId: "M1",
      status: "ready",
      dependsOn: [],
    } as unknown as TaskRecord,
  ];
  const verdicts: Array<{ id: string; advisory: boolean }> = [];
  const value: GoalBoard & { tasksNow: TaskRecord[]; verdicts: typeof verdicts } = {
    tasksNow: tasks,
    verdicts,
    plan: async () => plan,
    tasks: async () => tasks,
    addTasks: async (planned: PlannedTask[], milestone: Milestone) => {
      const added = planned.map(
        (task) =>
          ({
            id: `T-${task.title}`,
            title: task.title,
            objective: task.objective,
            workerPrompt: task.objective,
            acceptanceCriteria: task.acceptanceCriteria,
            milestoneId: milestone.id,
            status: "ready",
            dependsOn: [],
          }) as unknown as TaskRecord,
      );
      tasks.push(...added);
      return added;
    },
    recordVerdicts: async (items, advisory) => {
      for (const item of items) verdicts.push({ id: item.requirementId, advisory });
    },
  };
  return value;
}

const planned = (title: string, id: string): PlannedTask => ({
  title,
  objective: title,
  acceptanceCriteria: "a test shows it",
  requirementIds: [id],
});

function planner(script: {
  plans?: PlannerAnswer[];
  reviews?: PlannerAnswer[];
  failFirst?: number;
  failWith?: string;
}) {
  const calls: string[] = [];
  let failures = script.failFirst ?? 0;
  const port: PlannerPort = {
    planMilestone: async ({ milestone }) => {
      calls.push(`plan ${milestone.id}`);
      return script.plans?.shift() ?? { tasks: [], verdicts: [], complete: false };
    },
    reviewMilestone: async ({ milestone }) => {
      if (failures-- > 0) throw new Error(script.failWith ?? "fetch failed");
      calls.push(`review ${milestone.id}`);
      return script.reviews?.shift() ?? { tasks: [], verdicts: [], complete: false };
    },
    decideFrozenTests: async ({ milestone, tests }) => {
      calls.push(`frozen ${milestone.id} ${tests.join(",")}`);
      return {
        tasks: [],
        verdicts: [],
        complete: false,
        allowFrozenTests: tests.map((path) => ({ path, reason: "pins one migration" })),
        costUsd: 0.1,
      };
    },
  };
  return { port, calls };
}

async function ledgerWith(accepted: string[]) {
  const ledger = new AutoLedger(await tempDir("goal-driver-"));
  await ledger.append({
    type: "run_started",
    runId: "r",
    cases: [{ id: "T1", title: "Import", objective: "o", acceptanceCriteria: "a", dependsOn: [] }],
    limits: DEFAULT_AUTO_LIMITS,
    supervision: "detached",
    baseCommit: "0",
  });
  for (const id of accepted) await ledger.append({ type: "case_accepted", caseId: id });
  return ledger;
}

const shown = (id: string) => ({ requirementId: id, result: "shown" as const, note: "test" });

it("skips a milestone an earlier run verified on the board", async () => {
  const ledger = await ledgerWith([]);
  const goal = board();
  const plan = (await goal.plan())!;
  const r1 = plan.requirements!.find((item) => item.id === "R1")!;
  r1.verdict = { result: "shown", note: "e2e", at: "now" };
  const { port, calls } = planner({
    plans: [{ tasks: [planned("Stars", "R2")], verdicts: [], complete: false }],
  });
  const idle = goalDriver({ planner: port, board: goal, ledger, checks: [], checkpoint: "notify" });
  await idle(await ledger.state(), new AbortController().signal);
  expect(calls).toEqual(["plan M2"]);
  // An advisory verdict does not close a milestone.
  r1.verdict = { result: "shown", note: "e2e", at: "now", advisory: true };
  const second = planner({ reviews: [{ tasks: [], verdicts: [shown("R1")], complete: true }] });
  const again = goalDriver({
    planner: second.port,
    board: goal,
    ledger: await ledgerWith(["T1"]),
    checks: [],
    checkpoint: "notify",
  });
  await again(await (await ledgerWith(["T1"])).state(), new AbortController().signal);
  expect(second.calls[0]).toBe("review M1");
});

it("reviews a finished milestone, then plans the next one", async () => {
  const ledger = await ledgerWith(["T1"]);
  const goal = board();
  const { port, calls } = planner({
    reviews: [{ tasks: [], verdicts: [shown("R1")], complete: true }],
    plans: [{ tasks: [planned("Stars", "R2")], verdicts: [], complete: false }],
  });
  const idle = goalDriver({ planner: port, board: goal, ledger, checks: [], checkpoint: "notify" });
  const answer = await idle(await ledger.state(), new AbortController().signal);
  expect(calls).toEqual(["review M1", "plan M2"]);
  expect("cases" in answer && answer.cases.map((item) => [item.id, item.milestoneId])).toEqual([
    ["T-Stars", "M2"],
  ]);
  expect(goal.verdicts).toEqual([{ id: "R1", advisory: false }]);
  const state = await ledger.state();
  expect(autoProgressView(state, new Date())).toContain("Milestones: M1 verified · M2 planned");
  expect(state.milestones?.map((item) => [item.id, item.stage, item.reviews])).toEqual([
    ["M1", "done", 1],
    ["M2", "planned", 0],
  ]);
});

it("chases gaps, and stops for the owner when reviews run out", async () => {
  const ledger = await ledgerWith(["T1"]);
  const goal = board();
  const partly = { requirementId: "R1", result: "partly" as const, note: "no test drives import" };
  const { port } = planner({
    reviews: [
      { tasks: [planned("Import test", "R1")], verdicts: [partly], complete: false },
      { tasks: [], verdicts: [partly], complete: false },
    ],
  });
  const idle = goalDriver({
    planner: port,
    board: goal,
    ledger,
    checks: [],
    checkpoint: "notify",
    maxReviews: 2,
  });
  const first = await idle(await ledger.state(), new AbortController().signal);
  expect("cases" in first && first.cases.map((item) => item.title)).toEqual(["Import test"]);
  const second = await idle(await ledger.state(), new AbortController().signal);
  expect(second).toEqual({
    end: {
      outcome: "blocked_for_input",
      reason: "M1 still has gaps after 2 reviews (R1): Autopilot needs you to look.",
    },
  });
});

it("waits at a milestone when asked, and ends when every milestone is verified", async () => {
  const ledger = await ledgerWith(["T1"]);
  const { port } = planner({ reviews: [{ tasks: [], verdicts: [shown("R1")], complete: true }] });
  const idle = goalDriver({
    planner: port,
    board: board(),
    ledger,
    checks: [],
    checkpoint: "wait",
  });
  expect(await idle(await ledger.state(), new AbortController().signal)).toEqual({
    end: {
      outcome: "cancelled_after_checkpoint",
      reason: "M1 is done; Autopilot waits for you at each milestone. Resume to go on to M2.",
    },
  });
  await ledger.append({ type: "milestone_done", milestoneId: "M2" });
  expect(await idle(await ledger.state(), new AbortController().signal)).toEqual({
    end: { outcome: "objective_met", reason: "every milestone verified (M1, M2)" },
  });
});

it("gives an advisory review's gaps one round of tasks, then closes the milestone listing them", async () => {
  const ledger = await ledgerWith(["T1"]);
  const goal = board();
  const { port, calls } = planner({
    reviews: [
      {
        tasks: [planned("Import test", "R1")],
        verdicts: [{ requirementId: "R1", result: "not shown", note: "no test" }],
        complete: false,
      },
    ],
    plans: [{ tasks: [planned("Stars", "R2")], verdicts: [], complete: false }],
  });
  const idle = goalDriver({
    planner: port,
    board: goal,
    ledger,
    checks: [],
    checkpoint: "notify",
    advisory: true,
  });
  // The review's gap task runs first.
  const first = await idle(await ledger.state(), new AbortController().signal);
  expect("cases" in first && first.cases.map((item) => item.title)).toEqual(["Import test"]);
  // Its round done, the milestone closes with what is still not shown, and M2 is planned.
  await idle(await ledger.state(), new AbortController().signal);
  expect(calls).toEqual(["review M1", "plan M2"]);
  expect(goal.tasksNow.map((task) => task.title)).toEqual(["Import", "Import test", "Stars"]);
  expect((await ledger.state()).milestones?.[0]).toMatchObject({ stage: "done", gaps: ["R1"] });
  expect(goal.verdicts).toEqual([{ id: "R1", advisory: true }]);
});

it("waits out a Planner that cannot reach Poundlock", async () => {
  const ledger = await ledgerWith(["T1"]);
  const { port, calls } = planner({
    failFirst: 2,
    reviews: [{ tasks: [], verdicts: [shown("R1")], complete: true }],
  });
  const idle = goalDriver({
    planner: port,
    board: board(),
    ledger,
    checks: [],
    checkpoint: "wait",
    waitsMs: [0, 0, 0],
    isUnavailable: (error) => /fetch failed/.test(String(error)),
    sleep: async () => undefined,
  });
  expect(await idle(await ledger.state(), new AbortController().signal)).toMatchObject({
    end: { outcome: "cancelled_after_checkpoint" },
  });
  expect(calls).toEqual(["review M1"]);
});

it("waits out a busy model longer than the unavailable ladder", async () => {
  const ledger = await ledgerWith(["T1"]);
  const { port, calls } = planner({
    failFirst: 6,
    failWith: "Poundlock capacity_in_use wait exhausted.",
    reviews: [{ tasks: [], verdicts: [shown("R1")], complete: true }],
  });
  const idle = goalDriver({
    planner: port,
    board: board(),
    ledger,
    checks: [],
    checkpoint: "wait",
    waitsMs: [0, 0],
    isUnavailable: () => true,
    sleep: async () => undefined,
  });
  expect(await idle(await ledger.state(), new AbortController().signal)).toMatchObject({
    end: { outcome: "cancelled_after_checkpoint" },
  });
  expect(calls).toEqual(["review M1"]);
});

it("reviews past the usual limit while each review finds new work accepted", async () => {
  const ledger = await ledgerWith(["T1"]);
  const partly = { requirementId: "R1", result: "partly" as const, note: "more to do" };
  // Three reviews, the last when nothing of M1 was accepted yet.
  for (let i = 0; i < 3; i++)
    await ledger.append({
      type: "milestone_review",
      milestoneId: "M1",
      complete: false,
      verdicts: [partly],
      tasks: [],
      accepted: 0,
    });
  const { port, calls } = planner({
    reviews: [{ tasks: [], verdicts: [shown("R1")], complete: true }],
  });
  const idle = goalDriver({
    planner: port,
    board: board(),
    ledger,
    checks: [],
    checkpoint: "wait",
  });
  // T1 was accepted since the third review: a fourth review runs instead of stopping.
  await idle(await ledger.state(), new AbortController().signal);
  expect(calls).toEqual(["review M1"]);
});

it("still stops at the usual limit when the last review found nothing new accepted", async () => {
  const ledger = await ledgerWith(["T1"]);
  const partly = { requirementId: "R1", result: "partly" as const, note: "more to do" };
  for (let i = 0; i < 3; i++)
    await ledger.append({
      type: "milestone_review",
      milestoneId: "M1",
      complete: false,
      verdicts: [partly],
      tasks: [],
      accepted: 1,
    });
  const { port, calls } = planner({});
  const idle = goalDriver({
    planner: port,
    board: board(),
    ledger,
    checks: [],
    checkpoint: "wait",
  });
  expect(await idle(await ledger.state(), new AbortController().signal)).toMatchObject({
    end: { outcome: "blocked_for_input" },
  });
  expect(calls).toEqual([]);
});

it("shows the first review why the last run left tasks unfinished", async () => {
  const ledger = await ledgerWith(["T1"]);
  let seen: string[] = [];
  const port: PlannerPort = {
    planMilestone: async () => ({ tasks: [], verdicts: [], complete: false }),
    decideFrozenTests: async () => ({ tasks: [], verdicts: [], complete: false }),
    reviewMilestone: async (input) => {
      seen = input.unfinished ?? [];
      return { tasks: [], verdicts: [shown("R1")], complete: true };
    },
  };
  const idle = goalDriver({
    planner: port,
    board: board(),
    ledger,
    checks: [],
    checkpoint: "wait",
    carriedOver: ["Restore focus (abandoned: check … [frozen test failing: src/grid.test.tsx])"],
  });
  await idle(await ledger.state(), new AbortController().signal);
  expect(seen).toEqual([
    "from the last run: Restore focus (abandoned: check … [frozen test failing: src/grid.test.tsx])",
  ]);
});

it("stops the goal when the Planner reaches its spend cap", async () => {
  const ledger = await ledgerWith(["T1"]);
  const { port, calls } = planner({
    reviews: [{ tasks: [], verdicts: [shown("R1")], complete: true, costUsd: 3.5 }],
    plans: [{ tasks: [planned("Stars", "R2")], verdicts: [], complete: false, costUsd: 2 }],
  });
  const idle = goalDriver({
    planner: port,
    board: board(),
    ledger,
    checks: [],
    checkpoint: "notify",
    spendCapUsd: 5,
  });
  // Under the cap: it reviews M1 and plans M2, and the ledger keeps what each cost.
  expect("cases" in (await idle(await ledger.state(), new AbortController().signal))).toBe(true);
  expect((await ledger.state()).plannerUsd).toBe(5.5);
  expect(await idle(await ledger.state(), new AbortController().signal)).toEqual({
    end: {
      outcome: "limit_reached_without_accepted_work",
      reason: "the Planner has cost about $5.50, the goal's $5.00 cap",
    },
  });
  expect(calls).toEqual(["review M1", "plan M2"]);
});

it("never calls the Planner again once the owner stops during its wait", async () => {
  const ledger = await ledgerWith(["T1"]);
  const { port, calls } = planner({ failFirst: 5 });
  const stop = new AbortController();
  const idle = goalDriver({
    planner: port,
    board: board(),
    ledger,
    checks: [],
    checkpoint: "notify",
    waitsMs: [0, 0, 0],
    isUnavailable: () => true,
    sleep: async () => stop.abort(),
  });
  await expect(idle(await ledger.state(), stop.signal)).rejects.toThrow(/stopped by the owner/);
  // One failed review, then the wait was cut short: no second call.
  expect(calls).toEqual([]);
});

it("counts what a failed Planner call cost toward the cap", async () => {
  const ledger = await ledgerWith(["T1"]);
  const failing: PlannerPort = {
    planMilestone: async () => ({ tasks: [], verdicts: [], complete: false }),
    decideFrozenTests: async () => ({ tasks: [], verdicts: [], complete: false }),
    reviewMilestone: async () => {
      throw Object.assign(new Error("The Planner did not call submit."), { costUsd: 1.25 });
    },
  };
  const idle = goalDriver({
    planner: failing,
    board: board(),
    ledger,
    checks: [],
    checkpoint: "notify",
  });
  await expect(idle(await ledger.state(), new AbortController().signal)).rejects.toThrow(/submit/);
  expect((await ledger.state()).plannerUsd).toBe(1.25);
});

it("does not call an advisory goal met while gaps remain", async () => {
  const ledger = await ledgerWith(["T1"]);
  await ledger.append({ type: "milestone_done", milestoneId: "M1", gaps: ["R1"] });
  await ledger.append({ type: "milestone_done", milestoneId: "M2" });
  const { port } = planner({});
  const idle = goalDriver({
    planner: port,
    board: board(),
    ledger,
    checks: [],
    checkpoint: "notify",
    advisory: true,
  });
  expect(await idle(await ledger.state(), new AbortController().signal)).toEqual({
    end: {
      outcome: "limit_reached_without_accepted_work",
      reason: "every milestone closed after one advisory review; not shown: R1",
    },
  });
});

it("tells the review which of the milestone's tasks did not finish", async () => {
  const ledger = await ledgerWith(["T1"]);
  const goal = board();
  goal.tasksNow.push({
    id: "T2",
    title: "Grid to Loupe",
    milestoneId: "M1",
    status: "ready",
    dependsOn: [],
  } as unknown as TaskRecord);
  await ledger.append({
    type: "cases_added",
    cases: [
      { id: "T2", title: "Grid to Loupe", objective: "o", acceptanceCriteria: "a", dependsOn: [] },
    ],
  });
  await ledger.append({
    type: "case_abandoned",
    caseId: "T2",
    reason: "case allowance of 60 min used",
  });
  let seen: string[] | undefined;
  const port: PlannerPort = {
    planMilestone: async () => ({ tasks: [], verdicts: [], complete: false }),
    decideFrozenTests: async () => ({ tasks: [], verdicts: [], complete: false }),
    reviewMilestone: async (input) => {
      seen = input.unfinished;
      return { tasks: [planned("Grid to Loupe, smaller", "R1")], verdicts: [], complete: false };
    },
  };
  const idle = goalDriver({ planner: port, board: goal, ledger, checks: [], checkpoint: "notify" });
  await idle(await ledger.state(), new AbortController().signal);
  expect(seen).toEqual(["Grid to Loupe (abandoned: case allowance of 60 min used)"]);
});

it("hands a review only the tasks that ended since the last one, and lets it close", async () => {
  const ledger = await ledgerWith(["T1"]);
  const goal = board();
  const task = (id: string, title: string) =>
    ({ id, title, milestoneId: "M1", status: "ready", dependsOn: [] }) as unknown as TaskRecord;
  goal.tasksNow.push(task("T2", "Folders e2e"));
  const added = (id: string, title: string) =>
    ledger.append({
      type: "cases_added",
      cases: [{ id, title, objective: "o", acceptanceCriteria: "a", dependsOn: [] }],
    });
  await added("T2", "Folders e2e");
  await ledger.append({ type: "case_abandoned", caseId: "T2", reason: "case allowance used" });
  // The first review saw T2 and planned T3, which was accepted; T4 found its
  // work already in the code.
  await ledger.append({
    type: "milestone_review",
    milestoneId: "M1",
    complete: false,
    verdicts: [{ requirementId: "R1", result: "partly", note: "e2e missing" }],
    tasks: ["Folders e2e, smaller"],
    accepted: 1,
  });
  goal.tasksNow.push(task("T3", "Folders e2e, smaller"), task("T4", "Folders e2e again"));
  await added("T3", "Folders e2e, smaller");
  await ledger.append({ type: "case_accepted", caseId: "T3" });
  await added("T4", "Folders e2e again");
  await ledger.append({ type: "case_repair", caseId: "T4", reason: "no changes" });
  await ledger.append({ type: "case_abandoned", caseId: "T4", reason: "no changes" });
  let seen: string[] | undefined;
  let unchanged: string[] | undefined;
  const port: PlannerPort = {
    planMilestone: async () => ({ tasks: [], verdicts: [], complete: false }),
    decideFrozenTests: async () => ({ tasks: [], verdicts: [], complete: false }),
    reviewMilestone: async (input) => {
      seen = input.unfinished;
      unchanged = input.unchanged;
      return {
        tasks: [],
        verdicts: [{ requirementId: "R1", result: "shown", note: "e2e passes" }],
        complete: true,
      };
    },
  };
  const idle = goalDriver({ planner: port, board: goal, ledger, checks: [], checkpoint: "notify" });
  await idle(await ledger.state(), new AbortController().signal);
  expect(seen).toEqual([]);
  // The task that changed nothing is shown apart, for the review to check.
  expect(unchanged).toEqual(["Folders e2e again (abandoned: no changes)"]);
  expect((await ledger.state()).milestones?.find((m) => m.id === "M1")?.stage).toBe("done");
});

it("shows a review the tasks taken on the worker's word as unverified", async () => {
  const ledger = await ledgerWith(["T1"]);
  const goal = board();
  goal.tasksNow.push({
    id: "T2",
    title: "Stacks e2e",
    milestoneId: "M1",
    status: "ready",
    dependsOn: [],
  } as unknown as TaskRecord);
  await ledger.append({
    type: "cases_added",
    cases: [
      { id: "T2", title: "Stacks e2e", objective: "o", acceptanceCriteria: "a", dependsOn: [] },
    ],
  });
  await ledger.append({ type: "case_accepted", caseId: "T2", after: "already_met" });
  let accepted: string[] = [];
  const port: PlannerPort = {
    planMilestone: async () => ({ tasks: [], verdicts: [], complete: false }),
    decideFrozenTests: async () => ({ tasks: [], verdicts: [], complete: false }),
    reviewMilestone: async (input) => {
      accepted = input.accepted;
      return { tasks: [planned("Stacks e2e, really", "R1")], verdicts: [], complete: false };
    },
  };
  const idle = goalDriver({ planner: port, board: goal, ledger, checks: [], checkpoint: "notify" });
  await idle(await ledger.state(), new AbortController().signal);
  expect(accepted.find((line) => line.startsWith("Stacks e2e"))).toContain("unverified");
  const review = (await ledger.read()).find((entry) => entry.event.type === "milestone_review");
  // It is not progress: the review's count leaves it out.
  expect(review?.event).toMatchObject({ accepted: accepted.length - 1 });
});

it("asks the Planner at once which frozen tests the run may change, and counts the cost", async () => {
  const ledger = await ledgerWith([]);
  const { port, calls } = planner({});
  const options = {
    planner: port,
    board: board(),
    ledger,
    checks: [],
    checkpoint: "notify" as const,
  };
  const decide = frozenDecider(options);
  const allowed = await decide(
    {
      title: "Folders API",
      failure: "[frozen test failing: src/catalog.test.ts]",
      tests: ["src/catalog.test.ts"],
    },
    new AbortController().signal,
  );
  expect(calls).toEqual(["frozen M1 src/catalog.test.ts"]);
  expect(allowed).toEqual([{ path: "src/catalog.test.ts", reason: "pins one migration" }]);
  expect((await ledger.state()).plannerUsd).toBeCloseTo(0.1);
  // A Planner that does not gate (the Local tier) never unfreezes a test.
  expect(
    await frozenDecider({ ...options, advisory: true })(
      { title: "t", failure: "f", tests: ["src/catalog.test.ts"] },
      new AbortController().signal,
    ),
  ).toEqual([]);
});
