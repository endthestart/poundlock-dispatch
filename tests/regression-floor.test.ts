/**
 * Plan section 2 regression floor. Each test is named after one required
 * invariant so a failure identifies the broken contract directly. These use
 * deterministic doubles (fake manager, worker and Poundlock) and are separate
 * from packaged UAT evidence.
 */
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import { composerSendBlocked, submitComposerDraft } from "@shared/composer-guard";
import { describe, expect, it } from "vitest";
import {
  countingManager,
  engineFor,
  passingResult,
  planTask,
  recordingWorker,
  settle,
  workflowFixture,
} from "./support/workflow-fixture";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function undecidedReviewRun() {
  const f = await workflowFixture();
  const { manager, turns } = countingManager(
    f.store,
    { tasks: [planTask("Write")] },
    async () => undefined,
  );
  const { worker } = recordingWorker();
  const engine = engineFor(f, manager, worker);
  await engine.sendMessage(f.project.id, "Write a file");
  await engine.approveAndStart(f.project.id);
  await engine.waitForLocal(f.project.id);
  await engine.tick(f.project.id);
  return { f, engine, turns };
}

const isReminder = (prompt: string) => /review ended without a decision/i.test(prompt);
const reviewTurns = (turns: string[]) =>
  turns.filter((prompt) => /review/i.test(prompt) && !isReminder(prompt)).length;
const reminders = (turns: string[]) => turns.filter(isReminder).length;

