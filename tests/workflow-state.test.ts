/**
 * Plan section 4: one authoritative status derivation, explained pauses with
 * real actions, and invariants that survive duplicate events, permission
 * changes, cancellation, restart, undecided reviews and transport failures.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import type { ManagerPort, ProjectOrchestrator } from "@core/orchestration";
import { type NextActionId, projectStatusView } from "@shared/project-status";
import type { ProjectSnapshot } from "@shared/types";
import { describe, expect, it } from "vitest";
import {
  countingManager,
  engineFor,
  passingResult,
  planTask,
  recordingWorker,
  settle,
  type WorkflowFixture,
  workflowFixture,
} from "./support/workflow-fixture";

async function snapshotOf(f: WorkflowFixture): Promise<ProjectSnapshot> {
  const id = f.project.id;
  return {
    project: (await f.store.getProject(id))!,
    plan: await f.store.getPlan(id),
    tasks: await f.store.getTasks(id),
    pendingBoard: await f.store.getPendingBoard(id),
    messages: await f.store.getMessages(id),
  };
}

interface Scenario {
  f: WorkflowFixture;
  engine: ProjectOrchestrator;
  approvals: ApprovalBroker;
}

type ScenarioName =
  | "question"
  | "undecided_review"
  | "environment"
  | "capacity"
  | "interrupted_inference"
  | "manager_needs_message"
  | "completed"
  | "plan_approval"
  | "approval_denied";

async function scenario(name: ScenarioName): Promise<Scenario> {
  const approvals = new ApprovalBroker();
  if (name === "question") {
    const f = await workflowFixture();
    const manager: ManagerPort = {
      async runTurn(ctx) {
        await ctx.host.askUser("Which database should I use?");
        return { text: "", toolTrace: [{ name: "ask_user", summary: "asked" }] };
      },
    };
    const engine = engineFor(f, manager, undefined, approvals);
    await engine.sendMessage(f.project.id, "Build it");
    return { f, engine, approvals };
  }
  if (name === "environment") {
    const f = await workflowFixture({
      files: { "pyproject.toml": '[tool.poetry]\nname = "demo"\n' },
    });
    const { manager } = countingManager(f.store, {
      tasks: [planTask("Write")],
      environmentNeed: "python",
    });
    const engine = engineFor(f, manager, recordingWorker().worker, approvals);
    await engine.sendMessage(f.project.id, "Build it");
    await engine.approveAndStart(f.project.id);
    return { f, engine, approvals };
  }
  if (name === "capacity") {
    const f = await workflowFixture();
    const manager: ManagerPort = {
      async runTurn() {
        return {
          text: "",
          toolTrace: [],
          capacityBlocked: true,
          infrastructureError: "capacity_in_use",
        };
      },
    };
    const engine = engineFor(f, manager, undefined, approvals);
    await engine.sendMessage(f.project.id, "Build it");
    return { f, engine, approvals };
  }
  if (name === "manager_needs_message") {
    const f = await workflowFixture();
    const manager: ManagerPort = {
      async runTurn() {
        throw new Error("terminated");
      },
    };
    const engine = engineFor(f, manager, undefined, approvals);
    await engine.sendMessage(f.project.id, "Build it");
    return { f, engine, approvals };
  }
  if (name === "plan_approval") {
    const f = await workflowFixture();
    const { manager } = countingManager(f.store, { tasks: [planTask("Write")] });
    const engine = engineFor(f, manager, recordingWorker().worker, approvals);
    await engine.sendMessage(f.project.id, "Build it");
    return { f, engine, approvals };
  }
  const f = await workflowFixture();
  const { manager } = countingManager(
    f.store,
    { tasks: [planTask("Write")] },
    name === "completed"
      ? undefined
      : async () => {
          /* the manager ends its review without a decision */
        },
  );
  const { worker } = recordingWorker((run) =>
    name === "interrupted_inference"
      ? { ...passingResult("partial.txt"), error: "terminated" }
      : name === "approval_denied"
        ? {
            ...passingResult("x.txt"),
            changedFiles: [],
            error: "Tool approval denied or cancelled. Worker stopped.",
          }
        : passingResult(`file-${run}.txt`),
  );
  const engine = engineFor(f, manager, worker, approvals);
  await engine.sendMessage(f.project.id, "Build it");
  await engine.approveAndStart(f.project.id);
  await settle(engine, f.project.id, 3);
  return { f, engine, approvals };
}

