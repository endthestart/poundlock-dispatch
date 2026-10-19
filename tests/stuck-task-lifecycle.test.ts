import { INTERACTIVE_ATTEMPT_LIMIT_ERROR } from "@core/attempt-limit";
import type { ManagerPort, ProjectOrchestrator } from "@core/orchestration";
import { ScriptedManager } from "@core/scripted-manager";
import { MAX_REPAIRS_PER_TASK } from "@shared/policy-limits";
import { defaultBudget, type ProjectRecord, type TaskRecord } from "@shared/types";
import { describe, expect, it } from "vitest";
import {
  engineFor,
  recordingWorker,
  type WorkflowFixture,
  workflowFixture,
} from "./support/workflow-fixture";

const CHECK = "python3 -m unittest";

/** Every attempt ends with its check failing, as a worker that cannot fix the bug would. */
function failingWorker() {
  return recordingWorker(() => ({
    output: "Tried a fix.",
    changedFiles: ["t.py"],
    patch: "+x",
    verification: {
      status: "failed",
      commands: [{ command: CHECK, exitCode: 1, output: "FAIL: test_it" }],
    },
  }));
}

/** Waits for the worker to finish, then lets the orchestrator act on the result. */
async function round(engine: ProjectOrchestrator, projectId: string): Promise<void> {
  await engine.waitForLocal(projectId);
  await engine.tick(projectId);
}

/** Drives a fresh project to a stuck task by exhausting its fix rounds. */
async function stuckProjectFixture(
  maxRepairsPerTask = MAX_REPAIRS_PER_TASK,
  fixRoundsPerTask?: number,
  difficulty: "small" | "large" = "small",
) {
  const f = await workflowFixture({
    prefix: "dispatch-stuck-",
    policy: {
      verification: { commands: [CHECK], protectedPaths: [] },
      ...(fixRoundsPerTask === undefined ? {} : { fixRoundsPerTask }),
    },
  });
  const { worker, runs } = failingWorker();
  let turns = 0;
  const manager = new ScriptedManager(async (ctx) => {
    turns += 1;
    if (turns === 1) {
      await ctx.host.proposePlan({
        summary: "Failing checks",
        acceptanceCriteria: ["tests pass"],
        tasks: [
          {
            title: "Broken",
            objective: "fix",
            workerPrompt: "fix",
            acceptanceCriteria: "tests pass",
            difficulty,
            route: "interactive",
          },
        ],
      });
      return "plan";
    }
    const tasks = await f.store.getTasks(ctx.project.id);
    try {
      return await ctx.host.requestRepair(tasks[0].id, "The check failed. Re-run the worker.");
    } catch (error) {
      // An oversized task's first failure suggests a split; repairing anyway is allowed.
      if (!/If what is left is several pieces of work, split it/.test(String(error))) throw error;
      return ctx.host.requestRepair(tasks[0].id, "Repair it as it is.");
    }
  });
  const orchestrator = engineFor(f, manager, worker);
  await orchestrator.sendMessage(f.project.id, "Fix tests");
  await orchestrator.approvePlan(f.project.id);
  await orchestrator.start(f.project.id);
  for (let index = 0; index < maxRepairsPerTask + 1; index += 1)
    await round(orchestrator, f.project.id);
  const task = (await f.store.getTasks(f.project.id))[0];
  if (!task.stuck) throw new Error("fixture did not reach a stuck task");
  return { f, store: f.store, runs, worker, orchestrator, project: f.project, task };
}

describe("retryTask", () => {
  it("gives a stuck task a fresh fix-round allowance, keeps attempt history, and restarts work", async () => {
    const { store, runs, orchestrator, project, task } = await stuckProjectFixture();
    const runsBeforeRetry = runs.length;
    const attemptsBeforeRetry = task.attempts.length;

    await orchestrator.retryTask(project.id, task.id);
    await orchestrator.waitForLocal(project.id);

    const retried = (await store.getTasks(project.id))[0];
    expect(retried.repairCount).toBe(0);
    expect(retried.recoveryCount ?? 0).toBe(0);
    expect(retried.stuck).toBeUndefined();
    // Earlier attempts stay as evidence; retrying does not erase history.
    expect(retried.attempts.length).toBeGreaterThan(attemptsBeforeRetry);
    const savedProject = await store.getProject(project.id);
    expect(savedProject?.status).not.toBe("failed");
    // retryTask dispatches immediately, so the fresh attempt has already run.
    expect(runs.length).toBeGreaterThan(runsBeforeRetry);
  });

  it("rejects retrying a task id that does not exist", async () => {
    const { orchestrator, project } = await stuckProjectFixture();
    await expect(orchestrator.retryTask(project.id, "not-a-real-task")).rejects.toThrow(
      /Unknown task/,
    );
  });
});

