import type { AutopilotView, CaseStage } from "@shared/auto-run";
import {
  autopilotArrivals,
  autopilotCard,
  autopilotCardLines,
  autopilotGlance,
  autopilotHoldsProject,
  autopilotMessageHint,
  autopilotOwnsStatus,
  autopilotResumable,
  autopilotTakesMessages,
  dollars,
  limitText,
} from "@shared/autopilot-card";
import { autopilotDetails, autopilotDetailsSummary } from "@shared/autopilot-details";
import { autopilotStartPreview } from "@shared/autopilot-start";
import { autopilotBoard, taskStage } from "@shared/task-view";
import type { AppStateView, Requirement, TaskRecord } from "@shared/types";
import { expect, it } from "vitest";

const now = new Date("2026-10-27T06:00:00Z");

function view(stages: CaseStage[], extra: Partial<AutopilotView> = {}): AutopilotView {
  return {
    runId: "auto-1",
    runDir: "/runs/auto-1",
    phase: "running",
    lines: [],
    cases: stages.map((stage, index) => ({
      id: `T${index + 1}`,
      title: `Task ${index + 1}`,
      stage,
    })),
    branch: "auto/auto-1",
    mirror: "/m.git",
    baseCommit: "0".repeat(40),
    image: "toolchain:test",
    model: "worker",
    workingCopy: true,
    startedAt: "2026-10-27T03:46:00Z",
    softHours: 24,
    plannerUsd: 0.82,
    plannerCapUsd: 10,
    ...extra,
  };
}

const requirement = (id: string, result?: "shown" | "partly" | "not shown"): Requirement => ({
  id,
  text: `Requirement ${id}`,
  scenarios: [],
  status: "open",
  ...(result ? { verdict: { result, note: `${id} evidence`, at: "now" } } : {}),
});

it("shows a running build's progress, meters and current task", () => {
  const card = autopilotCard(
    view(["accepted", "accepted", "running", "pending"], {
      current: { title: "Tiled stacking", attempt: 2 },
      activity: "running checks",
    }),
    [requirement("R1", "shown"), requirement("R2")],
    now,
    undefined,
    3.1,
  );
  expect(card).toMatchObject({
    tone: "active",
    headline: "Building",
    summary: "2 of 4 tasks verified",
    time: { minutes: 134, limitHours: 24 },
    plannerSpend: { usd: 0.82, capUsd: 10 },
    weekUsd: 3.1,
    now: "Tiled stacking · attempt 2 · running checks",
    needsYou: [],
  });
  expect(card.requirements.map((item) => item.verdict)).toEqual(["shown", "not_reviewed"]);
  expect(autopilotCardLines(card).join("\n")).toContain("Last 7 days $3.10");
});

it("names a finished build's gaps from the Planner's verdicts, and what needs the owner", () => {
  const ended = view(["accepted", "accepted", "accepted"], {
    phase: "ended",
    outcome: "objective_met",
    endedAt: "2026-10-27T08:37:00Z",
  });
  const requirements = [requirement("R1", "shown"), requirement("R2", "not shown")];
  const card = autopilotCard(ended, requirements, now);
  expect(card.tone).toBe("gaps");
  expect(card.headline).toBe("Built, 1 gap");
  expect(card.summary).toMatch(/^Ended .* · 4 h 51 m · \$0\.82$/);
  expect(card.needsYou).toEqual(["R2 Requirement R2: R2 evidence"]);
  expect(card.built).toEqual([
    "3 of 3 tasks verified by the checks",
    "1 of 2 requirements shown by the Planner",
  ]);
  expect(card.now).toBeUndefined();
  // Every requirement shown: built, with nothing left for the owner.
  expect(
    autopilotCard(ended, [requirement("R1", "shown"), requirement("R2", "shown")], now),
  ).toMatchObject({ tone: "done", headline: "Built", needsYou: [] });
  // Never reviewed is not a gap: a flat plan had no Planner at all.
  expect(autopilotCard(ended, [requirement("R1"), requirement("R2")], now).headline).toBe(
    "Built, not reviewed",
  );
});

it("says why a run that ended short stopped", () => {
  const limited = view(["accepted", "pending"], {
    phase: "ended",
    outcome: "limit_reached_with_accepted_work",
    endReason: "8 h hard limit reached",
    endedAt: "2026-10-27T08:37:00Z",
  });
  const card = autopilotCard(limited, [], now);
  expect(card).toMatchObject({ tone: "stopped", why: "8 h hard limit reached" });
  expect(autopilotCardLines(card)).toContain("Why it stopped: 8 h hard limit reached");
  const met = view(["accepted"], { phase: "ended", outcome: "objective_met", endReason: "done" });
  expect(autopilotCard(met, [], now).why).toBeUndefined();
});