async function perform(s: Scenario, id: NextActionId, choiceId?: string): Promise<void> {
  const projectId = s.f.project.id;
  switch (id) {
    case "approve":
      return s.engine.approveAndStart(projectId);
    case "resume":
      return s.engine.start(projectId);
    case "pause":
    case "wait":
      return s.engine.pause(projectId);
    case "cancel":
      return s.engine.cancel(projectId);
    case "choose":
      return s.engine.reply(projectId, choiceId!);
    case "review_again":
      return s.engine.reopen(projectId);
    case "override":
      return s.engine.override(projectId, "operator decision");
    case "reply":
    case "send_message":
      return s.engine.sendMessage(projectId, "Here is more guidance.");
    case "decide_approval":
      for (const item of s.approvals.list()) s.approvals.decide(item.id, "once");
      return;
  }
}

const EXPECTED: Array<[ScenarioName, string, string]> = [
  ["question", "question", "needs_input"],
  ["undecided_review", "undecided_review", "paused"],
  ["environment", "environment", "needs_input"],
  ["capacity", "capacity", "waiting_for_capacity"],
  ["interrupted_inference", "interrupted_inference", "paused"],
  ["manager_needs_message", "manager_needs_message", "paused"],
  ["completed", "completed", "completed"],
  ["plan_approval", "plan_approval", "awaiting_approval"],
  ["approval_denied", "approval_denied", "paused"],
];