describe("regression floor", () => {
  it("INV-01 a manager review without a decision pauses once and records an explanation", async () => {
    const { f, engine } = await undecidedReviewRun();
    await settle(engine, f.project.id);
    expect((await f.store.getProject(f.project.id))?.status).toBe("paused");
    expect((await f.store.getTasks(f.project.id))[0].status).toBe("needs_review");
    const explanations = (await f.store.getMessages(f.project.id)).filter((message) =>
      /finished this review without accepting/i.test(message.text),
    );
    expect(explanations).toHaveLength(1);
  });

  it("INV-01b a revised plan proposed during review awaits approval instead of pausing", async () => {
    const f = await workflowFixture();
    const { manager } = countingManager(f.store, { tasks: [planTask("Write")] }, async (ctx) => {
      await ctx.host.proposePlan({
        summary: "Split the remaining work",
        acceptanceCriteria: ["Work is done"],
        tasks: [planTask("Fix the tests")],
      });
    });
    const { worker } = recordingWorker();
    const engine = engineFor(f, manager, worker);
    await engine.sendMessage(f.project.id, "Write a file");
    await engine.approveAndStart(f.project.id);
    await engine.waitForLocal(f.project.id);
    await engine.tick(f.project.id);
    await settle(engine, f.project.id);
    expect((await f.store.getProject(f.project.id))?.status).toBe("awaiting_approval");
    expect(await f.store.getPendingBoard(f.project.id)).toBeDefined();
    const explanations = (await f.store.getMessages(f.project.id)).filter((message) =>
      /finished this review without accepting/i.test(message.text),
    );
    expect(explanations).toHaveLength(0);
  });

  it("INV-02 polling while paused produces zero additional review requests", async () => {
    const { f, engine, turns } = await undecidedReviewRun();
    const before = turns.length;
    await settle(engine, f.project.id, 10);
    expect(turns.length).toBe(before);
  });

  it("INV-03 resume produces exactly one new review", async () => {
    const { f, engine, turns } = await undecidedReviewRun();
    const before = reviewTurns(turns);
    const remindedBefore = reminders(turns);
    await engine.start(f.project.id);
    await settle(engine, f.project.id);
    expect(reviewTurns(turns)).toBe(before + 1);
    // An undecided review gets exactly one reminder, then waits for the owner.
    expect(reminders(turns)).toBe(remindedBefore + 1);
    expect((await f.store.getProject(f.project.id))?.status).toBe("paused");
  });

  it("INV-04 accepting a task starts the next eligible dependent task exactly once", async () => {
    const f = await workflowFixture();
    const { manager } = countingManager(f.store, {
      tasks: [planTask("First"), planTask("Second", { dependsOn: ["First"] })],
    });
    const { worker, runs } = recordingWorker();
    const engine = engineFor(f, manager, worker);
    await engine.sendMessage(f.project.id, "Two steps");
    await engine.approveAndStart(f.project.id);
    await settle(engine, f.project.id, 12);
    expect(runs).toEqual(["First", "Second"]);
    const tasks = await f.store.getTasks(f.project.id);
    expect(tasks.map((task) => task.attempts.length)).toEqual([1, 1]);
    expect((await f.store.getProject(f.project.id))?.status).toBe("completed");
  });

  it("INV-05 worker completion is not treated as manager acceptance", async () => {
    const { f } = await undecidedReviewRun();
    const [task] = await f.store.getTasks(f.project.id);
    expect(task.attempts[0].status).toBe("completed");
    expect(task.status).toBe("needs_review");
    expect((await f.store.getProject(f.project.id))?.status).not.toBe("completed");
  });

  it("INV-06 plan amendments cannot silently replace approved authority or inherit unrelated accepted work", async () => {
    const f = await workflowFixture();
    let amended = false;
    const { manager } = countingManager(
      f.store,
      { tasks: [planTask("First"), planTask("Second", { dependsOn: ["First"] })] },
      async (ctx, review) => {
        await ctx.host.requestApplyResult(review.id);
        if (amended) return;
        amended = true;
        await ctx.host.proposePlan({
          summary: "Changed approach",
          acceptanceCriteria: ["Different"],
          tasks: [planTask("First"), planTask("Unrelated")],
        });
      },
    );
    const { worker, runs } = recordingWorker();
    const engine = engineFor(f, manager, worker);
    await engine.sendMessage(f.project.id, "Two steps");
    await engine.approveAndStart(f.project.id);
    await settle(engine, f.project.id);
    const plan = await f.store.getPlan(f.project.id);
    expect(plan).toMatchObject({ revision: 1, approved: true });
    expect((await f.store.getTasks(f.project.id)).map((task) => task.title)).toEqual([
      "First",
      "Second",
    ]);
    const pending = await f.store.getPendingBoard(f.project.id);
    expect(pending?.plan.approved).toBe(false);
    expect(runs).toEqual(["First"]);
    await engine.approvePlan(f.project.id);
    const merged = await f.store.getTasks(f.project.id);
    expect(merged.find((task) => task.title === "First")?.status).toBe("applied");
    const unrelated = merged.find((task) => task.title === "Unrelated");
    expect(unrelated?.status).not.toBe("applied");
    expect(unrelated?.attempts).toEqual([]);
  });

  it("INV-07 interactive work submits no Durable job or source snapshot", async () => {
    const f = await workflowFixture();
    const approvals = new ApprovalBroker();
    const kinds: string[] = [];
    const request = approvals.request.bind(approvals);
    approvals.request = (input, signal) => {
      kinds.push(input.kind);
      return request(input, signal);
    };
    const { manager } = countingManager(f.store, { tasks: [planTask("Write")] });
    const { worker } = recordingWorker();
    const engine = engineFor(f, manager, worker, approvals);
    await engine.sendMessage(f.project.id, "Write");
    await engine.approveAndStart(f.project.id);
    await settle(engine, f.project.id);
    expect((await f.store.getProject(f.project.id))?.status).toBe("completed");
    expect(f.backend.submits).toBe(0);
    expect(kinds).not.toContain("durable");
    const project = await f.store.getProject(f.project.id);
    expect(project?.source.kind === "local_folder" && project.source.snapshotSha256).toBe("");
    expect(project?.budget.jobsSubmitted).toBe(0);
  });

  it("INV-09 interrupted inference preserves work and evidence without consuming repair budget", async () => {
    const f = await workflowFixture();
    const { manager } = countingManager(
      f.store,
      { tasks: [planTask("Write")] },
      async (ctx, review) => {
        if (review.attempts.length === 1)
          await ctx.host.requestRepair(review.id, "Stream ended; continue.");
        else await ctx.host.requestApplyResult(review.id);
      },
    );
    const { worker, runs } = recordingWorker((run) =>
      run === 1
        ? { ...passingResult("partial.txt"), error: "terminated" }
        : passingResult("final.txt"),
    );
    const engine = engineFor(f, manager, worker);
    await engine.sendMessage(f.project.id, "Write");
    await engine.approveAndStart(f.project.id);
    await engine.waitForLocal(f.project.id);
    const [interrupted] = await f.store.getTasks(f.project.id);
    expect(interrupted.attempts[0]).toMatchObject({
      status: "uncertain",
      failureClass: "ambiguous_inference",
    });
    expect(interrupted.attempts[0].result?.provenance?.changedFiles).toEqual(["partial.txt"]);
    await settle(engine, f.project.id);
    const [task] = await f.store.getTasks(f.project.id);
    expect(runs).toHaveLength(2);
    expect(task.repairCount).toBe(0);
    expect(task.recoveryCount).toBe(1);
    expect(task.attempts).toHaveLength(2);
    expect(await readFile(join(f.folder, "partial.txt"), "utf8")).toBe("Write\n");
    expect((await f.store.getProject(f.project.id))?.status).toBe("completed");
  });

  it("INV-11 pending approvals cannot be bypassed through the composer", async () => {
    const f = await workflowFixture();
    const approvals = new ApprovalBroker();
    const { manager, turns } = countingManager(f.store, { tasks: [planTask("Write")] });
    const engine = engineFor(f, manager, undefined, approvals);
    const decision = approvals.request({
      projectId: f.project.id,
      projectName: f.project.name,
      planRevision: 0,
      kind: "bash",
      action: "rm -rf build",
      reason: "test",
    });
    expect(composerSendBlocked({ approvals: approvals.list(), projectId: f.project.id })).toMatch(
      /approval card/,
    );
    await expect(engine.sendMessage(f.project.id, "yes, go ahead")).rejects.toThrow(
      /approval card/,
    );
    await expect(engine.reply(f.project.id, "allow")).rejects.toThrow(/approval card/);
    expect(turns).toHaveLength(0);
    expect(approvals.list()).toHaveLength(1);
    approvals.cancel(f.project.id);
    expect(await decision).toBe(false);
  });

  it("INV-12 failed message submission preserves the user's draft", async () => {
    let draft = "Please build it";
    const failed = await submitComposerDraft(draft, {
      clear: () => {
        draft = "";
      },
      restore: (text) => {
        draft = text;
      },
      current: () => draft,
      send: async () => {
        throw new Error("offline");
      },
    });
    expect(failed.ok).toBe(false);
    expect(draft).toBe("Please build it");
    const sent = await submitComposerDraft(draft, {
      clear: () => {
        draft = "";
      },
      restore: (text) => {
        draft = text;
      },
      current: () => draft,
      send: async () => undefined,
    });
    expect(sent.ok).toBe(true);
    expect(draft).toBe("");
  });

  it("INV-13 restart restores state without replaying completed work", async () => {
    const f = await workflowFixture();
    const plan = { tasks: [planTask("First"), planTask("Second", { dependsOn: ["First"] })] };
    const first = countingManager(f.store, plan, async (ctx, review) => {
      if (review.title === "First") await ctx.host.requestApplyResult(review.id);
    });
    const { worker, runs } = recordingWorker();
    const engine = engineFor(f, first.manager, worker);
    await engine.sendMessage(f.project.id, "Two steps");
    await engine.approveAndStart(f.project.id);
    await settle(engine, f.project.id);
    expect(runs).toEqual(["First", "Second"]);
    await engine.shutdown();

    const second = countingManager(f.store, plan);
    const restarted = engineFor(f, second.manager, worker);
    await restarted.recover(f.project.id);
    expect((await f.store.getProject(f.project.id))?.status).toBe("paused");
    await settle(restarted, f.project.id);
    expect(second.turns).toHaveLength(0);
    await restarted.start(f.project.id);
    await settle(restarted, f.project.id);
    expect(runs).toEqual(["First", "Second"]);
    const tasks = await f.store.getTasks(f.project.id);
    expect(tasks.map((task) => [task.status, task.attempts.length])).toEqual([
      ["applied", 1],
      ["applied", 1],
    ]);
    expect((await f.store.getProject(f.project.id))?.status).toBe("completed");
  });

  it("INV-14 documentation-only acceptance does not require fabricated test evidence", async () => {
    const f = await workflowFixture();
    const { manager } = countingManager(f.store, { tasks: [planTask("Docs")] });
    const { worker } = recordingWorker(() => ({
      output: "Updated README",
      changedFiles: ["README.md"],
      patch: "+docs",
      verification: { status: "unverified", commands: [] },
    }));
    const engine = engineFor(f, manager, worker);
    await engine.sendMessage(f.project.id, "Document it");
    await engine.approveAndStart(f.project.id);
    await settle(engine, f.project.id);
    const [task] = await f.store.getTasks(f.project.id);
    expect(task.status).toBe("applied");
    expect(task.attempts[0].result?.verification).toEqual({ status: "unverified", commands: [] });
    expect((await f.store.getProject(f.project.id))?.status).toBe("completed");
  });
});