it("asks for the owner when the runner stopped, and glances in a few words", () => {
  const paused = view(["accepted", "pending"], { phase: "interrupted" });
  expect(autopilotCard(paused, [], now)).toMatchObject({
    tone: "needs_you",
    headline: "Paused",
    needsYou: [expect.stringContaining("Its runner stopped")],
  });
  expect(autopilotGlance(view(["accepted", "running", "pending"]), [])).toEqual({
    label: "Building 1/3",
    tone: "active",
  });
  expect(autopilotGlance(paused, [])).toEqual({ label: "Paused", tone: "needs_you" });
});

it("alerts once, when a run stops building, never for one already ended", () => {
  const building = { label: "Building 3/9", tone: "active" as const };
  const built = { label: "Built, 1 gap", tone: "gaps" as const };
  expect(autopilotArrivals({ p1: building, p2: built }, { p1: built, p2: built })).toEqual([
    { projectId: "p1", glance: built },
  ]);
  expect(autopilotArrivals({}, { p1: built })).toEqual([]);
  expect(autopilotArrivals({ p1: built }, { p1: built })).toEqual([]);
});

it("hands the composer to a run from preparing until it ends, with a hint for each", () => {
  expect(
    (["preparing", "running", "interrupted", "ended", undefined] as const).map(
      autopilotHoldsProject,
    ),
  ).toEqual([true, true, true, false, false]);
  expect(autopilotMessageHint("running")).toContain("the worker hears it now");
  expect(autopilotMessageHint("interrupted")).toContain("when you resume");
});

it("takes the owner's words while it holds the project or waits on their answer, and puts the question on the card", () => {
  const ended = (outcome: AutopilotView["outcome"], extra: Partial<AutopilotView> = {}) =>
    view(["accepted", "blocked"], { phase: "ended", outcome, ...extra });
  expect(
    [
      view(["running"]),
      view(["pending"], { phase: "interrupted" }),
      ended("blocked_for_input"),
      ended("blocked_for_input", { dropped: true }),
      ended("cancelled_after_checkpoint"),
      ended("objective_met"),
      undefined,
    ].map(autopilotTakesMessages),
  ).toEqual([true, true, true, false, false, false, false]);
  expect(autopilotMessageHint("ended")).toContain("reads your answer when you resume");
  const blocked = ended("blocked_for_input", {
    endReason: "A task needs the owner's answer before work can go on.",
  });
  blocked.cases[1].reason = "The loupe view needs a decision: where does the rating control go?";
  expect(autopilotCard(blocked, [], now).needsYou).toContain(
    "Task 2: The loupe view needs a decision: where does the rating control go?",
  );
});

it("stops a paused run's clock at its last event, prints a $0.50 cap as it is, and resumes only what can go on", () => {
  // UX review, 30 Oct: a run paused overnight showed 14 h of 24 h after about 2 h of work;
  // a $0.50 cap showed as $1; Resume on a run past its limit stopped again at once.
  const paused = view(["accepted"], {
    phase: "interrupted",
    startedAt: "2026-10-27T03:00:00Z",
    lastEventAt: "2026-10-27T05:00:00Z",
  });
  expect(autopilotCard(paused, [], new Date("2026-10-27T17:00:00Z")).time?.minutes).toBe(120);
  const capped = autopilotCard(
    view(["accepted"], { plannerUsd: 0.27, plannerCapUsd: 0.5 }),
    [],
    now,
  );
  expect(autopilotCardLines(capped).join("\n")).toContain("Planner $0.27 of $0.50");
  expect(dollars(10)).toBe("10");
  const ended = (outcome: AutopilotView["outcome"]) =>
    view(["accepted"], { phase: "ended", outcome });
  expect(
    [
      paused,
      ended("blocked_for_input"),
      ended("cancelled_after_checkpoint"),
      ended("limit_reached_with_accepted_work"),
      ended("objective_met"),
      undefined,
    ].map(autopilotResumable),
  ).toEqual([true, true, true, false, false, false]);
});

it("shows a stop the owner asked for on the card's face", () => {
  expect(autopilotCard(view(["running"], { stopRequested: "after_case" }), [], now).headline).toBe(
    "Stopping after this task",
  );
  expect(autopilotCard(view(["running"], { stopRequested: "now" }), [], now).headline).toBe(
    "Stopping now",
  );
});

it("gives the run card's Details the same words in the app and the terminal", () => {
  const stopping = view(["accepted", "abandoned"], {
    stopRequested: "after_case",
    goal: { planner: "sonnet-5.5", advisory: true } as AutopilotView["goal"],
  });
  stopping.cases[1].reason = "case allowance of 90 min used";
  const details = autopilotDetails(stopping);
  expect(details.cases.map((item) => item.label)).toEqual(["verified", "abandoned"]);
  expect(details.cases[1].reason).toBe("case allowance of 90 min used");
  expect(autopilotDetailsSummary(details)).toBe(
    "Stopping after this task. Verified means the checks passed. The work is on branch auto/auto-1; nothing is applied to your folder until you merge it. Planner: sonnet-5.5 (advising only).",
  );
  expect(
    autopilotDetails(view(["running"], { phase: "ended", stopRequested: "now" })).stopping,
  ).toBeUndefined();
});