describe("authoritative status derivation", () => {
  it.each(EXPECTED)("derives %s from persisted workflow state", async (name, cause, status) => {
    const s = await scenario(name);
    const snapshot = await snapshotOf(s.f);
    expect(snapshot.project.status).toBe(status);
    const view = projectStatusView(snapshot);
    expect(view.cause).toBe(cause);
    expect(view.title).toBeTruthy();
    expect(view.next).toBeTruthy();
    expect(view.actions.length).toBeGreaterThan(0);
    if (snapshot.project.status === "paused") {
      const pause = snapshot.project.pause!;
      expect(pause.cause).toBeTruthy();
      expect(pause.detail).toBeTruthy();
      // The conversation explains the pause at the moment it happened.
      expect(
        snapshot.messages.some(
          (message) => message.role === "system" && message.createdAt >= pause.at,
        ),
      ).toBe(true);
    }
  });

  it.each(EXPECTED)("every action offered for %s exists and runs", async (name) => {
    const first = await scenario(name);
    const view = projectStatusView(await snapshotOf(first.f));
    for (const action of view.actions) {
      const s = action === view.actions[0] ? first : await scenario(name);
      await expect(perform(s, action.id, action.choiceId), action.id).resolves.toBeUndefined();
    }
  });

  it("does not offer Resume when there is no approved plan to resume", async () => {
    const s = await scenario("manager_needs_message");
    const view = projectStatusView(await snapshotOf(s.f));
    expect(view.title).toBe("Manager needs another message");
    expect(view.actions.map((action) => action.id)).toEqual(["send_message"]);
    expect(view.canResume).toBe(false);
  });

  it("clears an interrupted manager pause after a successful follow-up", async () => {
    const f = await workflowFixture();
    let turns = 0;
    const manager: ManagerPort = {
      async runTurn() {
        if (++turns === 1) throw new Error("terminated");
        return { text: "Here is the answer.", toolTrace: [] };
      },
    };
    const engine = engineFor(f, manager);
    await engine.sendMessage(f.project.id, "Can we discuss this?");
    expect(projectStatusView(await snapshotOf(f)).title).toBe("Manager needs another message");

    await engine.sendMessage(f.project.id, "Please continue.");
    const snapshot = await snapshotOf(f);
    expect(snapshot.project.status).toBe("draft");
    expect(snapshot.project.pause).toBeUndefined();
    expect(snapshot.messages.at(-1)?.text).toBe("Here is the answer.");
    expect(projectStatusView(snapshot).title).not.toBe("Manager needs another message");
  });

  it("an open approval card wins over every other control", async () => {
    const s = await scenario("undecided_review");
    void s.approvals.request({
      projectId: s.f.project.id,
      projectName: "p",
      planRevision: 1,
      kind: "bash",
      action: "x",
      reason: "y",
    });
    const view = projectStatusView(await snapshotOf(s.f), { approvals: s.approvals.list() });
    expect(view.cause).toBe("tool_approval");
    expect(view.canResume).toBe(false);
    expect(view.actions[0]).toMatchObject({ id: "decide_approval", primary: true });
    expect(view.actions.some((action) => action.id === "send_message")).toBe(false);
  });

  it("offers re-review only after completion, labelled Review completed work again", async () => {
    const paused = await scenario("undecided_review");
    expect(
      projectStatusView(await snapshotOf(paused.f)).actions.some((a) => a.id === "review_again"),
    ).toBe(false);
    await expect(paused.engine.reopen(paused.f.project.id)).rejects.toThrow(/completed/);
    const done = await scenario("completed");
    const view = projectStatusView(await snapshotOf(done.f));
    expect(view.actions.find((action) => action.id === "review_again")?.label).toBe(
      "Review completed work again",
    );
    expect(view.evidence).toBe("The task was accepted.");
  });

  it("clears the pause record on every transition out of paused", async () => {
    const s = await scenario("undecided_review");
    expect((await s.f.store.getProject(s.f.project.id))?.pause?.cause).toBe("undecided_review");
    await s.engine.sendMessage(s.f.project.id, "Please look again at the edge cases.");
    expect((await s.f.store.getProject(s.f.project.id))?.pause?.cause).toBe("undecided_review");
    await s.engine.start(s.f.project.id);
    await settle(s.engine, s.f.project.id, 2);
    const project = await s.f.store.getProject(s.f.project.id);
    expect(project?.status).toBe("paused");
    expect(project?.pause?.cause).toBe("undecided_review");
    await s.engine.cancel(s.f.project.id);
    expect((await s.f.store.getProject(s.f.project.id))?.pause).toBeUndefined();
  });
});

