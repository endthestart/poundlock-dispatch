import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import { validEscalationGrant } from "@core/escalation";
import { MemoryPoundlock } from "@core/memory-poundlock";
import { type ManagerPort, ProjectOrchestrator } from "@core/orchestration";
import { projectFiles } from "@core/paths";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { ToolJournal } from "@core/tool-journal";
import { hostCommandPort } from "@runtime/host-command";
import { nextEscalation, validateEscalationSettings } from "@shared/escalation";
import { MAX_REPAIRS_PER_TASK } from "@shared/policy-limits";
import { projectStatusView } from "@shared/project-status";
import type { InteractiveModel } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const frontier = (id: string) => ({
  profileId: id,
  profileName: id,
  source: "interactive" as const,
});
const planInput = {
  summary: "Create a document",
  acceptanceCriteria: ["Reviewed document"],
  tasks: [
    {
      title: "Document",
      objective: "Document",
      workerPrompt: "Document",
      acceptanceCriteria: "Reviewed",
      difficulty: "small" as const,
      route: "interactive" as const,
    },
  ],
};
const findings =
  "The worker repeats a contradictory interpretation of the acceptance criteria after correction. The failing comparison is retained; a stronger reasoning pass is needed.";

async function fixture(manager?: ManagerPort) {
  const root = await realpath(await tempDir("dispatch-ux-"));
  const folder = join(root, "project");
  await mkdir(folder);
  const store = new FileStore(join(root, "data"));
  await store.init();
  await store.saveConnection({
    url: "http://fixture",
    token: "fixture",
    roles: { manager: frontier("local"), interactive: frontier("local") },
  });
  const backend = new MemoryPoundlock();
  const models: InteractiveModel[] = ["local", "frontier-first", "frontier-second"].map((id) => ({
    id,
    context_tokens: 32768,
    max_output_tokens: 4096,
    workload_class: "interactive-coding",
    dataDestination: id === "local" ? "operator_network" : "external",
  }));
  backend.listInteractiveModels = async () => models;
  const project = await createFolderProject({ store, folder });
  const used: string[] = [];
  const approvals = new ApprovalBroker();
  const engine = new ProjectOrchestrator({
    hostCommands: hostCommandPort,
    store,
    clientFor: async () => backend,
    approvals,
    manager: manager ?? {
      async runTurn(ctx) {
        await ctx.host.proposePlan(planInput);
        return { text: "Proposed", toolTrace: [{ name: "propose_plan", summary: "Proposed" }] };
      },
    },
    worker: {
      async run(ctx) {
        used.push(ctx.model.id);
        await writeFile(join(folder, "result.md"), "worker document");
        return {
          output: "Written",
          changedFiles: ["result.md"],
          patch: "+worker document",
          verification: {
            status: "passed",
            commands: [{ command: "node --test", exitCode: 0, output: "Passed" }],
          },
        };
      },
    },
  });
  async function configure(mode: "standing" | "ask" = "standing", limit = 3) {
    await store.saveConnection({
      ...(await store.getConnection()),
      escalation: {
        mode,
        maxTransitionsPerRun: limit,
        profiles: [frontier("frontier-first"), frontier("frontier-second")],
      },
    });
  }
  async function start() {
    await engine.sendMessage(project.id, "Plan this work");
    await engine.approveAndStart(project.id);
    await engine.waitForLocal(project.id);
  }
  return {
    root,
    folder,
    store,
    backend,
    project,
    engine,
    used,
    approvals,
    configure,
    start,
    models,
  };
}