describe("sendMessage resets loop counters on a stuck task", () => {
  it("clears the fix-round counter and stuck state as soon as the user replies", async () => {
    const { f, worker, project, task } = await stuckProjectFixture();
    // A manager that only chats back, so the reset made by sendMessage itself
    // (before the manager's own turn runs) can be observed directly.
    const replying = engineFor(f, new ScriptedManager(async () => "Understood."), worker);
    expect(task.stuck).toBeDefined();

    await replying.sendMessage(project.id, "Please use a different approach.");

    const afterReply = (await f.store.getTasks(project.id))[0];
    expect(afterReply.repairCount).toBe(0);
    expect(afterReply.recoveryCount ?? 0).toBe(0);
    expect(afterReply.stuck).toBeUndefined();
  });
});

describe("retryTask after any recorded stop", () => {
  it("clears a stop whose wording is not the legacy budget one", async () => {
    const { f, worker, store, project, task } = await stuckProjectFixture();
    const stopped = (await store.getProject(project.id)) as ProjectRecord;
    stopped.budget.stopReason =
      "The worker-attempt budget is exhausted. Existing changes and results are retained.";
    await store.saveProject(stopped);
    const orchestrator = engineFor(f, new ScriptedManager(async () => "Understood."), worker);

    await orchestrator.retryTask(project.id, task.id);
    await orchestrator.waitForLocal(project.id);

    const after = await store.getProject(project.id);
    expect(after?.budget.stopReason).toBeUndefined();
    expect((await store.getTasks(project.id))[0].repairCount).toBe(0);
  });
});

describe("legacy exhausted-budget dead end", () => {
  it("is rescued by retryTask: the stop clears and the task gets a fresh allowance", async () => {
    const f = await workflowFixture({ prefix: "dispatch-legacy-" });
    const manager = new ScriptedManager(async (ctx) => {
      const tasks = await f.store.getTasks(ctx.project.id);
      const review = tasks.find((item) => item.status === "needs_review");
      if (review) {
        await ctx.host.requestApplyResult(review.id);
        return "Accepted.";
      }
      return "Waiting.";
    });
    const { worker } = recordingWorker();
    const orchestrator = engineFor(f, manager, worker);
    // Simulate the pre-Phase-1 dead end directly: a task failed with a
    // recorded budget-exhausted stop, and the run left paused (for example by
    // Dispatch closing afterward).
    const stuckTask: TaskRecord = {
      id: "t1",
      title: "Audit",
      objective: "Audit",
      workerPrompt: "Audit",
      acceptanceCriteria: "Written",
      dependsOn: [],
      difficulty: "small",
      route: "interactive",
      contextNote: "",
      status: "failed",
      repairCount: 2,
      recoveryCount: 1,
      attempts: [],
    };
    await f.store.saveTasks(f.project.id, [stuckTask]);
    await f.store.savePlan(f.project.id, {
      revision: 1,
      summary: "Day 1",
      acceptanceCriteria: [],
      authority: "docs",
      approved: true,
      createdAt: new Date().toISOString(),
    });
    const dead = (await f.store.getProject(f.project.id)) as ProjectRecord;
    dead.status = "paused";
    dead.pause = { cause: "dispatch_closed", detail: "closed", at: new Date().toISOString() };
    dead.budget = {
      ...defaultBudget(),
      stopReason: 'Recovery budget exhausted for "Audit". Remaining results are kept.',
    };
    await f.store.saveProject(dead);

    await orchestrator.retryTask(f.project.id, "t1");
    await orchestrator.waitForLocal(f.project.id);

    const rescued = await f.store.getProject(f.project.id);
    expect(rescued?.budget.stopReason).toBeUndefined();
    expect(rescued?.status).not.toBe("failed");
    const rescuedTasks = await f.store.getTasks(f.project.id);
    expect(rescuedTasks[0].repairCount).toBe(0);
    expect(rescuedTasks[0].recoveryCount ?? 0).toBe(0);
    expect(rescuedTasks[0].status).not.toBe("failed");
  });
});

describe("shutdown waits for an aborted manager turn to finish", () => {
  it("does not resolve until the interrupted turn has recorded its own state", async () => {
    const f = await workflowFixture({ prefix: "dispatch-quit-manager-" });
    let sawAbort = false;
    let started = false;
    const manager: ManagerPort = {
      async runTurn(ctx) {
        started = true;
        await new Promise<void>((_resolve, reject) => {
          ctx.signal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              // Simulate the turn's own cleanup taking a moment after the
              // abort signal fires, before it actually settles.
              setTimeout(() => reject(new Error("Manager stopped.")), 20);
            },
            { once: true },
          );
        });
        return { text: "unreachable", toolTrace: [] };
      },
    };
    const { worker } = recordingWorker();
    const orchestrator = engineFor(f, manager, worker);

    const sendMessageDone = orchestrator.sendMessage(f.project.id, "Go").catch(() => undefined);
    // Let the manager turn actually start (and register its abort listener)
    // before quitting.
    while (!started) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await orchestrator.shutdown();
    expect(sawAbort).toBe(true);

    // shutdown() only resolved after the turn's own abort handling (and the
    // "Manager stopped" system message it appends) had already run — not
    // merely after the abort signal was raised.
    const messages = await f.store.getMessages(f.project.id);
    expect(messages.some((message) => /manager stopped/i.test(message.text))).toBe(true);
    await sendMessageDone;
  });
});