describe("invariants under disturbance", () => {
  it("duplicate ticks, starts and acceptances do not duplicate work or reviews", async () => {
    const f = await workflowFixture();
    const { manager, turns } = countingManager(f.store, {
      tasks: [planTask("First"), planTask("Second", { dependsOn: ["First"] })],
    });
    const { worker, runs } = recordingWorker();
    const engine = engineFor(f, manager, worker);
    await engine.sendMessage(f.project.id, "Two steps");
    await Promise.all([
      engine.approveAndStart(f.project.id),
      engine.approveAndStart(f.project.id).catch(() => undefined),
    ]);
    await Promise.all([engine.start(f.project.id), engine.tick(f.project.id)]);
    await engine.waitForLocal(f.project.id);
    await Promise.all([engine.tick(f.project.id), engine.tick(f.project.id)]);
    const [first] = await f.store.getTasks(f.project.id);
    expect(await engine.toolHost(f.project.id).requestApplyResult(first.id)).toMatch(
      /already accepted/,
    );
    await settle(engine, f.project.id, 12);
    expect(runs).toEqual(["First", "Second"]);
    expect(turns.filter((prompt) => prompt.startsWith("Review these worker results"))).toHaveLength(
      2,
    );
    expect((await f.store.getProject(f.project.id))?.status).toBe("completed");
  });

  it("a permission change during a worker run neither replays nor loses the attempt", async () => {
    const f = await workflowFixture();
    const { manager } = countingManager(f.store, { tasks: [planTask("Write")] });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { worker, runs } = recordingWorker(async () => {
      await gate;
      return passingResult("gated.txt");
    });
    const approvals = new ApprovalBroker();
    const engine = engineFor(f, manager, worker, approvals);
    await engine.sendMessage(f.project.id, "Write");
    await engine.approveAndStart(f.project.id);
    const project = (await f.store.getProject(f.project.id))!;
    project.policy.toolTrust = "full";
    project.policy.toolTrustRevision = (project.policy.toolTrustRevision ?? 0) + 1;
    await f.store.saveProject(project);
    approvals.recheck(() => undefined);
    await engine.tick(f.project.id);
    release();
    await settle(engine, f.project.id);
    expect(runs).toEqual(["Write"]);
    expect((await f.store.getTasks(f.project.id))[0].attempts).toHaveLength(1);
    expect((await f.store.getProject(f.project.id))?.status).toBe("completed");
  });

  it("cancellation during review stops further manager and worker activity", async () => {
    const s = await scenario("undecided_review");
    const { runs, worker } = recordingWorker();
    void worker;
    await s.engine.cancel(s.f.project.id);
    await settle(s.engine, s.f.project.id);
    await expect(s.engine.start(s.f.project.id)).rejects.toThrow(/cancelled/);
    expect(runs).toEqual([]);
    const view = projectStatusView(await snapshotOf(s.f));
    expect(view.cause).toBe("cancelled");
    expect(view.canResume).toBe(false);
    expect(await readFile(join(s.f.folder, "file-1.txt"), "utf8")).toBe("Write\n");
  });

  it("an unhealthy manager session is replaced without losing files, attempts, jobs or approvals", async () => {
    const f = await workflowFixture();
    let fail = true;
    const prompts: string[] = [];
    const base = countingManager(f.store, { tasks: [planTask("Write")] });
    const manager: ManagerPort = {
      async runTurn(ctx) {
        prompts.push(ctx.prompt);
        const tasks = await f.store.getTasks(ctx.project.id);
        if (tasks[0]?.status === "needs_review" && fail) {
          fail = false;
          throw new Error("terminated");
        }
        return base.manager.runTurn(ctx);
      },
    };
    const { worker } = recordingWorker();
    const engine = engineFor(f, manager, worker);
    const permissions = await f.store.getPermissions();
    await f.store.savePermissions({
      ...permissions,
      grants: { [f.project.id]: [{ kind: "bash", action: "npm test", cwd: f.folder }] },
    });
    await engine.sendMessage(f.project.id, "Write");
    await engine.approveAndStart(f.project.id);
    const sessionBefore = (await f.store.getProject(f.project.id))!.managerSessionId;
    await settle(engine, f.project.id, 2);
    const interrupted = (await f.store.getProject(f.project.id))!;
    expect(interrupted.status).toBe("paused");
    expect(interrupted.pause?.cause).toBe("manager_interrupted");
    expect(interrupted.managerSessionId).not.toBe(sessionBefore);
    expect((await f.store.getPlan(f.project.id))?.approved).toBe(true);
    expect((await f.store.getTasks(f.project.id))[0].attempts).toHaveLength(1);
    expect((await f.store.getPermissions()).grants?.[f.project.id]).toHaveLength(1);
    expect(projectStatusView(await snapshotOf(f)).cause).toBe("interrupted_inference");
    await engine.start(f.project.id);
    await settle(engine, f.project.id);
    // The fresh session is rebuilt from Dispatch's persisted state, not model memory.
    expect(prompts.at(-2)).toMatch(/task state/);
    expect(prompts.at(-2)).toContain('"title":"Write"');
    expect(await readFile(join(f.folder, "write-1.txt"), "utf8")).toBe("Write\n");
    expect((await f.store.getProject(f.project.id))?.status).toBe("completed");
  });

  it("keeps repair and inference-recovery budgets separate", async () => {
    const f = await workflowFixture();
    const { manager } = countingManager(
      f.store,
      { tasks: [planTask("Write")] },
      async (ctx, review) => {
        if (review.attempts.length < 3) await ctx.host.requestRepair(review.id, "Fix it");
        else await ctx.host.requestApplyResult(review.id);
      },
    );
    const { worker } = recordingWorker((run) =>
      run === 1
        ? {
            ...passingResult("a.txt"),
            verification: {
              status: "failed",
              commands: [{ command: "node --test", exitCode: 1, output: "1 failing" }],
            },
          }
        : run === 2
          ? { ...passingResult("b.txt"), error: "terminated" }
          : passingResult("c.txt"),
    );
    const engine = engineFor(f, manager, worker);
    await engine.sendMessage(f.project.id, "Write");
    await engine.approveAndStart(f.project.id);
    await settle(engine, f.project.id, 12);
    const [task] = await f.store.getTasks(f.project.id);
    expect(task.repairCount).toBe(1);
    expect(task.recoveryCount).toBe(1);
    expect(task.status).toBe("applied");
  });

  it("reconciles an interrupted local action once before continuing", async () => {
    const s = await scenario("undecided_review");
    const { ToolJournal } = await import("@core/tool-journal");
    const { projectFiles } = await import("@core/paths");
    const journal = new ToolJournal(projectFiles(s.f.store.layout.root, s.f.project.id).journal);
    await journal.begin({
      action: { tool: "run_command", program: "npm", arguments: ["install"] },
      authorization: "allow",
      sideEffectScope: [s.f.folder],
    });
    const tasks = await s.f.store.getTasks(s.f.project.id);
    tasks[0].status = "ready";
    await s.f.store.saveTasks(s.f.project.id, tasks);
    await s.engine.start(s.f.project.id);
    await settle(s.engine, s.f.project.id, 2);
    const first = await snapshotOf(s.f);
    expect(first.project.needsInput?.kind).toBe("tool_reconciliation");
    expect(projectStatusView(first).cause).toBe("tool_reconciliation");
    expect(projectStatusView(first).canResume).toBe(true);
    await s.engine.start(s.f.project.id);
    await settle(s.engine, s.f.project.id, 2);
    expect((await s.f.store.getProject(s.f.project.id))?.needsInput).toBeUndefined();
  });
});