describe("agreed Dispatch interaction flow", () => {
  it("answers questions without inventing a plan or dispatching work", async () => {
    const f = await fixture({
      async runTurn() {
        return { text: "Review the existing requirements next.", toolTrace: [] };
      },
    });
    await f.engine.sendMessage(f.project.id, "What is next?");
    await f.engine.tick(f.project.id);
    expect(await f.store.getPlan(f.project.id)).toBeUndefined();
    expect(f.used).toEqual([]);
    expect((await f.store.getProject(f.project.id))?.status).toBe("draft");
  });
  it("approves and starts once, with approval controls gone afterward", async () => {
    const f = await fixture();
    await f.start();
    await f.engine.approveAndStart(f.project.id);
    expect(f.used).toEqual(["local"]);
    expect(f.backend.submits).toBe(0);
    const view = projectStatusView({
      project: (await f.store.getProject(f.project.id))!,
      plan: await f.store.getPlan(f.project.id),
      tasks: await f.store.getTasks(f.project.id),
      messages: [],
    });
    expect(view.canApprove).toBe(false);

    expect(view.evidence).toBe("Task 1 of 1 is in review.");
  });
  it("Wait preserves an undecided proposal and discussion does not resume it", async () => {
    const f = await fixture({
      async runTurn() {
        return { text: "Here is the explanation.", toolTrace: [] };
      },
    });
    await f.engine.toolHost(f.project.id).proposePlan(planInput);
    await f.engine.pause(f.project.id);
    await f.engine.sendMessage(f.project.id, "Explain the proposed work");
    await f.engine.tick(f.project.id);
    expect(f.used).toEqual([]);
    expect((await f.store.getProject(f.project.id))?.status).toBe("paused");
    expect((await f.store.getPlan(f.project.id))?.approved).toBe(false);
  });
  it("requires one visible reconciliation stop, then continues only after an explicit second resume", async () => {
    const f = await fixture();
    await f.engine.toolHost(f.project.id).proposePlan(planInput);
    await f.engine.approvePlan(f.project.id);
    const journal = new ToolJournal(projectFiles(f.store.layout.root, f.project.id).journal);
    const pending = await journal.begin({
      workflowId: f.project.workflowId,
      planRevision: 1,
      action: { tool: "write", path: join(f.folder, "unknown.txt") },
      authorization: "sandbox",
      sideEffectScope: [f.folder],
    });
    await f.engine.start(f.project.id);
    expect(f.used).toEqual([]);
    expect((await f.store.getProject(f.project.id))?.needsInput?.kind).toBe("tool_reconciliation");
    expect((await journal.read(pending.eventId))?.status).toBe("needs_reconciliation");
    await f.engine.start(f.project.id);
    await f.engine.waitForLocal(f.project.id);
    expect(f.used).toEqual(["local"]);
    expect((await journal.read(pending.eventId))?.status).toBe("completed");
  });

  it("cancelled projects accept revised plans and archive the previous result", async () => {
    const f = await fixture();
    await f.start();
    await f.engine.cancel(f.project.id);
    await f.engine.sendMessage(f.project.id, "Plan the revision");
    expect((await f.store.getProject(f.project.id))?.status).toBe("awaiting_approval");
    expect((await f.store.getProject(f.project.id))?.budget.stopReason).toBeUndefined();
    expect((await f.store.getPlan(f.project.id))?.revision).toBe(2);
    const archived = JSON.parse(
      await readFile(join(f.store.layout.projectsDir, f.project.id, "history/plan-1.json"), "utf8"),
    );
    expect(archived.tasks[0].attempts).toHaveLength(1);
    expect(f.used).toEqual(["local"]);
  });
  it("does not replace a run while a worker has not reported", async () => {
    const f = await fixture();
    await f.start();
    await f.engine.cancel(f.project.id);
    const tasks = await f.store.getTasks(f.project.id);
    // An attempt left running (for example by a crash) is live work; an
    // ambiguous attempt that ended is finished evidence, not live work.
    tasks[0].attempts[0].status = "running";
    await f.store.saveTasks(f.project.id, tasks);
    await f.engine.sendMessage(f.project.id, "Plan revised work");
    expect((await f.store.getPlan(f.project.id))?.revision).toBe(1);
    expect((await f.store.getMessages(f.project.id)).at(-1)?.text).toMatch(/running worker/);
  });
  it("delegates an agreed document under existing permissions, with no manager writer", async () => {
    const f = await fixture({
      async runTurn(ctx) {
        await ctx.host.delegateTask({
          title: "Record ADR",
          objective: "Record the agreed ADR",
          workerPrompt: "Write the agreed decision",
          acceptanceCriteria: "Agreed contents recorded",
          difficulty: "small",
        });
        return { text: "Delegated", toolTrace: [] };
      },
    });
    await f.store.savePermissions({ defaultMode: "assist" });
    await f.engine.sendMessage(f.project.id, "Write the ADR we agreed");
    await f.engine.tick(f.project.id);
    await f.engine.waitForLocal(f.project.id);
    expect(f.used).toEqual(["local"]);
    expect((await f.store.getPlan(f.project.id))?.approved).toBe(true);
    expect(Object.keys(f.engine.toolHost(f.project.id))).not.toContain("writeFile");
  });
  it("stages a later manager plan instead of replacing published tasks", async () => {
    const f = await fixture();
    await f.engine.toolHost(f.project.id).proposePlan(planInput);
    const first = await f.store.getTasks(f.project.id);
    expect(first).toHaveLength(1);
    await f.engine.toolHost(f.project.id).proposePlan({
      ...planInput,
      summary: "Create two documents",
      tasks: [
        planInput.tasks[0],
        {
          title: "Second",
          objective: "Second",
          workerPrompt: "Second",
          acceptanceCriteria: "Reviewed",
          difficulty: "small",
          route: "interactive",
        },
      ],
    });
    expect((await f.store.getTasks(f.project.id)).map((task) => task.id)).toEqual([first[0].id]);
    expect((await f.store.getPendingBoard(f.project.id))?.tasks).toHaveLength(2);
    await f.engine.approvePlan(f.project.id);
    const after = await f.store.getTasks(f.project.id);
    expect(after.map((task) => task.title)).toEqual(["Document", "Second"]);
    expect(after[0].id).toBe(first[0].id);
  });
  it("keeps published specifications an update restates as placeholder, and says so", async () => {
    const f = await fixture();
    await f.engine.toolHost(f.project.id).proposePlan(planInput);
    const host = f.engine.toolHost(f.project.id);
    const reply = await host.proposePlan({
      ...planInput,
      summary: "Flag the document task",
      tasks: [
        {
          ...planInput.tasks[0],
          objective: "placeholder",
          workerPrompt: "placeholder",
          acceptanceCriteria: "placeholder",
          changesFrozenTests: true,
        },
      ],
    });
    expect(reply).toMatch(/1 published task\(s\) restated without real content keep their own/);
    const pending = await f.store.getPendingBoard(f.project.id);
    expect(pending?.changes).toEqual([
      { title: "Document", change: "changed", fields: ["may change frozen tests"] },
    ]);
    await f.engine.approvePlan(f.project.id);
    const [kept] = await f.store.getTasks(f.project.id);
    expect(kept.objective).toBe("Document");
    expect(kept.changesFrozenTests).toBe(true);
    await expect(
      host.proposePlan({
        ...planInput,
        tasks: [{ ...planInput.tasks[0], title: "New", objective: "TBD" }],
      }),
    ).rejects.toThrow(/“New” has no real objective/);
  });
  it("refuses a task that lists a frozen test among its files unless it may change it", async () => {
    const f = await fixture();
    const host = f.engine.toolHost(f.project.id);
    await host.proposePlan(planInput);
    const plan = (await f.store.getPlan(f.project.id))!;
    plan.frozenTests = [{ path: "tests/import.rs", sha256: "x", task: "Tests" }];
    await f.store.savePlan(f.project.id, plan);
    const update = (changesFrozenTests?: boolean) =>
      host.proposePlan({
        ...planInput,
        tasks: [
          {
            ...planInput.tasks[0],
            title: "Managed copy",
            filesToTouch: ["src/import.rs", "./tests/import.rs"],
            changesFrozenTests,
          },
        ],
      });
    await expect(update()).rejects.toThrow(
      /“Managed copy” lists \.\/tests\/import\.rs, a frozen test its worker cannot change/,
    );
    await expect(update(true)).resolves.toMatch(/Proposed board update|recorded/);
  });
  it("merges an agreed extra task into the published board", async () => {
    const f = await fixture();
    await f.engine.toolHost(f.project.id).proposePlan(planInput);
    const firstId = (await f.store.getTasks(f.project.id))[0].id;
    await f.store.savePermissions({ defaultMode: "assist" });
    await f.engine.toolHost(f.project.id).delegateTask({
      title: "Record ADR",
      objective: "Record the agreed ADR",
      workerPrompt: "Write the agreed decision",
      acceptanceCriteria: "Agreed contents recorded",
      difficulty: "small",
    });
    const tasks = await f.store.getTasks(f.project.id);
    expect(tasks.map((task) => task.title)).toEqual(["Document", "Record ADR"]);
    expect(tasks[0].id).toBe(firstId);
  });
});

