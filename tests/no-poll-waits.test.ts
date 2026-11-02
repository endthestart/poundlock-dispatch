/**
 * Work a manager turn hands off, and the review of what a worker returns,
 * start at once rather than on the host's next 2.5 s poll. A worker that never
 * got the model's slot is the exception: its retry keeps the poll's pace, so a
 * busy model is not asked again in a tight loop.
 */
import { ApprovalBroker } from "@core/approval-broker";
import { DispatchHost } from "@core/host/dispatch-host";
import type { WorkerPort } from "@core/interactive-worker";
import { type ManagerPort, ProjectOrchestrator } from "@core/orchestration";
import { ProjectLifecycle } from "@core/project-lifecycle";
import { hostCommandPort } from "@runtime/host-command";
import { expect, it } from "vitest";
import { recordingWorker, type WorkflowFixture, workflowFixture } from "./support/workflow-fixture";

const task = {
  title: "Write",
  objective: "Write the file",
  workerPrompt: "Write the file",
  acceptanceCriteria: "The file exists",
  difficulty: "small" as const,
};

/** Delegates `task` on its first turn, then accepts whatever is waiting for review. */
function delegatingManager(f: WorkflowFixture, reviewed: string[]): ManagerPort {
  return {
    async runTurn(ctx) {
      const tasks = await f.store.getTasks(ctx.project.id);
      if (!tasks.length) {
        await ctx.host.delegateTask(task);
        return { text: "Delegated", toolTrace: [] };
      }
      const review = tasks.find((item) => item.status === "needs_review");
      if (review) {
        reviewed.push(review.title);
        await ctx.host.requestApplyResult(review.id);
      }
      return { text: "Reviewed", toolTrace: [] };
    },
  };
}

async function orchestrator(worker: WorkerPort) {
  const f = await workflowFixture();
  await f.store.savePermissions({ defaultMode: "full" });
  const ready: string[] = [];
  const engine = new ProjectOrchestrator({
    hostCommands: hostCommandPort,
    store: f.store,
    clientFor: async () => f.backend,
    manager: delegatingManager(f, []),
    worker,
    approvals: new ApprovalBroker(),
    onReviewReady: (projectId) => ready.push(projectId),
  });
  await engine.sendMessage(f.project.id, "Write the file");
  await engine.waitForLocal(f.project.id);
  return { f, ready };
}

it("starts a delegated task in the same turn, and says when its result is ready", async () => {
  const { worker, runs } = recordingWorker();
  const { f, ready } = await orchestrator(worker);
  expect(runs).toEqual(["Write"]);
  expect(ready).toEqual([f.project.id]);
});

it("leaves a worker that never got the model's slot to the poll", async () => {
  const { ready } = await orchestrator({
    async run() {
      return {
        output: "",
        error: "Poundlock capacity_in_use wait exhausted. The request was not resent.",
        changedFiles: [],
        patch: "",
        verification: { status: "unverified", commands: [] },
      };
    },
  });
  expect(ready).toEqual([]);
});

it("reviews a worker's result well before the host's next poll", async () => {
  const f = await workflowFixture({ prefix: "dispatch-review-now-" });
  await f.store.savePermissions({ defaultMode: "full" });
  const reviewed: string[] = [];
  const { worker } = recordingWorker();
  const host = new DispatchHost({ dataRoot: f.store.layout.root }, f.store, new ApprovalBroker(), {
    worker: () => worker,
    managerProvider: () => ({
      get: async () => delegatingManager(f, reviewed),
      reset: async () => undefined,
      abort: () => undefined,
      clear: () => undefined,
    }),
    orchestrator: (dependencies) =>
      new ProjectOrchestrator({
        hostCommands: hostCommandPort,
        ...dependencies,
        clientFor: async () => f.backend,
      }),
    lifecycle: (dependencies) => new ProjectLifecycle(dependencies),
  });
  await host.start();
  await host.selectProject(f.project.id);
  try {
    // The poll's next tick is 2.5 s away from here; the review must not wait for it.
    host.stopPolling();
    host.resumePolling();
    await host.sendMessage("Write the file");
    await expect.poll(() => reviewed, { timeout: 2_000, interval: 20 }).toEqual(["Write"]);
  } finally {
    await host.shutdown();
  }
});
