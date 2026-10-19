import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rootsForFolderChoice } from "@core/access-roots";
import { ApprovalBroker } from "@core/approval-broker";
import { safeReadFile } from "@core/file-access";
import type { WorkerPort } from "@core/interactive-worker";
import { MemoryPoundlock } from "@core/memory-poundlock";
import { type ManagerPort, ProjectOrchestrator } from "@core/orchestration";
import { createFolderProject } from "@core/projects";
import { RouteRevisionChangedError } from "@core/role-routing";
import { FileStore } from "@core/store";
import { projectWorkingRoot } from "@core/workflow-support";
import { hostCommandPort } from "@runtime/host-command";
import { TURN_BUDGET_STOP } from "@shared/policy-limits";
import { projectStatusView } from "@shared/project-status";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

async function fixture() {
  const root = await realpath(await tempDir("dispatch-interactive-"));
  const folder = join(root, "project");
  await mkdir(folder);
  const store = new FileStore(join(root, "data"));
  await store.init();
  await store.saveConnection({
    url: "http://fixture",
    token: "fixture",
    roles: {
      manager: { profileId: "coding", profileName: "coding", source: "interactive" },
      interactive: { profileId: "coding", profileName: "coding", source: "interactive" },
    },
  });
  const backend = new MemoryPoundlock();
  backend.listInteractiveModels = async () => [
    {
      id: "coding",
      context_tokens: 32768,
      max_output_tokens: 4096,
      dataDestination: "operator_network",
      workload_class: "interactive-coding",
    },
  ];
  const project = await createFolderProject({ store, folder });
  return { root, folder, store, backend, project };
}
const command = "node --test";
function planningManager(store: FileStore): ManagerPort {
  return {
    async runTurn(ctx) {
      const tasks = await store.getTasks(ctx.project.id);
      if (!tasks.length)
        await ctx.host.proposePlan({
          summary: "Write a file",
          acceptanceCriteria: ["The file exists"],
          tasks: [
            {
              title: "Write",
              objective: "Write",
              workerPrompt: "Write",
              acceptanceCriteria: "Exists",
              difficulty: "small",
              route: "interactive",
            },
          ],
        });
      else if (tasks[0].status === "needs_review") await ctx.host.requestApplyResult(tasks[0].id);
      else if (tasks.every((task) => task.status === "applied"))
        await ctx.host.markComplete("Verified");
      return { text: "Recorded", toolTrace: [] };
    },
  };
}
const successful: WorkerPort = {
  async run(ctx) {
    await writeFile(join(ctx.cwd, "result.txt"), "worker\n");
    return {
      output: "Done",
      changedFiles: ["result.txt"],
      patch: "+worker",
      verification: { status: "passed", commands: [{ command, exitCode: 0, output: "passed" }] },
    };
  },
};