describe("manager-coordinated frontier escalation", () => {
  it("uses the configured order only on a manager request and respects its transition limit", async () => {
    const f = await fixture();
    await f.configure("standing", 1);
    await f.start();
    expect(f.used).toEqual(["local"]);
    let task = (await f.store.getTasks(f.project.id))[0];
    await f.engine
      .toolHost(f.project.id)
      .requestEscalation({ target: "worker", taskId: task.id, findings });
    await f.engine.tick(f.project.id);
    await f.engine.waitForLocal(f.project.id);
    expect(f.used).toEqual(["local", "frontier-first"]);
    expect(f.approvals.list()).toEqual([]);
    task = (await f.store.getTasks(f.project.id))[0];
    expect(task.attempts[1].selectionReason).toContain(findings);
    await expect(
      f.engine
        .toolHost(f.project.id)
        .requestEscalation({ target: "worker", taskId: task.id, findings }),
    ).rejects.toThrow(/transition limit/);
  });
  it("does not ask again for an escalation the owner declined, until the owner mentions it", async () => {
    const f = await fixture();
    await f.configure("ask", 3);
    await f.start();
    const task = (await f.store.getTasks(f.project.id))[0];
    const host = f.engine.toolHost(f.project.id);
    const asked = host.requestEscalation({ target: "worker", taskId: task.id, findings });
    await expect.poll(() => f.approvals.list().length).toBe(1);
    f.approvals.decide(f.approvals.list()[0].id, "deny");
    await expect(asked).resolves.toMatch(/Escalation declined[\s\S]*Carry on/);
    const declined = await f.store.getProject(f.project.id);
    expect(declined?.declinedEscalations).toEqual(["frontier-first"]);
    // A "no" is an answer, not a stop: the run is not paused by it.
    expect(declined?.pause).toBeUndefined();
    // The owner resumes and the task comes back for review.
    await f.engine.start(f.project.id);
    await f.engine.waitForLocal(f.project.id);
    const resumed = (await f.store.getProject(f.project.id))!;
    resumed.status = "reviewing";
    resumed.pause = undefined;
    await f.store.saveProject(resumed);
    await expect(
      host.requestEscalation({ target: "worker", taskId: task.id, findings }),
    ).rejects.toThrow(/declined escalation to frontier-first/);
    await f.engine.sendMessage(f.project.id, "Go ahead and escalate it after all.");
    expect((await f.store.getProject(f.project.id))?.declinedEscalations).toBeUndefined();
  });
  it("does not refresh the external-transition allowance when the plan revision changes", async () => {
    const f = await fixture();
    await f.configure("standing", 1);
    await f.start();
    const task0 = (await f.store.getTasks(f.project.id))[0];
    await f.engine
      .toolHost(f.project.id)
      .requestEscalation({ target: "worker", taskId: task0.id, findings });
    await f.engine.tick(f.project.id);
    await f.engine.waitForLocal(f.project.id);
    expect(f.used).toEqual(["local", "frontier-first"]);
    // A second, never-escalated task (no stale prior grant to trip the
    // unrelated validEscalationGrant check) plus a bumped planRevision
    // simulates an approved plan revision on the same run. The old code
    // filtered escalation history by planRevision, so this fresh escalation
    // would silently be granted a free transition; it must not.
    const tasks = await f.store.getTasks(f.project.id);
    const task1 = { ...task0, id: `${task0.id}-2`, escalation: undefined };
    await f.store.saveTasks(f.project.id, [...tasks, task1]);
    const project = (await f.store.getProject(f.project.id))!;
    project.planRevision += 1;
    await f.store.saveProject(project);
    await expect(
      f.engine
        .toolHost(f.project.id)
        .requestEscalation({ target: "worker", taskId: task1.id, findings }),
    ).rejects.toThrow(/transition limit/);
  });
  it("bounds a local rung by the ladder, not the run's external-transition limit", async () => {
    const f = await fixture();
    f.models.push(
      {
        id: "local2",
        context_tokens: 32768,
        max_output_tokens: 4096,
        workload_class: "interactive-coding",
        dataDestination: "operator_network",
      },
      {
        id: "local3",
        context_tokens: 32768,
        max_output_tokens: 4096,
        workload_class: "interactive-coding",
        dataDestination: "operator_network",
      },
    );
    await f.store.saveConnection({
      ...(await f.store.getConnection()),
      escalation: {
        mode: "standing",
        maxTransitionsPerRun: 1,
        profiles: [frontier("local2"), frontier("local3")],
      },
    });
    await f.start();
    expect(f.used).toEqual(["local"]);
    let task = (await f.store.getTasks(f.project.id))[0];
    await f.engine
      .toolHost(f.project.id)
      .requestEscalation({ target: "worker", taskId: task.id, findings });
    await f.engine.tick(f.project.id);
    await f.engine.waitForLocal(f.project.id);
    expect(f.used).toEqual(["local", "local2"]);
    task = (await f.store.getTasks(f.project.id))[0];
    // A second local escalation succeeds even though maxTransitionsPerRun is
    // 1: a rung on the operator's own infrastructure never spends that
    // allowance, only the ladder bounds it.
    await f.engine
      .toolHost(f.project.id)
      .requestEscalation({ target: "worker", taskId: task.id, findings });
    await f.engine.tick(f.project.id);
    await f.engine.waitForLocal(f.project.id);
    expect(f.used).toEqual(["local", "local2", "local3"]);
    task = (await f.store.getTasks(f.project.id))[0];
    await expect(
      f.engine
        .toolHost(f.project.id)
        .requestEscalation({ target: "worker", taskId: task.id, findings }),
    ).rejects.toThrow(/No further escalation profile is configured/);
  });
  describe("a task that starts on a ladder rung", () => {
    // Medium tasks start on the first ladder rung with enough context, which
    // need not be the first rung. Escalating then means the rung above the
    // one the task is on, not the top of the list again.
    const medium = {
      async runTurn(ctx: Parameters<ManagerPort["runTurn"]>[0]) {
        await ctx.host.proposePlan({
          ...planInput,
          tasks: [{ ...planInput.tasks[0], difficulty: "medium" as const }],
        });
        return { text: "Proposed", toolTrace: [{ name: "propose_plan", summary: "Proposed" }] };
      },
    };
    async function ladderOf(
      f: Awaited<ReturnType<typeof fixture>>,
      rungs: Array<[string, number]>,
    ) {
      for (const [id, context] of rungs)
        f.models.push({
          id,
          context_tokens: context,
          max_output_tokens: 4096,
          workload_class: "interactive-coding",
          dataDestination: "operator_network",
        });
      await f.store.saveConnection({
        ...(await f.store.getConnection()),
        escalation: {
          mode: "standing",
          maxTransitionsPerRun: 3,
          profiles: rungs.map(([id]) => frontier(id)),
        },
      });
    }
    async function escalate(f: Awaited<ReturnType<typeof fixture>>) {
      const task = (await f.store.getTasks(f.project.id))[0];
      await f.engine
        .toolHost(f.project.id)
        .requestEscalation({ target: "worker", taskId: task.id, findings });
      await f.engine.tick(f.project.id);
      await f.engine.waitForLocal(f.project.id);
    }

    it("escalates to the rung above the one it started on, not to the first rung", async () => {
      const f = await fixture(medium);
      await ladderOf(f, [
        ["rung-a", 32768],
        ["rung-b", 131072],
        ["rung-c", 262144],
      ]);
      await f.start();
      // 64K needed: rung-a is too small, rung-b is the first that fits.
      expect(f.used).toEqual(["rung-b"]);
      await escalate(f);
      expect(f.used).toEqual(["rung-b", "rung-c"]);
    });

    it("never escalates a task to the model it is already running on", async () => {
      const f = await fixture(medium);
      await ladderOf(f, [
        ["rung-a", 131072],
        ["rung-b", 262144],
      ]);
      await f.start();
      expect(f.used).toEqual(["rung-a"]);
      await escalate(f);
      expect(f.used).toEqual(["rung-a", "rung-b"]);
    });

    it("has nowhere to go from the top rung", async () => {
      const f = await fixture(medium);
      await ladderOf(f, [
        ["rung-a", 32768],
        ["rung-b", 131072],
      ]);
      await f.start();
      expect(f.used).toEqual(["rung-b"]);
      const task = (await f.store.getTasks(f.project.id))[0];
      await expect(
        f.engine
          .toolHost(f.project.id)
          .requestEscalation({ target: "worker", taskId: task.id, findings }),
      ).rejects.toThrow(/No further escalation profile is configured/);
    });

    it("still begins at the first rung for a task on the base worker", async () => {
      const f = await fixture();
      await ladderOf(f, [
        ["rung-a", 32768],
        ["rung-b", 131072],
      ]);
      await f.start();
      expect(f.used).toEqual(["local"]);
      await escalate(f);
      expect(f.used).toEqual(["local", "rung-a"]);
    });
  });
  it("still escalates a stuck task whose fix rounds are used up", async () => {
    const f = await fixture();
    await f.configure("standing", 1);
    await f.start();
    const tasks = await f.store.getTasks(f.project.id);
    const done = tasks[0].attempts[0];
    tasks[0].repairCount = MAX_REPAIRS_PER_TASK;
    tasks[0].attempts.push({ ...done, id: `${done.id}-repeat` });
    await f.store.saveTasks(f.project.id, tasks);
    await f.engine
      .toolHost(f.project.id)
      .requestEscalation({ target: "worker", taskId: tasks[0].id, findings });
    await f.engine.tick(f.project.id);
    await f.engine.waitForLocal(f.project.id);
    expect(f.used).toEqual(["local", "frontier-first"]);
  });
  it("gives the stronger rung the whole fix-round allowance", async () => {
    const f = await fixture();
    await f.configure("standing", 1);
    await f.start();
    const before = (await f.store.getTasks(f.project.id))[0];
    expect(before.repairCount).toBe(0);
    await f.engine
      .toolHost(f.project.id)
      .requestEscalation({ target: "worker", taskId: before.id, findings });
    const after = (await f.store.getTasks(f.project.id))[0];
    expect(after.repairCount).toBe(0);
  });
  it("requires an explicit decision in ask mode and respects Wait during that decision", async () => {
    const f = await fixture();
    await f.configure("ask");
    await f.start();
    const task = (await f.store.getTasks(f.project.id))[0];
    const result = f.engine
      .toolHost(f.project.id)
      .requestEscalation({ target: "worker", taskId: task.id, findings });
    await expect.poll(() => f.approvals.list().length, { timeout: 5_000 }).toBe(1);
    expect(f.used).toEqual(["local"]);
    await f.engine.pause(f.project.id);
    await result;
    expect((await f.store.getProject(f.project.id))?.status).toBe("paused");
    expect((await f.store.getTasks(f.project.id))[0].escalation).toBeUndefined();
  });
  it("rejects operational failures and does not silently skip an unavailable profile", async () => {
    const f = await fixture();
    await f.configure();
    await f.start();
    const tasks = await f.store.getTasks(f.project.id);
    const task = tasks[0];
    task.attempts[0].error = "infrastructure_unavailable: node is sleeping";
    await f.store.saveTasks(f.project.id, tasks);
    await expect(
      f.engine
        .toolHost(f.project.id)
        .requestEscalation({ target: "worker", taskId: task.id, findings }),
    ).rejects.toThrow(/operational/);
    task.attempts[0].error = undefined;
    await f.store.saveTasks(f.project.id, tasks);
    f.models.splice(1, 1);
    await expect(
      f.engine
        .toolHost(f.project.id)
        .requestEscalation({ target: "worker", taskId: task.id, findings }),
    ).rejects.toThrow(/not skipped/);
    expect(f.used).toEqual(["local"]);
  });
  it("revokes a saved grant when connection or escalation policy changes", async () => {
    const f = await fixture();
    await f.configure();
    await f.start();
    const task = (await f.store.getTasks(f.project.id))[0];
    await f.engine
      .toolHost(f.project.id)
      .requestEscalation({ target: "worker", taskId: task.id, findings });
    const grant = (await f.store.getTasks(f.project.id))[0].escalation!;
    const connection = await f.store.getConnection();
    expect(validEscalationGrant(grant, connection, (await f.store.getProject(f.project.id))!)).toBe(
      true,
    );
    await f.configure("ask");
    await f.engine.tick(f.project.id);
    expect(f.used).toEqual(["local"]);
    expect((await f.store.getProject(f.project.id))?.status).toBe("needs_input");
    expect(validEscalationGrant(grant, { ...connection, url: "http://different" }, f.project)).toBe(
      false,
    );
  });
  it("hands manager reasoning to the next profile without worker tool permissions", async () => {
    const seen: string[] = [];
    const f = await fixture({
      async runTurn(ctx) {
        seen.push(ctx.project.managerEscalation?.profile.profileId ?? "local");
        if (!ctx.project.managerEscalation)
          await ctx.host.requestEscalation({ target: "manager", findings });
        return { text: "Reasoned response", toolTrace: [] };
      },
    });
    await f.configure();
    await f.engine.sendMessage(f.project.id, "Review this reasoning problem");
    expect(seen).toEqual(["local", "frontier-first"]);
    expect(f.used).toEqual([]);
    expect((await f.store.getProject(f.project.id))?.escalations).toHaveLength(1);
  });
  it("validates unique ordered profiles", () => {
    const settings = {
      profiles: [frontier("a"), frontier("b")],
      mode: "ask" as const,
      maxTransitionsPerRun: 2,
    };
    expect(nextEscalation(settings, frontier("a")).profileId).toBe("b");
    expect(() =>
      validateEscalationSettings({ ...settings, profiles: [frontier("a"), frontier("a")] }),
    ).toThrow(/only once/);
    // A job profile cannot be a rung: nothing would ever run on it.
    const job = { ...frontier("job"), source: "durable" as never };
    expect(() => validateEscalationSettings({ ...settings, profiles: [job] })).toThrow(
      /published execution profile/,
    );
  });
});

describe("internal destination confirmations", () => {
  it("uses a confirmation keyed by stable profile ID even when Poundlock declares unknown", async () => {
    const f = await fixture();
    f.models[0].profileId = "stable-internal-id";
    f.models[0].dataDestination = "unknown";
    await f.store.saveConnection({
      ...(await f.store.getConnection()),
      profiles: { "stable-internal-id": { approvedDestination: "operator_network" } },
    });
    await f.start();
    expect(f.used).toEqual(["local"]);
    expect(f.approvals.list()).toEqual([]);
    expect((await f.store.getPermissions()).defaultMode).toBe("ask");
  });
  it("still requests a clear destination decision when a profile has no confirmation", async () => {
    const f = await fixture();
    f.models[0].dataDestination = "unknown";
    const started = f.start();
    await expect.poll(() => f.approvals.list().length, { timeout: 5_000 }).toBe(1);
    const request = f.approvals.list()[0];
    expect(request.action).toBe("Confirm where local is hosted");
    expect(request.reason).toContain("Poundlock has not declared");
    expect(f.used).toEqual([]);
    f.approvals.decide(request.id, "once");
    await started;
    expect(f.used).toEqual(["local"]);
  });
});