it("groups a board Autopilot builds by milestone, setting aside what did not finish", () => {
  const task = (id: string, milestoneId: string, status: TaskRecord["status"] = "ready") =>
    ({ id, title: id, milestoneId, status, attempts: [], dependsOn: [] }) as unknown as TaskRecord;
  const tasks = [
    task("T1", "M1"),
    task("T2", "M1"),
    task("old", "M1", "applied"),
    task("gone", "M1", "blocked"),
    task("T3", "M2"),
  ];
  const milestones = [
    { id: "M1", title: "Core" },
    { id: "M2", title: "Pages" },
  ] as Parameters<typeof autopilotBoard>[1];
  const run = view(["accepted", "abandoned", "running"], { board: true });
  run.cases[2].id = "T3";
  const board = autopilotBoard(tasks, milestones, run);
  expect(board?.groups.map((group) => [group.title, group.verified, group.total])).toEqual([
    ["M1 · Core", 2, 2],
    ["M2 · Pages", 0, 1],
  ]);
  expect(board?.groups[0].unfinished.map((item) => item.id)).toEqual(["T2", "gone"]);
  expect(taskStage(tasks[2], board!.stages)).toBeUndefined();
  expect(taskStage(tasks[0], board!.stages)).toBe("accepted");
  expect(autopilotBoard(tasks, milestones, view(["accepted"]))).toBeUndefined();
});

it("offers Build with Autopilot the same way in the app and the terminal", () => {
  const state = {
    autopilot: { image: "toolchain:1" },
    connection: { roles: {} },
  } as unknown as AppStateView;
  const snapshot = (commands: string[], extra: object = {}) =>
    ({
      project: { policy: { verification: { commands } } },
      plan: { approved: true, suggestedChecks: ["cargo test"], milestones: [], requirements: [] },
      tasks: [],
      messages: [],
      ...extra,
    }) as unknown as NonNullable<AppStateView["snapshot"]>;
  expect(autopilotStartPreview(state, snapshot([]))).toEqual({
    approve: false,
    suggestedChecks: ["cargo test"],
    defaultHours: 6,
    defaultImage: "toolchain:1",
  });
  const own = autopilotStartPreview(state, snapshot(["npm test"], { pendingBoard: { plan: {} } }));
  expect(own.suggestedChecks).toBeUndefined();
  expect(own.approve).toBe(true);
});

it("names the Planner the run will use: the project's own worker before the app's", () => {
  // The dialog asked consent for frontier-gpt-sol while the run used the
  // project's own worker as its Planner.
  const state = {
    autopilot: { image: "toolchain:1" },
    connection: {
      roles: {
        interactive: {
          profileId: "frontier-gpt-sol",
          profileName: "frontier-gpt-sol",
          source: "interactive",
        },
      },
    },
    probe: {
      interactiveModels: [
        { id: "frontier-gpt-sol", dataDestination: "external" },
        { id: "vega-qwen", dataDestination: "operator_network" },
      ],
    },
  } as unknown as AppStateView;
  const snapshot = {
    project: { policy: { workerModel: "vega-qwen", verification: { commands: ["npm test"] } } },
    plan: {
      approved: true,
      milestones: [{ id: "M1", title: "Core", goal: "g", requirementIds: ["R1"] }],
      requirements: [{ id: "R1", text: "t", scenarios: ["s"], status: "open" }],
    },
    tasks: [],
    messages: [],
  } as unknown as NonNullable<AppStateView["snapshot"]>;
  expect(autopilotStartPreview(state, snapshot).goal?.planner).toMatchObject({
    name: "vega-qwen",
    external: false,
  });
});

it("reads a run's hour limit as a person would", () => {
  expect(limitText(24)).toBe("24 h");
  expect(limitText(0.5)).toBe("30 m");
  expect(limitText(0.524)).toBe("31 m");
  expect(limitText(1.5)).toBe("1 h 30 m");
});

it("lets Autopilot's card be the project's status while it works or owns the board", () => {
  expect(autopilotOwnsStatus({ phase: "running" }, "next_task")).toBe(true);
  expect(autopilotOwnsStatus({ phase: "preparing" }, undefined)).toBe(true);
  expect(autopilotOwnsStatus({ phase: "ended" }, "ready_to_start")).toBe(true);
  expect(autopilotOwnsStatus({ phase: "ended" }, "next_task")).toBe(false);
  expect(autopilotOwnsStatus(undefined, "ready_to_start")).toBe(false);
});

it("says the task in flight finishes once the time limit passes", () => {
  // A 31 m run went 43 m with nothing on the card to say why.
  const late = autopilotCard(
    view(["accepted", "running"], {
      softHours: 0.5,
      startedAt: new Date(now.getTime() - 43 * 60_000).toISOString(),
      current: { title: "Task 2", attempt: 1 },
    }),
    [],
    now,
  );
  expect(late.now).toBe(
    "Task 2 · attempt 1 · Time limit reached: this task finishes, then the run stops",
  );
  expect(
    autopilotCard(view(["running"], { current: { title: "Task 1", attempt: 1 } }), [], now).now,
  ).toBe("Task 1 · attempt 1");
});