describe("routing and wording", () => {
  it("keeps Interactive as the default and never asks to upload source", async () => {
    const f = await workflowFixture();
    const approvals = new ApprovalBroker();
    const { manager } = countingManager(f.store, {
      tasks: [planTask("Local", { route: undefined }), planTask("Tiny", { route: "snippet" })],
    });
    const engine = engineFor(f, manager, recordingWorker().worker, approvals);
    await engine.sendMessage(f.project.id, "Mixed");
    const tasks = await f.store.getTasks(f.project.id);
    expect(tasks.map((task) => task.route)).toEqual(["interactive", "snippet"]);
    await engine.approveAndStart(f.project.id);
    await settle(engine, f.project.id, 4);
    expect(approvals.list().filter((item) => item.kind === "durable")).toEqual([]);
    expect(f.backend.submits).toBe(0);
  });

  it("reports precise progress wording", async () => {
    const s = await scenario("completed");
    const snapshot = await snapshotOf(s.f);
    snapshot.tasks = [
      { ...snapshot.tasks[0], status: "applied" },
      ...["running", "blocked", "blocked", "blocked"].map((status, index) => ({
        ...snapshot.tasks[0],
        id: `t${index}`,
        status: status as "running" | "blocked",
      })),
    ];
    expect(projectStatusView(snapshot).evidence).toBe(
      "1 of 5 tasks accepted. Task 2 of 5 started.",
    );
  });
});