describe("attached worker lifecycle", () => {
  it("plans, edits the original folder, reviews and completes without submitting a job", async () => {
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: planningManager(f.store),
      worker: successful,
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Write a file");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    await engine.tick(f.project.id);
    expect(await readFile(join(f.folder, "result.txt"), "utf8")).toBe("worker\n");
    expect((await f.store.getProject(f.project.id))?.status).toBe("completed");
    expect(f.backend.submits).toBe(0);
    expect((await f.store.getProject(f.project.id))?.budget.jobsSubmitted).toBe(0);
    expect((await f.store.getTasks(f.project.id))[0].attempts[0].execution).toBe("interactive");
  });
  it("pauses after a review that does not accept, repair, or ask", async () => {
    const f = await fixture();
    let turns = 0;
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: {
        async runTurn(ctx) {
          turns += 1;
          const tasks = await f.store.getTasks(ctx.project.id);
          if (!tasks.length) return planningManager(f.store).runTurn(ctx);
          return { text: "Looks fine so far.", toolTrace: [] };
        },
      },
      worker: successful,
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Write a file");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    const afterReview = turns;
    expect((await f.store.getProject(f.project.id))?.status).toBe("paused");
    expect((await f.store.getTasks(f.project.id))[0].status).toBe("needs_review");
    expect(
      (await f.store.getMessages(f.project.id)).some((message) =>
        /finished this review without accepting/i.test(message.text),
      ),
    ).toBe(true);
    await engine.tick(f.project.id);
    expect(turns).toBe(afterReview);
  });
  it("starts the next local task after accepting a result while still reviewing", async () => {
    const f = await fixture();
    let workers = 0;
    const worker: WorkerPort = {
      async run(ctx) {
        workers += 1;
        const file = workers === 1 ? "first.txt" : "second.txt";
        await writeFile(join(ctx.cwd, file), "ok\n");
        return {
          output: "Done",
          changedFiles: [file],
          patch: "+ok",
          verification: {
            status: "passed",
            commands: [{ command, exitCode: 0, output: "passed" }],
          },
        };
      },
    };
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: {
        async runTurn(ctx) {
          const tasks = await f.store.getTasks(ctx.project.id);
          if (!tasks.length) {
            await ctx.host.proposePlan({
              summary: "Write two files",
              acceptanceCriteria: ["Both exist"],
              tasks: [
                {
                  title: "First",
                  objective: "First",
                  workerPrompt: "First",
                  acceptanceCriteria: "Exists",
                  difficulty: "small",
                  route: "interactive",
                },
                {
                  title: "Second",
                  objective: "Second",
                  workerPrompt: "Second",
                  acceptanceCriteria: "Exists",
                  difficulty: "small",
                  route: "interactive",
                },
              ],
            });
          } else {
            const review = tasks.find((task) => task.status === "needs_review");
            if (review) await ctx.host.requestApplyResult(review.id);
            else if (tasks.every((task) => task.status === "applied"))
              await ctx.host.markComplete("Verified");
          }
          return { text: "Recorded", toolTrace: [] };
        },
      },
      worker,
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Write two files");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    const afterAccept = await f.store.getTasks(f.project.id);
    expect(afterAccept[0].status).toBe("applied");
    if (afterAccept[1].status === "ready" || afterAccept[1].status === "blocked") {
      await engine.tick(f.project.id);
    }
    const dispatched = await f.store.getTasks(f.project.id);
    expect(["running", "needs_review", "applied"]).toContain(dispatched[1].status);
    await engine.waitForLocal(f.project.id);
    expect(workers).toBe(2);
    expect(await readFile(join(f.folder, "first.txt"), "utf8")).toBe("ok\n");
    expect(await readFile(join(f.folder, "second.txt"), "utf8")).toBe("ok\n");
  });
  it("cannot accept missing checks or complete unfinished work", async () => {
    const f = await fixture();
    const worker: WorkerPort = {
      async run(ctx) {
        await writeFile(join(ctx.cwd, "result.js"), "export const result = true;\n");
        return {
          output: "Done",
          changedFiles: ["result.js"],
          patch: "+code",
          verification: { status: "unverified", commands: [] },
        };
      },
    };
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: planningManager(f.store),
      worker,
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Work");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    const task = (await f.store.getTasks(f.project.id))[0];
    await expect(engine.toolHost(f.project.id).requestApplyResult(task.id)).rejects.toThrow(
      /checks/,
    );
    await expect(engine.toolHost(f.project.id).markComplete("Done")).rejects.toThrow(/every task/);
  });
  it("accepts a reviewed delegated artifact without inventing a project check", async () => {
    const f = await fixture();
    await f.store.savePermissions({ defaultMode: "assist" });
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: planningManager(f.store),
      worker: {
        async run(ctx) {
          await writeFile(
            join(ctx.cwd, "picture.svg"),
            '<svg xmlns="http://www.w3.org/2000/svg"/>',
          );
          return {
            output: "Created picture.svg and checked its content.",
            changedFiles: ["picture.svg"],
            patch: "+svg",
            verification: {
              status: "unverified",
              commands: [],
              reason: "No verification commands were declared or discovered for this project.",
            },
          };
        },
      },
      approvals: new ApprovalBroker(),
    });
    await engine.toolHost(f.project.id).delegateTask({
      title: "Create SVG",
      objective: "Create an SVG picture",
      workerPrompt: "Create picture.svg",
      acceptanceCriteria: "The SVG is suitable",
      difficulty: "small",
    });
    await engine.tick(f.project.id);
    await engine.waitForLocal(f.project.id);
    const task = (await f.store.getTasks(f.project.id))[0];
    expect(task.managerReviewOnly).toBe(true);
    expect(task.attempts[0].result?.verification?.status).toBe("unverified");
    // A later attempt may only validate the retained file, as happened in the
    // live SVG task. The task still owns the file created in attempt one.
    task.attempts.push({
      ...task.attempts[0],
      id: "validation-only",
      number: 2,
      result: {
        ...task.attempts[0].result!,
        output: "Checked the retained picture.svg.",
        provenance: { changedFiles: [] },
      },
    });
    task.stuck = {
      since: new Date().toISOString(),
      category: "work_quality",
      reason: "No independent project check was configured.",
      brief: "Choose how to proceed.",
    };
    await f.store.saveTasks(f.project.id, [task]);
    await engine.toolHost(f.project.id).requestApplyResult(task.id);
    const accepted = (await f.store.getTasks(f.project.id))[0];
    expect(accepted.status).toBe("applied");
    expect(accepted.stuck).toBeUndefined();
    expect((await f.store.getMessages(f.project.id)).at(-1)?.text).toContain(
      "No independent project check was configured",
    );
  });
  it("records why an attempt was sent back in history and the conversation", async () => {
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: planningManager(f.store),
      worker: {
        async run(ctx) {
          await writeFile(join(ctx.cwd, "result.js"), "export const value = true;\n");
          return {
            output: "Created result.js",
            changedFiles: ["result.js"],
            patch: "+code",
            verification: { status: "unverified", commands: [] },
          };
        },
      },
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Work");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    const task = (await f.store.getTasks(f.project.id))[0];
    await engine.toolHost(f.project.id).requestRepair(task.id, "Add an independent project check.");
    const reviewed = (await f.store.getTasks(f.project.id))[0].attempts[0];
    expect(reviewed.review).toMatchObject({
      decision: "repair",
      reason: "Add an independent project check.",
      nextAttempt: 2,
    });
    expect((await f.store.getMessages(f.project.id)).at(-1)?.text).toContain("Attempt 1");
    expect((await f.store.getMessages(f.project.id)).at(-1)?.text).toContain(
      "Add an independent project check.",
    );
  });
  it("stops the run after a denied worker tool instead of automatically repairing around it", async () => {
    const f = await fixture();
    const worker: WorkerPort = {
      async run() {
        return {
          output: "",
          error: "Tool approval denied or cancelled. Worker stopped.",
          changedFiles: [],
          patch: "",
          verification: { status: "unverified", commands: [] },
        };
      },
    };
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: planningManager(f.store),
      worker,
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Work");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    expect((await f.store.getProject(f.project.id))?.status).toBe("paused");
    expect((await f.store.getTasks(f.project.id))[0].attempts).toHaveLength(1);
  });
  it("continues the same worker session after the 45-minute attempt limit", async () => {
    const f = await fixture();
    const limit =
      "Interactive worker reached the 45-minute attempt limit. Folder changes are retained. Request a recovery to continue this worker session.";
    let workers = 0;
    const sessionKeys: Array<string | undefined> = [];
    const worker: WorkerPort = {
      async run(ctx) {
        workers += 1;
        sessionKeys.push(ctx.task.workerSessionKey);
        if (workers === 1) {
          return {
            output: "",
            error: limit,
            changedFiles: ["plan.md"],
            patch: "+review",
            verification: { status: "unverified", commands: [] },
          };
        }
        return successful.run(ctx);
      },
    };
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker,
      manager: {
        async runTurn(ctx) {
          const tasks = await f.store.getTasks(ctx.project.id);
          if (!tasks.length) return planningManager(f.store).runTurn(ctx);
          if (tasks[0].status === "needs_review") {
            const last = tasks[0].attempts.at(-1);
            if (last?.error?.includes("45-minute attempt limit")) {
              await expect(ctx.host.requestApplyResult(tasks[0].id)).rejects.toThrow(
                /continue the same worker session/,
              );
              // Running out of time suggests a split once; asking again continues.
              await expect(
                ctx.host.requestRepair(tasks[0].id, "Finish remaining ADR review work."),
              ).rejects.toThrow(/ran out of attempt time/);
              const queued = await ctx.host.requestRepair(
                tasks[0].id,
                "Finish remaining ADR review work.",
              );
              expect(queued).toMatch(/same worker session will continue/);
              return { text: "Continuing", toolTrace: [] };
            }
            await ctx.host.requestApplyResult(tasks[0].id);
          } else if (tasks.every((task) => task.status === "applied"))
            await ctx.host.markComplete("Verified");
          return { text: "Recorded", toolTrace: [] };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Work");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    expect((await f.store.getProject(f.project.id))?.status).not.toBe("paused");
    expect((await f.store.getTasks(f.project.id))[0].attempts[0].failureClass).toBe(
      "infrastructure",
    );
    await engine.tick(f.project.id);
    const recovered = (await f.store.getTasks(f.project.id))[0];
    expect(recovered.repairCount).toBe(0);
    expect(recovered.recoveryCount).toBe(1);
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    expect(workers).toBe(2);
    expect(sessionKeys[1]).toBe(sessionKeys[0]);
  });
  it("reviews interrupted work before starting another ready task on resume", async () => {
    const f = await fixture();
    let workers = 0;
    const worker: WorkerPort = {
      async run() {
        workers++;
        return {
          output: "",
          error: "Interrupted",
          changedFiles: [],
          patch: "",
          verification: { status: "unverified", commands: [] },
        };
      },
    };
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: planningManager(f.store),
      worker,
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Work");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.pause(f.project.id);
    const tasks = await f.store.getTasks(f.project.id);
    tasks.push({ ...tasks[0], id: "next", title: "Next", attempts: [], status: "ready" });
    await f.store.saveTasks(f.project.id, tasks);
    await engine.start(f.project.id);
    expect(workers).toBe(1);
    expect((await f.store.getTasks(f.project.id))[1].status).toBe("ready");
  });
  it("backs off a busy manager without spending turns or repeating notices", async () => {
    const f = await fixture();
    let calls = 0;
    let now = Date.now();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      worker: successful,
      approvals: new ApprovalBroker(),
      clock: () => new Date(now),
      manager: {
        async runTurn() {
          calls++;
          return { text: "", toolTrace: [], capacityBlocked: true };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Plan work");
    await engine.tick(f.project.id);
    await engine.tick(f.project.id);
    expect(calls).toBe(1);
    now += 15_000;
    await engine.tick(f.project.id);
    expect(calls).toBe(2);
    expect((await f.store.getProject(f.project.id))?.budget.managerTurnsUsed).toBe(0);
    expect(
      (await f.store.getMessages(f.project.id)).filter((message) => message.role === "system"),
    ).toHaveLength(1);
  });
  it("stops immediately when Poundlock cannot provision the app gateway identity", async () => {
    const f = await fixture();
    let calls = 0;
    let now = Date.now();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      worker: successful,
      approvals: new ApprovalBroker(),
      clock: () => new Date(now),
      manager: {
        async runTurn() {
          calls++;
          return {
            text: "",
            toolTrace: [],
            capacityBlocked: true,
            infrastructureError: "managed_identity_unavailable: provision_failed",
          };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Plan work");
    const stopped = (await f.store.getProject(f.project.id))!;
    expect(stopped.status).toBe("paused");
    expect(stopped.infrastructureIssue?.title).toBe("Gateway access needs attention");
    expect(stopped.budget.managerTurnsUsed).toBe(0);
    now += 60_000;
    await engine.tick(f.project.id);
    expect(calls).toBe(1);
    expect((await f.store.getMessages(f.project.id)).at(-1)?.text).toContain(
      "No model request ran",
    );
  });
  it("reopens running work as paused and never invokes a new worker", async () => {
    const f = await fixture();
    let calls = 0;
    const manager = planningManager(f.store);
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager,
      worker: {
        async run(ctx) {
          calls++;
          return successful.run(ctx);
        },
      },
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Work");
    await engine.approvePlan(f.project.id);
    const project = (await f.store.getProject(f.project.id))!;
    project.status = "running";
    await f.store.saveProject(project);
    await engine.recover(project.id);
    await engine.tick(project.id);
    expect(calls).toBe(0);
    expect((await f.store.getProject(project.id))?.status).toBe("paused");
  });
  it("reopens a failed review as paused and does not apply until resume", async () => {
    const f = await fixture();
    let applies = 0;
    const manager: ManagerPort = {
      async runTurn(ctx) {
        const tasks = await f.store.getTasks(ctx.project.id);
        if (!tasks.length) {
          await ctx.host.proposePlan({
            summary: "Write a file",
            acceptanceCriteria: ["The file exists"],
            tasks: [
              {
                title: "Write",
                objective: "Write",
                workerPrompt: "Write",
                acceptanceCriteria: "Exists",
                difficulty: "small",
                route: "interactive",
              },
            ],
          });
        } else if (tasks[0].status === "needs_review") {
          applies += 1;
          await ctx.host.requestApplyResult(tasks[0].id);
        } else if (tasks.every((task) => task.status === "applied")) {
          await ctx.host.markComplete("Verified");
        }
        return { text: "Recorded", toolTrace: [] };
      },
    };
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager,
      worker: successful,
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Work");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    const halted = (await f.store.getProject(f.project.id))!;
    halted.status = "failed";
    halted.budget.stopReason = TURN_BUDGET_STOP;
    await f.store.saveProject(halted);
    await engine.recover(halted.id);
    await engine.tick(halted.id);
    expect(applies).toBe(0);
    expect((await f.store.getTasks(f.project.id))[0].status).toBe("needs_review");
    expect((await f.store.getProject(f.project.id))?.status).toBe("paused");
    await engine.start(halted.id);
    await engine.tick(halted.id);
    expect(applies).toBe(1);
    expect((await f.store.getTasks(f.project.id))[0].status).toBe("applied");
  });
  it("aborts an active local attempt and retains an interrupted result", async () => {
    const f = await fixture();
    const worker: WorkerPort = {
      run: (ctx) =>
        new Promise((resolve) =>
          ctx.signal.addEventListener(
            "abort",
            () =>
              resolve({
                output: "Interrupted",
                error: "Cancelled",
                changedFiles: [],
                patch: "",
                verification: { status: "unverified", commands: [] },
              }),
            { once: true },
          ),
        ),
    };
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: planningManager(f.store),
      worker,
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Work");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.pause(f.project.id);
    await engine.waitForLocal(f.project.id);
    expect((await f.store.getProject(f.project.id))?.status).toBe("paused");
    expect((await f.store.getTasks(f.project.id))[0].attempts[0].status).toBe("paused");
  });
  it("recovers paused interactive work without spending any fix-round or retry allowance", async () => {
    const f = await fixture();
    let workers = 0;
    const worker: WorkerPort = {
      async run(ctx) {
        workers += 1;
        if (workers === 1) {
          return await new Promise((resolve) =>
            ctx.signal.addEventListener(
              "abort",
              () =>
                resolve({
                  output: "",
                  error: "Worker interrupted.",
                  changedFiles: [],
                  patch: "",
                  verification: { status: "unverified", commands: [] },
                }),
              { once: true },
            ),
          );
        }
        return successful.run(ctx);
      },
    };
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker,
      manager: {
        async runTurn(ctx) {
          const tasks = await f.store.getTasks(ctx.project.id);
          if (!tasks.length) return planningManager(f.store).runTurn(ctx);
          if (tasks[0].status === "needs_review") {
            const last = tasks[0].attempts.at(-1);
            if (last?.status === "paused" || last?.error?.includes("interrupted")) {
              await ctx.host.requestRepair(tasks[0].id, "Continue the interrupted implementation.");
              return { text: "Recovering", toolTrace: [] };
            }
            await ctx.host.requestApplyResult(tasks[0].id);
          } else if (tasks.every((task) => task.status === "applied"))
            await ctx.host.markComplete("Verified");
          return { text: "Recorded", toolTrace: [] };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Work");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.pause(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.start(f.project.id);
    await engine.tick(f.project.id);
    await engine.waitForLocal(f.project.id);
    const task = (await f.store.getTasks(f.project.id))[0];
    // A Pause/Wait interruption is user-caused: it never spends the fix-round
    // or retry-after-interruption allowance (Phase 1 failure-handling plan).
    expect(task.repairCount).toBe(0);
    expect(task.recoveryCount ?? 0).toBe(0);
    expect(workers).toBe(2);
  });
});

describe("a worker that meets a busy model", () => {
  it("waits for the slot instead of sending unstarted work to review", async () => {
    // The workstation's profiles share one runtime slot, so a worker can find it
    // held by another request for longer than the in-stream wait. Nothing ran.
    // Treating that as a finished attempt cost a manager review turn — itself
    // a model swap on that machine — and then a retry from the task's
    // allowance, for work that never started.
    const f = await fixture();
    let workers = 0;
    let reviews = 0;
    const worker: WorkerPort = {
      async run(ctx) {
        workers += 1;
        if (workers === 1) {
          return {
            output: "",
            error:
              "Poundlock capacity_in_use wait exhausted. The original request was not resent after the deadline.",
            changedFiles: [],
            patch: "",
            verification: { status: "unverified", commands: [] },
          };
        }
        return successful.run(ctx);
      },
    };
    const planner = planningManager(f.store);
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker,
      manager: {
        async runTurn(ctx) {
          const tasks = await f.store.getTasks(ctx.project.id);
          if (tasks[0]?.status === "needs_review") reviews += 1;
          return planner.runTurn(ctx);
        },
      },
    });
    await engine.sendMessage(f.project.id, "Write a file");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);

    const waiting = await f.store.getProject(f.project.id);
    const task = (await f.store.getTasks(f.project.id))[0];
    expect(waiting?.status).toBe("waiting_for_capacity");
    expect(task.status).toBe("ready");
    expect(task.recoveryCount ?? 0).toBe(0);
    expect(reviews).toBe(0);

    // The next poll tries again, and this time the slot is free.
    await engine.tick(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    expect(workers).toBe(2);
    expect(reviews).toBe(1);
    expect((await f.store.getProject(f.project.id))?.status).toBe("completed");
  });
});

describe("manager access and approval boundaries", () => {
  it("enforces ignored, secret and symlink exclusions on actual reads, with exact explicit grants", async () => {
    const f = await fixture();
    await writeFile(join(f.folder, ".gitignore"), "private.txt\n");
    await writeFile(join(f.folder, "private.txt"), "ignored");
    await writeFile(join(f.folder, ".env"), "secret");
    const secret = join(f.root, "connection.secret.json");
    await writeFile(secret, "private fixture");
    await expect(safeReadFile(f.folder, secret)).rejects.toThrow(/excluded/);
    const outside = join(f.root, "outside.txt");
    await writeFile(outside, "external notes");
    await symlink(outside, join(f.folder, "linked.txt"));
    await mkdir(join(f.folder, "nested"));
    await writeFile(join(f.folder, "nested", ".gitignore"), "hidden.txt\n");
    await writeFile(join(f.folder, "nested", "hidden.txt"), "nested ignored");
    const { listLiveProjectFiles } = await import("@core/snapshot");
    expect(
      (await listLiveProjectFiles(f.folder)).some((file) => file.path.endsWith("hidden.txt")),
    ).toBe(false);
    await expect(safeReadFile(f.folder, "private.txt")).rejects.toThrow(/excluded/);
    await expect(safeReadFile(f.folder, ".env")).rejects.toThrow(/excluded/);
    await expect(safeReadFile(f.folder, "linked.txt")).rejects.toThrow(/outside/);
    await expect(safeReadFile(f.folder, outside)).rejects.toThrow(/outside/);
    expect(await safeReadFile(f.folder, outside, [outside])).toBe("external notes");
    expect(await safeReadFile(f.folder, ".env", [join(f.folder, ".env")])).toBe("secret");
  });
  it("scopes always grants to exact action and plan; cancellation releases pending decisions", async () => {
    const broker = new ApprovalBroker();
    const request = {
      projectId: "p",
      projectName: "Project",
      planRevision: 1,
      kind: "bash",
      action: "node --test",
      reason: "Run test",
    };
    const first = broker.request(request);
    broker.decide(broker.list()[0].id, "always");
    expect(await first).toBe(true);
    expect(await broker.request(request)).toBe(true);
    const changed = broker.request({ ...request, action: "rm file" });
    expect(broker.list()).toHaveLength(1);
    broker.cancel("p");
    expect(await changed).toBe(false);
    const nextPlan = broker.request({ ...request, planRevision: 2 });
    expect(broker.list()).toHaveLength(1);
    broker.decide(broker.list()[0].id, "deny");
    expect(await nextPlan).toBe(false);
  });
});

describe("continued corrections and recovery", () => {
  it("retains the same worker session, never spends budget on an environment setup issue, and accepts only after review", async () => {
    const f = await fixture();
    const sessions: Array<string | undefined> = [];
    let turns = 0;
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      manager: {
        async runTurn(ctx) {
          const tasks = await f.store.getTasks(ctx.project.id);
          if (!tasks.length) return planningManager(f.store).runTurn(ctx);
          if (tasks[0].attempts.length === 1)
            await ctx.host.requestRepair(
              tasks[0].id,
              "Set up the missing project dependency and rerun checks.",
            );
          else await ctx.host.requestApplyResult(tasks[0].id);
          return { text: "Reviewed", toolTrace: [] };
        },
      },
      worker: {
        async run(ctx) {
          sessions.push(ctx.sessionDir);
          turns++;
          return {
            output: "Worker finished",
            patch: "",
            changedFiles: [],
            verification: {
              status: turns === 1 ? "failed" : "passed",
              commands: [
                {
                  command,
                  exitCode: turns === 1 ? 1 : 0,
                  output: turns === 1 ? "ModuleNotFoundError: No module named 'django'" : "passed",
                },
              ],
            },
          };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Build");
    await engine.approveAndStart(f.project.id);
    await engine.waitForLocal(f.project.id);
    expect((await f.store.getTasks(f.project.id))[0].status).toBe("needs_review");
    await engine.tick(f.project.id);
    await engine.tick(f.project.id);
    await engine.waitForLocal(f.project.id);
    const task = (await f.store.getTasks(f.project.id))[0];
    // A missing-dependency/environment problem never spends the fix-round or
    // retry-after-interruption allowance (Phase 1 failure-handling plan).
    expect(task.recoveryCount ?? 0).toBe(0);
    expect(task.repairCount).toBe(0);
    expect(task.status).toBe("needs_review");
    expect(sessions[1]).toBe(sessions[0]);
    await engine.tick(f.project.id);
    expect((await f.store.getTasks(f.project.id))[0].status).toBe("applied");
  });
  it("records a manager question in chat and allows an explicit correction after the answer", async () => {
    const f = await fixture();
    let stage = 0;
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn(ctx) {
          const tasks = await f.store.getTasks(ctx.project.id);
          if (!tasks.length) return planningManager(f.store).runTurn(ctx);
          if (stage++ === 0) {
            await ctx.host.askUser("Should the output include a heading?");
            return { text: "Asked", toolTrace: [{ name: "ask_user", summary: "Asked" }] };
          }
          await ctx.host.requestRepair(tasks[0].id, "Add the requested heading.");
          return { text: "Continuing the worker", toolTrace: [] };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Build");
    await engine.approveAndStart(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    // What the manager said before asking stays with the question.
    expect(
      (await f.store.getMessages(f.project.id)).filter((m) =>
        m.text.includes("Should the output include a heading?"),
      ),
    ).toEqual([expect.objectContaining({ text: "Asked\n\nShould the output include a heading?" })]);
    await engine.reply(f.project.id, "Yes, add the heading");
    expect((await f.store.getProject(f.project.id))?.status).toBe("running");
    expect((await f.store.getTasks(f.project.id))[0].repairCount).toBe(1);
  });
  it("attaches the turn's tool-call trace to the question message ask_user recorded", async () => {
    // askUser must append its message before the turn's own trace is final
    // (the final assistant text is empty on this path), so the trace can only
    // be attached afterward once the whole turn's result is known.
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn(ctx) {
          await ctx.host.askUser("What should the CLI be named?");
          return {
            text: "",
            toolTrace: [
              { name: "list_project_files", summary: "list_project_files" },
              { name: "read_project_file", summary: "read_project_file" },
              { name: "ask_user", summary: "ask_user" },
            ],
          };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Build a CLI");
    const message = (await f.store.getMessages(f.project.id)).find(
      (m) => m.text === "What should the CLI be named?",
    );
    expect(message?.toolTrace?.map((item) => item.name)).toEqual([
      "list_project_files",
      "read_project_file",
      "ask_user",
    ]);
  });
  it("shows a question asked again before the owner replies only once", async () => {
    const f = await fixture();
    const results: string[] = [];
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn(ctx) {
          results.push(await ctx.host.askUser("Which scope comes first?"));
          results.push(await ctx.host.askUser("Which  scope comes first? "));
          return { text: "", toolTrace: [] };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Build a CLI");
    const asked = (await f.store.getMessages(f.project.id)).filter((m) =>
      m.text.startsWith("Which scope"),
    );
    expect(asked).toHaveLength(1);
    expect(results[1]).toMatch(/already asked this/);
    expect((await f.store.getProject(f.project.id))?.needsInput?.question).toMatch(/Which/);
  });
  it("lets the run go on after the owner answers a question asked mid-run", async () => {
    const f = await fixture();
    let asked = false;
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn(ctx) {
          const tasks = await f.store.getTasks(ctx.project.id);
          if (!tasks.length) return planningManager(f.store).runTurn(ctx);
          const review = tasks.find((task) => task.status === "needs_review");
          if (review && !asked) {
            asked = true;
            await ctx.host.askUser("Two frozen files were deleted. How should I proceed?");
            return { text: "", toolTrace: [] };
          }
          if (review) await ctx.host.requestApplyResult(review.id);
          else if (tasks.every((task) => task.status === "applied"))
            await ctx.host.markComplete("Done");
          return { text: "Recorded", toolTrace: [] };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Write a file");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    expect((await f.store.getProject(f.project.id))?.status).toBe("needs_input");
    await engine.reply(f.project.id, "I restored them. Accept it and continue.");
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    const project = await f.store.getProject(f.project.id);
    expect(project?.pause).toBeUndefined();
    expect(project?.status).toBe("completed");
  });
  it("offers a question's options as choices and answers with the chosen words", async () => {
    const f = await fixture();
    const answers: string[] = [];
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn(ctx) {
          if (!answers.length && ctx.project.status !== "needs_input") {
            answers.push("asked");
            await ctx.host.askUser("Which scope comes first?", [
              { label: "Catalog and export", description: "Import, browse, rate, export." },
              { label: "Full workflow", description: " " },
              { label: "  " },
            ]);
            return { text: "", toolTrace: [{ name: "ask_user", summary: "ask_user" }] };
          }
          const last = (await f.store.getMessages(ctx.project.id)).at(-1);
          answers.push(last?.text ?? "");
          return { text: "Noted", toolTrace: [] };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Plan the photo app");
    const asked = await f.store.getProject(f.project.id);
    expect(asked?.needsInput?.question).toBe("Which scope comes first?");
    // Blank labels are dropped, blank descriptions omitted, ids are positional.
    expect(asked?.needsInput?.choices).toEqual([
      { id: "option:1", label: "Catalog and export", description: "Import, browse, rate, export." },
      { id: "option:2", label: "Full workflow" },
    ]);
    // Only the question is posted; the options live on the choices.
    expect(
      (await f.store.getMessages(f.project.id)).some((m) => m.text.includes("Catalog and export")),
    ).toBe(false);
    await engine.reply(f.project.id, "option:2");
    expect(answers.at(-1)).toBe("Full workflow");
  });
  it("asks for a folder on a card and grants it only when the owner allows", async () => {
    const f = await fixture();
    const other = await realpath(await tempDir("dispatch-other-project-"));
    const said: string[] = [];
    let asked = false;
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn(ctx) {
          if (!asked) {
            asked = true;
            await expect(
              ctx.host.requestFolderAccess({ path: "/", mode: "read", reason: "Everything" }),
            ).rejects.toThrow(/filesystem root/);
            await ctx.host.requestFolderAccess({
              path: other,
              mode: "write",
              reason: "Reuse its importer.",
            });
            return { text: "", toolTrace: [{ name: "request_folder_access", summary: "x" }] };
          }
          said.push((await f.store.getMessages(ctx.project.id)).at(-1)?.text ?? "");
          return { text: "Thanks", toolTrace: [] };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Build the importer");
    const waiting = await f.store.getProject(f.project.id);
    expect(waiting?.status).toBe("needs_input");
    expect(waiting?.needsInput).toMatchObject({
      kind: "folder_access",
      folder: { path: other, mode: "write", reason: "Reuse its importer." },
    });
    expect(waiting?.needsInput?.choices?.map((choice) => choice.id)).toEqual([
      "folder:read",
      "folder:write",
      "folder:deny",
    ]);
    // Nothing is granted until the owner chooses.
    expect(waiting?.policy.roots ?? []).toEqual([]);

    // The host writes the grant, then the orchestrator tells the manager.
    const roots = await rootsForFolderChoice(waiting!, "folder:read", {
      projectRoot: projectWorkingRoot(f.store.layout.root, waiting!),
      dataRoot: f.store.layout.root,
    });
    await f.store.saveProject({ ...waiting!, policy: { ...waiting!.policy, roots } });
    await engine.reply(f.project.id, "folder:read");
    const granted = await f.store.getProject(f.project.id);
    expect(granted?.policy.roots).toEqual([
      expect.objectContaining({ path: other, mode: "read", grantedBy: "approval" }),
    ]);
    expect(said.at(-1)).toMatch(/may read .* \(read-only\)/);
  });
  it("tells the manager when the owner refuses a folder", async () => {
    const f = await fixture();
    const other = await realpath(await tempDir("dispatch-other-project-"));
    const said: string[] = [];
    let asked = false;
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn(ctx) {
          if (!asked) {
            asked = true;
            await ctx.host.requestFolderAccess({ path: other, mode: "read", reason: "Look" });
            return { text: "", toolTrace: [] };
          }
          said.push((await f.store.getMessages(ctx.project.id)).at(-1)?.text ?? "");
          return { text: "Ok", toolTrace: [] };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Build");
    await engine.reply(f.project.id, "folder:deny");
    expect((await f.store.getProject(f.project.id))?.policy.roots ?? []).toEqual([]);
    expect(said.at(-1)).toMatch(/^Not allowed/);
  });
  it("points a changed manager route to Settings instead of asking for another message", async () => {
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn() {
          throw new RouteRevisionChangedError("The selected profile route changed in Poundlock.");
        },
      },
    });
    await engine.sendMessage(f.project.id, "Plan the app");
    const project = await f.store.getProject(f.project.id);
    expect(project?.status).toBe("needs_input");
    expect(project?.needsInput?.kind).toBe("route_change");
    expect((await f.store.getMessages(f.project.id)).at(-1)?.text).toMatch(
      /Approve the current route in Settings/,
    );
  });
  it("keeps the rest of the board when a run-time update names only its changes", async () => {
    const f = await fixture();
    const task = (title: string) => ({
      title,
      objective: title,
      workerPrompt: title,
      acceptanceCriteria: "done",
      difficulty: "small" as const,
      route: "interactive" as const,
      requirementIds: ["R1"],
    });
    let turns = 0;
    let reply = "";
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn(ctx) {
          turns += 1;
          if (turns === 1)
            await ctx.host.proposePlan({
              summary: "Three tasks",
              requirements: [{ id: "R1", text: "Three parts", scenarios: ["each part exists"] }],
              acceptanceCriteria: ["done"],
              tasks: [task("One"), task("Two"), task("Three")],
            });
          else if (ctx.prompt?.includes("Fix it up") || turns > 1)
            reply ||= await ctx.host.proposePlan({
              summary: "A fix-up",
              acceptanceCriteria: ["done"],
              tasks: [task("Two"), task("Two and a half")],
              removeTasks: ["Three"],
            });
          return { text: "ok", toolTrace: [] };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Plan");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.pause(f.project.id);
    await engine.sendMessage(f.project.id, "Fix it up");
    expect(reply).toMatch(/removes 1 published task\(s\): “Three”/);
    const pending = await f.store.getPendingBoard(f.project.id);
    expect(pending?.tasks.map((item) => item.title)).toEqual(["One", "Two", "Two and a half"]);
  });
  it("a service outage waits and then recovers without creating a worker attempt", async () => {
    const f = await fixture();
    let time = Date.now();
    let unavailable = true;
    const available = f.backend.listInteractiveModels;
    f.backend.listInteractiveModels = async () => {
      if (unavailable) throw new Error("HTTP 503 infrastructure_unavailable");
      return available();
    };
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      worker: successful,
      manager: planningManager(f.store),
      approvals: new ApprovalBroker(),
      clock: () => new Date(time),
    });
    await engine.sendMessage(f.project.id, "Build");
    await engine.approveAndStart(f.project.id);
    expect((await f.store.getProject(f.project.id))?.status).toBe("waiting_for_capacity");
    expect((await f.store.getProject(f.project.id))?.infrastructureIssue?.title).toBe(
      "Waiting for Poundlock",
    );
    expect((await f.store.getTasks(f.project.id))[0].attempts).toHaveLength(0);
    unavailable = false;
    time += 16000;
    await engine.tick(f.project.id);
    await engine.waitForLocal(f.project.id);
    expect((await f.store.getTasks(f.project.id))[0].attempts).toHaveLength(1);
  });
});

describe("start fresh with retained history", () => {
  it("archives the current run and notes, preserves files/settings, and accepts the same prompt again", async () => {
    const f = await fixture();
    const manager = planningManager(f.store);
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager,
      worker: successful,
      approvals: new ApprovalBroker(),
    });
    await writeFile(join(f.folder, "keep.txt"), "Keep project files");
    await engine.sendMessage(f.project.id, "Build the demo");
    await engine.toolHost(f.project.id).writeNotes("Old run context");
    const old = (await f.store.getProject(f.project.id))!;
    await engine.startFresh(f.project.id);
    const fresh = (await f.store.getProject(f.project.id))!;
    expect(fresh.status).toBe("draft");
    expect(fresh.managerSessionId).not.toBe(old.managerSessionId);
    expect(fresh.policy).toEqual(old.policy);
    expect(fresh.budget.jobsSubmitted).toBe(0);
    expect(await f.store.getPlan(f.project.id)).toBeUndefined();
    expect(await f.store.getTasks(f.project.id)).toEqual([]);
    expect(await f.store.getMessages(f.project.id)).toEqual([]);
    expect(await engine.toolHost(f.project.id).readNotes()).toBe("");
    expect(await readFile(join(f.folder, "keep.txt"), "utf8")).toBe("Keep project files");
    const history = await f.store.getRunHistory(f.project.id);
    expect(history).toHaveLength(1);
    expect(history[0].tasks).toHaveLength(1);
    expect(history[0].messages.some((m) => m.text === "Build the demo")).toBe(true);
    expect(history[0]).not.toHaveProperty("managerNotes");
    await engine.sendMessage(f.project.id, "Build the demo");
    expect((await f.store.getPlan(f.project.id))?.revision).toBe(old.planRevision + 1);
    expect((await f.store.getProject(f.project.id))?.status).toBe("awaiting_approval");
  });
  it("clears the current run without replacing the manager conversation", async () => {
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: planningManager(f.store),
      worker: successful,
      approvals: new ApprovalBroker(),
    });
    await writeFile(join(f.folder, "keep.txt"), "Keep project files");
    await engine.sendMessage(f.project.id, "Build the demo");
    const old = (await f.store.getProject(f.project.id))!;
    const previousMessages = await f.store.getMessages(f.project.id);
    await engine.clearCurrentRun(f.project.id);
    const cleared = (await f.store.getProject(f.project.id))!;
    expect(cleared.status).toBe("draft");
    expect(cleared.managerSessionId).toBe(old.managerSessionId);
    expect(cleared.workflowId).not.toBe(old.workflowId);
    expect(cleared.dispatchAuthorized).toBe(false);
    expect(await f.store.getPlan(f.project.id)).toBeUndefined();
    expect(await f.store.getTasks(f.project.id)).toEqual([]);
    expect(await f.store.getMessages(f.project.id)).toEqual(previousMessages);
    expect(await readFile(join(f.folder, "keep.txt"), "utf8")).toBe("Keep project files");
  });
  it("does not archive a run while a worker is running or erase its evidence", async () => {
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: planningManager(f.store),
      worker: successful,
    });
    await engine.sendMessage(f.project.id, "Build");
    const tasks = await f.store.getTasks(f.project.id);
    tasks[0].attempts.push({
      id: "running",
      status: "running",
      execution: "interactive",
      number: 1,
      idempotencyKey: "key",
      requestHash: "hash",
      profileId: "profile",
      profileName: "profile",
      harnessId: "pi",
      createdAt: new Date().toISOString(),
      selectionReason: "Fixture",
    });
    await f.store.saveTasks(f.project.id, tasks);
    await expect(engine.startFresh(f.project.id)).rejects.toThrow("resolve pending work");
    expect((await f.store.getTasks(f.project.id))[0].attempts[0].status).toBe("running");
    expect(await f.store.getRunHistory(f.project.id)).toHaveLength(0);
  });
});

describe("what the manager said stays in the conversation", () => {
  it("keeps the words before a proposal, and records the reasoning used", async () => {
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn(ctx) {
          await planningManager(f.store).runTurn(ctx);
          return {
            text: "I read the layout. Here is a plan.",
            toolTrace: [{ name: "propose_plan", summary: "propose_plan" }],
            reasoning: "none",
          };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Write a file");
    const manager = (await f.store.getMessages(f.project.id)).filter((m) => m.role === "manager");
    expect(manager.map((m) => [m.text.split("\n")[0], m.reasoning])).toEqual([
      ["I read the layout. Here is a plan.", "none"],
      ["Write a file", "none"],
    ]);
  });

  it("keeps a partial reply when the turn fails", async () => {
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn() {
          throw Object.assign(new Error("The manager model returned an error."), {
            partialText: "Half of an answer",
          });
        },
      },
    });
    await engine.sendMessage(f.project.id, "Explain");
    const messages = await f.store.getMessages(f.project.id);
    expect(messages.some((m) => m.role === "manager" && m.text === "Half of an answer")).toBe(true);
  });
});

describe("the requirement ledger in a run", () => {
  const ledgerTask = (title: string, requirementIds: string[]) => ({
    title,
    objective: title,
    workerPrompt: title,
    acceptanceCriteria: `${title} works for the user`,
    difficulty: "small" as const,
    route: "interactive" as const,
    requirementIds,
  });

  it("has every task cite the requirements it delivers once there is a ledger", async () => {
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn() {
          return { text: "", toolTrace: [] };
        },
      },
    });
    const host = engine.toolHost(f.project.id);
    const requirements = [{ id: "R1", text: "Import", scenarios: ["grid shows photos"] }];
    await expect(
      host.proposePlan({
        summary: "s",
        acceptanceCriteria: ["a"],
        requirements,
        tasks: [ledgerTask("Import", []), ledgerTask("Organize", ["R9"])],
      }),
    ).rejects.toThrow(/“Import” cite none\. The ledger has no R9\. The ledger's IDs: R1/);
    await expect(
      host.proposePlan({
        summary: "s",
        acceptanceCriteria: ["a"],
        requirements,
        tasks: [
          ledgerTask("Import", ["R1"]),
          { ...ledgerTask("Docs", []), filesToTouch: ["README.md"] },
        ],
      }),
    ).resolves.toMatch(/recorded/);
  });

  it("checks a spec's milestones against the ledger, and keeps them across revisions", async () => {
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn() {
          return { text: "", toolTrace: [] };
        },
      },
    });
    const host = engine.toolHost(f.project.id);
    const requirements = [
      { id: "R1", text: "Import", scenarios: ["grid shows photos"] },
      { id: "R2", text: "Rate", scenarios: ["stars stick"] },
    ];
    const milestones = [
      { id: "M1", title: "Skeleton", goal: "import and see", requirementIds: ["R1"] },
      { id: "M2", title: "Rate", goal: "rate", requirementIds: ["R2", "R1", "R7"] },
    ];
    await expect(
      host.proposePlan({
        summary: "s",
        acceptanceCriteria: ["a"],
        requirements,
        milestones,
        tasks: [ledgerTask("Import", ["R1"])],
      }),
    ).rejects.toThrow(
      /R1 is in both M1 and M2; give it one\. M2 names R7, which is not in the ledger\. Each task names its milestone in milestoneId; “Import” name none/,
    );
    milestones[1].requirementIds = ["R2"];
    await host.proposePlan({
      summary: "s",
      acceptanceCriteria: ["a"],
      requirements,
      milestones,
      architecture: "One process; Playwright drives the UI.",
      tasks: [{ ...ledgerTask("Import", ["R1"]), milestoneId: "m1" }],
    });
    const plan =
      (await f.store.getPendingBoard(f.project.id))?.plan ?? (await f.store.getPlan(f.project.id));
    expect(plan?.milestones?.map((item) => item.id)).toEqual(["M1", "M2"]);
    expect(plan?.architecture).toBe("One process; Playwright drives the UI.");
    const tasks =
      (await f.store.getPendingBoard(f.project.id))?.tasks ??
      (await f.store.getTasks(f.project.id));
    expect(tasks[0].milestoneId).toBe("M1");
    expect(tasks[0].workerPrompt).toContain(
      "Architecture (follow it):\nOne process; Playwright drives the UI.",
    );
  });

  it("asks for requirements before a project-sized plan", async () => {
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn() {
          return { text: "", toolTrace: [] };
        },
      },
    });
    await expect(
      engine.toolHost(f.project.id).proposePlan({
        summary: "Three parts",
        acceptanceCriteria: ["done"],
        tasks: [ledgerTask("One", []), ledgerTask("Two", []), ledgerTask("Three", [])],
      }),
    ).rejects.toThrow(/List the owner's requirements first/);
  });

  it("serves requirements, keeps going until each is done or waived, and raises noted issues", async () => {
    const f = await fixture();
    const prompts: string[] = [];
    const replies: string[] = [];
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn(ctx) {
          prompts.push(ctx.prompt ?? "");
          const tasks = await f.store.getTasks(ctx.project.id);
          if (!tasks.length) {
            replies.push(
              await ctx.host.proposePlan({
                summary: "Import and review photos",
                acceptanceCriteria: ["The owner can import and pick photos"],
                requirements: [
                  { id: "R1", text: "Import a folder", scenarios: ["the grid shows every photo"] },
                  { id: "R2", text: "Organize photos", scenarios: ["photos sort by date"] },
                ],
                tasks: [ledgerTask("Import", ["R1"])],
              }),
            );
            return { text: "Proposed", toolTrace: [] };
          }
          const review = tasks.find((task) => task.status === "needs_review");
          if (review) {
            replies.push(
              await ctx.host.noteIssue({ text: "Should RAW+JPEG pairs show as one photo?" }),
            );
            await ctx.host.requestApplyResult(review.id);
          } else if (tasks.every((task) => task.status === "applied"))
            replies.push(await ctx.host.markComplete("Done").catch(String));
          return { text: "Recorded", toolTrace: [] };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Build the photo app");
    expect(replies[0]).toMatch(/no task serves R2 \(Organize photos\)/);
    // The worker brief carries the requirement and how it is shown.
    const [planned] = await f.store.getTasks(f.project.id);
    expect(planned.workerPrompt).toMatch(
      /R1: Import a folder\n {2}Shown by: the grid shows every photo/,
    );
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    await engine.tick(f.project.id);
    const plan = await f.store.getPlan(f.project.id);
    expect(plan?.requirements?.map((item) => item.status)).toEqual(["done", "open"]);
    const roundEnd = prompts.find((prompt) =>
      prompt.startsWith("All local tasks have been reviewed"),
    );
    expect(roundEnd).toMatch(/1 of 2 requirements done/);
    expect(roundEnd).toMatch(
      /Open requirements:\n- R2: Organize photos \(shown by: photos sort by date\)/,
    );
    expect(roundEnd).toMatch(/Should RAW\+JPEG pairs show as one photo\?/);
    expect(roundEnd).toMatch(/propose the next round of tasks/);
    expect(replies.at(-1)).toMatch(/Requirements still open: R2 \(Organize photos\)/);
    expect((await f.store.getProject(f.project.id))?.status).not.toBe("completed");
    // Only the owner's own words drop a requirement.
    const host = engine.toolHost(f.project.id);
    await expect(
      host.waiveRequirement({ id: "R2", ownerWords: "skip organizing" }),
    ).rejects.toThrow(/Only the owner can waive/);
    await f.store.appendMessage(f.project.id, {
      id: "msg-owner",
      role: "user",
      text: "Skip organizing for the first release.",
      createdAt: new Date().toISOString(),
    });
    await expect(host.waiveRequirement({ id: "r2", ownerWords: "skip organizing" })).resolves.toBe(
      "Waived R2.",
    );
    await expect(host.markComplete("Import works.")).resolves.toBe("Marked complete.");
    const last = (await f.store.getMessages(f.project.id)).at(-1);
    expect(last?.text).toMatch(
      /1 of 2 requirements done, 1 waived\. Waived: R2 \(Organize photos\), Owner: “skip organizing”/,
    );
  });
  for (const [mode, starts] of [
    ["full", true],
    ["ask", false],
  ] as const)
    it(`${starts ? "starts" : "stages"} the next round for open requirements in ${mode} mode`, async () => {
      const f = await fixture();
      await f.store.savePermissions({ defaultMode: mode });
      let round = 0;
      const replies: string[] = [];
      const engine = new ProjectOrchestrator({
        hostCommands: hostCommandPort,
        store: f.store,
        clientFor: async () => f.backend,
        approvals: new ApprovalBroker(),
        worker: successful,
        manager: {
          async runTurn(ctx) {
            const tasks = await f.store.getTasks(ctx.project.id);
            const review = tasks.find((task) => task.status === "needs_review");
            if (!tasks.length) {
              round = 1;
              await ctx.host.proposePlan({
                summary: "Round one",
                acceptanceCriteria: ["import works"],
                requirements: [
                  { id: "R1", text: "Import", scenarios: ["grid shows photos"] },
                  { id: "R2", text: "Organize", scenarios: ["sort by date"] },
                ],
                tasks: [ledgerTask("Import", ["R1"])],
              });
            } else if (review) await ctx.host.requestApplyResult(review.id);
            else if (round === 1 && tasks.every((task) => task.status === "applied")) {
              round = 2;
              replies.push(
                await ctx.host.proposePlan({
                  summary: "Round two",
                  acceptanceCriteria: ["organize works"],
                  tasks: [ledgerTask("Organize", ["R2"])],
                }),
              );
            }
            return { text: "Recorded", toolTrace: [] };
          },
        },
      });
      await engine.sendMessage(f.project.id, "Build it");
      await engine.approvePlan(f.project.id);
      await engine.start(f.project.id);
      await engine.waitForLocal(f.project.id);
      await engine.tick(f.project.id);
      await engine.tick(f.project.id);
      const plan = await f.store.getPlan(f.project.id);
      expect(plan?.summary).toBe("Round two");
      expect(plan?.approved).toBe(starts);
      if (starts) {
        expect(replies[0]).toMatch(/continues open requirements R2 .* starts now/);
        expect(plan?.autoApprovedUnder).toBe("full");
        expect(
          (await f.store.getMessages(f.project.id)).some((m) => /Next round for R2/.test(m.text)),
        ).toBe(true);
      } else expect(replies[0]).toMatch(/Wait for the user to approve/);
    });
  it("has a read-only verifier judge the round's requirements before completion", async () => {
    const f = await fixture();
    const prompts: string[] = [];
    const replies: string[] = [];
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: {
        async run(ctx) {
          if (ctx.readOnly)
            return {
              output:
                "Checked ReviewController.\nR1: not shown — P still unpicks (ReviewController.swift:51)",
              changedFiles: [],
              patch: "",
              verification: { status: "unverified", commands: [] },
            };
          return successful.run(ctx);
        },
      },
      manager: {
        async runTurn(ctx) {
          prompts.push(ctx.prompt ?? "");
          const tasks = await f.store.getTasks(ctx.project.id);
          const review = tasks.find((task) => task.status === "needs_review");
          if (!tasks.length)
            await ctx.host.proposePlan({
              summary: "Review keys",
              acceptanceCriteria: ["P picks"],
              requirements: [
                { id: "R1", text: "P picks", scenarios: ["P marks the photo picked"] },
              ],
              tasks: [ledgerTask("Keys", ["R1"])],
            });
          else if (review) await ctx.host.requestApplyResult(review.id);
          else replies.push(await ctx.host.markComplete("Done").catch(String));
          return { text: "Recorded", toolTrace: [] };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Fix the keys");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    await engine.tick(f.project.id);
    const [r1] = (await f.store.getPlan(f.project.id))?.requirements ?? [];
    expect(r1).toMatchObject({ status: "done", verdict: { result: "not shown" } });
    const roundEnd = prompts.find((prompt) =>
      prompt.startsWith("All local tasks have been reviewed"),
    );
    expect(roundEnd).toMatch(
      /verifier found accepted work that does not show[\s\S]*R1: not shown — P still unpicks/,
    );
    expect(replies.at(-1)).toMatch(
      /verifier found accepted work that does not show R1 \(not shown\)/,
    );
    expect(
      (await f.store.getMessages(f.project.id)).some((m) =>
        /Round-end verification:\n- R1: not shown/.test(m.text),
      ),
    ).toBe(true);
  });

  describe("with a Verifier bound", () => {
    async function verifierFixture() {
      const f = await fixture();
      const connection = await f.store.getConnection();
      await f.store.saveConnection({
        ...connection,
        roles: {
          ...connection.roles,
          verifier: { profileId: "strong", profileName: "strong", source: "interactive" },
        },
      });
      const models = await f.backend.listInteractiveModels();
      f.backend.listInteractiveModels = async () => [
        ...models,
        { ...models[0], id: "strong", context_tokens: 131072 },
      ];
      return f;
    }
    const readOnlyRuns: Array<{ title: string; model: string; question: string }> = [];
    const verifierWorker: WorkerPort = {
      async run(ctx) {
        if (!ctx.readOnly) return successful.run(ctx);
        readOnlyRuns.push({
          title: ctx.task.title,
          model: ctx.model.id,
          question: ctx.task.objective,
        });
        return {
          output:
            ctx.task.title === "Review the proposed plan"
              ? "The ledger misses export.\nVerdict: revise\n1. Add a requirement for export."
              : "R1: shown — ReviewControllerTests.testPPicks",
          changedFiles: [],
          patch: "",
          verification: { status: "unverified", commands: [] },
        };
      },
    };

    it("reviews a new plan once per owner message, on the Verifier's model", async () => {
      readOnlyRuns.length = 0;
      const f = await verifierFixture();
      const replies: string[] = [];
      const plan = (summary: string) => ({
        summary,
        acceptanceCriteria: ["it works"],
        requirements: [{ id: "R1", text: "Import", scenarios: ["import a folder"] }],
        tasks: [ledgerTask("A", ["R1"]), ledgerTask("B", ["R1"]), ledgerTask("C", ["R1"])],
      });
      const engine = new ProjectOrchestrator({
        hostCommands: hostCommandPort,
        store: f.store,
        clientFor: async () => f.backend,
        approvals: new ApprovalBroker(),
        worker: verifierWorker,
        manager: {
          async runTurn(ctx) {
            replies.push(await ctx.host.proposePlan(plan("First")));
            replies.push(await ctx.host.proposePlan(plan("Revised")));
            return { text: "Proposed", toolTrace: [] };
          },
        },
      });
      await engine.sendMessage(f.project.id, "Build an importer that exports too");
      expect(readOnlyRuns).toHaveLength(1);
      expect(readOnlyRuns[0]).toMatchObject({ title: "Review the proposed plan", model: "strong" });
      expect(readOnlyRuns[0].question).toMatch(/Build an importer that exports too[\s\S]*R1/);
      expect(replies[0]).toMatch(/Plan review by the Verifier[\s\S]*Verdict: revise/);
      expect(replies[1]).not.toMatch(/Plan review/);
      expect(
        (await f.store.getMessages(f.project.id)).some((m) =>
          /^Plan review: Verdict: revise\n1\. Add a requirement for export/.test(m.text),
        ),
      ).toBe(true);
    });

    it("leaves small plans and projects without a Verifier unreviewed", async () => {
      readOnlyRuns.length = 0;
      for (const [f, tasks] of [
        [await fixture(), ["A", "B", "C"]],
        [await verifierFixture(), ["A", "B"]],
      ] as const) {
        let reply = "";
        const engine = new ProjectOrchestrator({
          hostCommands: hostCommandPort,
          store: f.store,
          clientFor: async () => f.backend,
          approvals: new ApprovalBroker(),
          worker: verifierWorker,
          manager: {
            async runTurn(ctx) {
              reply = await ctx.host.proposePlan({
                summary: "Plan",
                acceptanceCriteria: ["it works"],
                requirements: [{ id: "R1", text: "Import", scenarios: ["import a folder"] }],
                tasks: tasks.map((title) => ledgerTask(title, ["R1"])),
              });
              return { text: "Proposed", toolTrace: [] };
            },
          },
        });
        await engine.sendMessage(f.project.id, "Build it");
        expect(reply).not.toMatch(/Plan review/);
      }
      expect(readOnlyRuns).toHaveLength(0);
    });

    it("runs the round-end verification on the Verifier's model", async () => {
      readOnlyRuns.length = 0;
      const f = await verifierFixture();
      const engine = new ProjectOrchestrator({
        hostCommands: hostCommandPort,
        store: f.store,
        clientFor: async () => f.backend,
        approvals: new ApprovalBroker(),
        worker: verifierWorker,
        manager: {
          async runTurn(ctx) {
            const tasks = await f.store.getTasks(ctx.project.id);
            const review = tasks.find((task) => task.status === "needs_review");
            if (!tasks.length)
              await ctx.host.proposePlan({
                summary: "Review keys",
                acceptanceCriteria: ["P picks"],
                requirements: [{ id: "R1", text: "P picks", scenarios: ["P marks it picked"] }],
                tasks: [ledgerTask("Keys", ["R1"])],
              });
            else if (review) await ctx.host.requestApplyResult(review.id);
            else await ctx.host.markComplete("Done").catch(String);
            return { text: "Recorded", toolTrace: [] };
          },
        },
      });
      await engine.sendMessage(f.project.id, "Fix the keys");
      await engine.approvePlan(f.project.id);
      await engine.start(f.project.id);
      await engine.waitForLocal(f.project.id);
      await engine.tick(f.project.id);
      await engine.tick(f.project.id);
      expect(readOnlyRuns).toEqual([
        expect.objectContaining({ title: "Verify the round's requirements", model: "strong" }),
      ]);
      const [r1] = (await f.store.getPlan(f.project.id))?.requirements ?? [];
      expect(r1).toMatchObject({ status: "done", verdict: { result: "shown" } });
    });
  });

  it("leads the next turn with an owner message sent while the manager was busy, once", async () => {
    const f = await fixture();
    const prompts: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: successful,
      manager: {
        async runTurn(ctx) {
          prompts.push(ctx.prompt ?? "");
          if (prompts.length === 1) await gate;
          return { text: "Noted", toolTrace: [] };
        },
      },
    });
    const first = engine.sendMessage(f.project.id, "Start");
    await expect.poll(() => prompts.length).toBe(1);
    await engine.sendMessage(f.project.id, "Add a date-sort test task, please.");
    expect((await f.store.getProject(f.project.id))?.unreadOwnerMessages).toHaveLength(1);
    release();
    await first;
    await engine.sendMessage(f.project.id, "Next");
    await engine.sendMessage(f.project.id, "And again");
    expect(prompts[1]).toMatch(
      /^The owner wrote while you were busy\. Act on this in this turn[\s\S]*> Add a date-sort test task, please\./,
    );
    expect(prompts[2]).not.toMatch(/while you were busy/);
    expect((await f.store.getProject(f.project.id))?.unreadOwnerMessages).toBeUndefined();
  });

  it("lets a delegated new task join the board while another task runs", async () => {
    const f = await fixture();
    const saved = (await f.store.getProject(f.project.id))!;
    saved.policy.toolTrust = "full";
    await f.store.saveProject(saved);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      approvals: new ApprovalBroker(),
      worker: {
        async run(ctx) {
          if (ctx.task.title === "Write") await gate;
          return successful.run(ctx);
        },
      },
      manager: planningManager(f.store),
    });
    await engine.sendMessage(f.project.id, "Build it");
    await engine.approvePlan(f.project.id);
    const started = engine.start(f.project.id);
    await expect
      .poll(async () => (await f.store.getTasks(f.project.id))[0]?.status)
      .toBe("running");
    const reply = await engine.toolHost(f.project.id).delegateTask({
      title: "Test sort by date",
      objective: "Test that Sort by date puts the newest photo first",
      workerPrompt: "Add the test",
      acceptanceCriteria: "Sorting by date shows the newest photo first",
      difficulty: "small",
      route: "interactive",
    });
    expect(reply).toMatch(
      /Added “Test sort by date” to the board without changing the running work/,
    );
    const tasks = await f.store.getTasks(f.project.id);
    expect(tasks.map((task) => [task.title, task.status])).toEqual([
      ["Write", "running"],
      ["Test sort by date", "ready"],
    ]);
    // Replacing the plan still waits for the running work.
    await expect(
      engine.toolHost(f.project.id).proposePlan({
        summary: "Other",
        acceptanceCriteria: ["x"],
        tasks: [
          {
            title: "Other",
            objective: "o",
            workerPrompt: "o",
            acceptanceCriteria: "o works",
            difficulty: "small",
            route: "interactive",
          },
        ],
      }),
    ).rejects.toThrow(/Pause active work before replacing its plan/);
    release();
    await started;
  });

  it("pauses at the manager-turn limit instead of failing, and Resume gives a fresh allowance", async () => {
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      worker: successful,
      approvals: new ApprovalBroker(),
      manager: planningManager(f.store),
    });
    await engine.sendMessage(f.project.id, "Build it");
    await engine.approvePlan(f.project.id);
    const spent = (await f.store.getProject(f.project.id))!;
    spent.budget.managerTurnsUsed = 999;
    await f.store.saveProject(spent);
    await engine.sendMessage(f.project.id, "Anything else?");
    const stopped = (await f.store.getProject(f.project.id))!;
    expect(stopped.status).toBe("paused");
    expect(stopped.budget.stopReason).toMatch(/manager-turn budget is exhausted/);
    expect(
      projectStatusView({
        project: stopped,
        plan: await f.store.getPlan(f.project.id),
        tasks: await f.store.getTasks(f.project.id),
      } as never).title,
    ).toBe("Manager turn limit reached");
    await engine.start(f.project.id);
    expect((await f.store.getProject(f.project.id))?.budget.managerTurnsUsed).toBeLessThan(5);
  });

  it("starts a new round's plan with a fresh manager-turn allowance", async () => {
    const f = await fixture();
    let round = 0;
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      worker: successful,
      approvals: new ApprovalBroker(),
      manager: {
        async runTurn(ctx) {
          const tasks = await f.store.getTasks(ctx.project.id);
          const review = tasks.find((task) => task.status === "needs_review");
          if (review) await ctx.host.requestApplyResult(review.id);
          else if (
            !tasks.length ||
            (round === 1 && tasks.every((task) => task.status === "applied"))
          ) {
            round += 1;
            if (round === 2) {
              // Round one has used many turns by the time it ends.
              const spent = (await f.store.getProject(ctx.project.id))!;
              spent.budget.managerTurnsUsed = 40;
              await f.store.saveProject(spent);
            }
            await ctx.host.proposePlan({
              summary: `Round ${round}`,
              acceptanceCriteria: ["works"],
              tasks: [
                {
                  title: `Task ${round}`,
                  objective: "o",
                  workerPrompt: "w",
                  acceptanceCriteria: "it works",
                  difficulty: "small",
                  route: "interactive",
                },
              ],
            });
          }
          return { text: "Recorded", toolTrace: [] };
        },
      },
    });
    await engine.sendMessage(f.project.id, "Build it");
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    await engine.tick(f.project.id);
    expect((await f.store.getPlan(f.project.id))?.summary).toBe("Round 2");
    expect((await f.store.getProject(f.project.id))?.budget.managerTurnsUsed).toBeLessThan(5);
  });
});