describe("user-caused interruptions", () => {
  it("never exhaust the task: paused attempts count toward no limit", async () => {
    const f = await workflowFixture({
      prefix: "dispatch-paused-",
      policy: { verification: { commands: [CHECK], protectedPaths: [] } },
    });
    const { worker } = failingWorker();
    let turns = 0;
    const manager = new ScriptedManager(async (ctx) => {
      turns += 1;
      if (turns === 1) {
        await ctx.host.proposePlan({
          summary: "Paused often",
          acceptanceCriteria: ["tests pass"],
          tasks: [
            {
              title: "Work",
              objective: "work",
              workerPrompt: "work",
              acceptanceCriteria: "tests pass",
              difficulty: "small",
              route: "interactive",
            },
          ],
        });
        return "plan";
      }
      // Simulate the user pausing each attempt before it could finish.
      const tasks = await f.store.getTasks(ctx.project.id);
      const last = tasks[0].attempts.at(-1);
      if (last) {
        last.status = "paused";
        last.failureClass = "infrastructure";
        await f.store.saveTasks(ctx.project.id, tasks);
      }
      return ctx.host.requestRepair(tasks[0].id, "Continue after the pause.");
    });
    const orchestrator = engineFor(f, manager, worker);
    await orchestrator.sendMessage(f.project.id, "Work");
    await orchestrator.approvePlan(f.project.id);
    await orchestrator.start(f.project.id);
    for (let index = 0; index < 6; index += 1) await round(orchestrator, f.project.id);
    const task = (await f.store.getTasks(f.project.id))[0];
    expect(task.attempts.length).toBeGreaterThan(3);
    expect(task.repairCount).toBe(0);
    expect(task.recoveryCount ?? 0).toBe(0);
    expect(task.stuck).toBeUndefined();
    expect(task.status).not.toBe("failed");
  });
});

describe("fix rounds per task", () => {
  it("follows the project's override", async () => {
    const { task } = await stuckProjectFixture(0, 0);
    expect(task.repairCount).toBe(0);
    expect(task.stuck?.brief).toMatch(/Fix rounds used: 0 of 0/);
  });
});

/** Leaves the fixture's task in review with its last attempt ending as `end` describes. */
async function endLastAttempt(
  f: WorkflowFixture,
  end: { error: string; failureClass: "ambiguous_inference" | "infrastructure" },
  edit?: (task: TaskRecord) => void,
): Promise<void> {
  const tasks = await f.store.getTasks(f.project.id);
  const current = tasks[0];
  current.stuck = undefined;
  current.status = "needs_review";
  edit?.(current);
  const last = current.attempts.at(-1)!;
  last.status = "failed";
  last.error = end.error;
  last.failureClass = end.failureClass;
  await f.store.saveTasks(f.project.id, tasks);
  const record = (await f.store.getProject(f.project.id))!;
  record.status = "reviewing";
  await f.store.saveProject(record);
}

describe("attempts that produce nothing usable", () => {
  it("pause the run for the owner after three in a row, without spending fix rounds", async () => {
    const { f, orchestrator, project, task } = await stuckProjectFixture();
    const repairsBefore = (await f.store.getTasks(project.id))[0].repairCount;
    await endLastAttempt(
      f,
      { error: "Incomplete model response", failureClass: "ambiguous_inference" },
      (current) => {
        current.recoveryCount = 3;
      },
    );
    const reply = await orchestrator.toolHost(project.id).requestRepair(task.id, "Try again.");
    expect(reply).toMatch(/paused the run for the owner/);
    const paused = await f.store.getProject(project.id);
    expect(paused?.status).toBe("paused");
    expect(paused?.pause?.cause).toBe("unusable_attempts");
    expect((await f.store.getTasks(project.id))[0].repairCount).toBe(repairsBefore);
  });
});

describe("a task that runs out of attempt time", () => {
  it("gets one suggestion to split what is left, then repairs as asked", async () => {
    const { f, orchestrator, project, task } = await stuckProjectFixture();
    await endLastAttempt(
      f,
      { error: INTERACTIVE_ATTEMPT_LIMIT_ERROR, failureClass: "infrastructure" },
      (current) => {
        current.recoveryCount = 0;
        current.splitAdvised = undefined;
      },
    );
    const host = orchestrator.toolHost(project.id);
    await expect(host.requestRepair(task.id, "Continue.")).rejects.toThrow(
      /ran out of attempt time\. If what is left is several pieces of work/,
    );
    expect((await f.store.getTasks(project.id))[0].splitAdvised).toBe(true);
    await expect(host.requestRepair(task.id, "Continue.")).resolves.toBeTypeOf("string");
  });
});

describe("an oversized task that fails", () => {
  it("gets one suggestion to split before its fix rounds are spent", async () => {
    const { task } = await stuckProjectFixture(MAX_REPAIRS_PER_TASK, undefined, "large");
    expect(task.splitAdvised).toBe(true);
    expect(task.repairCount).toBe(MAX_REPAIRS_PER_TASK);
  });
});
