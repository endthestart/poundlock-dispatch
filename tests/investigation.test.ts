/**
 * The manager's `investigate` tool: a read-only worker answers now, inside the
 * turn, with no plan, task or board change. A review once went through
 * delegate_task and produced a one-task plan to approve.
 */

import type { WorkerContext, WorkerResult } from "@core/interactive-worker";
import type { ManagerPort, ManagerTurnContext } from "@core/orchestration";
import { describe, expect, it } from "vitest";
import { engineFor, planTask, workflowFixture } from "./support/workflow-fixture";

const unverified = { status: "unverified" as const, commands: [] };

function investigatingManager(onReport: (report: string) => void, plan = false): ManagerPort {
  let turn = 0;
  return {
    async runTurn(ctx: ManagerTurnContext) {
      turn += 1;
      if (plan && turn === 1) {
        await ctx.host.proposePlan({
          summary: "Build the feature",
          acceptanceCriteria: ["Feature works"],
          tasks: [planTask("Build it")],
        });
        return { text: "Plan recorded", toolTrace: [{ name: "propose_plan", summary: "ok" }] };
      }
      const report = await ctx.host.investigate({
        title: "Review commits a..b",
        question: "Are there bugs in git diff a..b?",
        instructions: "Read the diff by file and report findings with evidence.",
      });
      onReport(report);
      return { text: `Review: ${report}`, toolTrace: [{ name: "investigate", summary: "ok" }] };
    },
  };
}

function worker(result: Partial<WorkerResult>, seen: WorkerContext[]) {
  return {
    async run(ctx: WorkerContext): Promise<WorkerResult> {
      seen.push(ctx);
      return { output: "", changedFiles: [], patch: "", verification: unverified, ...result };
    },
  };
}

describe("investigate", () => {
  it("runs a read-only worker and returns its report, with no plan or task", async () => {
    const f = await workflowFixture({ prefix: "investigate-" });
    const seen: WorkerContext[] = [];
    let report = "";
    const engine = engineFor(
      f,
      investigatingManager((text) => {
        report = text;
      }),
      worker({ output: "Found an off-by-one in app.py:3 (commit 5d6e7f8)." }, seen),
    );
    await engine.sendMessage(f.project.id, "Review commits a..b");
    expect(seen).toHaveLength(1);
    expect(seen[0].readOnly).toBe(true);
    expect(seen[0].task.taskKind).toBe("open_investigation");
    expect(report).toContain("off-by-one in app.py:3");
    expect(report).toMatch(/read-only; nothing in the project was changed/);
    expect(await f.store.getPlan(f.project.id)).toBeUndefined();
    expect(await f.store.getTasks(f.project.id)).toEqual([]);
    const messages = await f.store.getMessages(f.project.id);
    expect(messages.some((m) => m.text.startsWith("Investigating with coding"))).toBe(true);
  });

  it("leaves a published plan as it was", async () => {
    const f = await workflowFixture({ prefix: "investigate-plan-" });
    const seen: WorkerContext[] = [];
    const engine = engineFor(
      f,
      investigatingManager(() => undefined, true),
      worker({ output: "No findings." }, seen),
    );
    await engine.sendMessage(f.project.id, "Build the feature");
    const plan = await f.store.getPlan(f.project.id);
    const tasks = await f.store.getTasks(f.project.id);
    const status = (await f.store.getProject(f.project.id))?.status;
    expect(plan?.summary).toBe("Build the feature");
    await engine.sendMessage(f.project.id, "While that waits, review commits a..b");
    expect(seen).toHaveLength(1);
    expect(await f.store.getPlan(f.project.id)).toEqual(plan);
    expect(await f.store.getTasks(f.project.id)).toEqual(tasks);
    expect((await f.store.getProject(f.project.id))?.status).toBe(status);
  });

  it("tells the manager to split a question that filled the worker's context", async () => {
    const f = await workflowFixture({ prefix: "investigate-context-" });
    let report = "";
    const engine = engineFor(
      f,
      investigatingManager((text) => {
        report = text;
      }),
      worker(
        {
          error:
            "context_limit: The worker's context window filled up before it could reply. Ask for less at once.",
        },
        [],
      ),
    );
    await engine.sendMessage(f.project.id, "Review commits a..b");
    expect(report).toMatch(/too big for one worker context\. Split it/);
  });

  it("hands the manager the exact error as an operational failure", async () => {
    const f = await workflowFixture({ prefix: "investigate-fail-" });
    let report = "";
    const error =
      "git log failed (exit 128).\nfatal: could not open '/dev/null' for reading and writing: Operation not permitted";
    const engine = engineFor(
      f,
      investigatingManager((text) => {
        report = text;
      }),
      worker({ error, output: "Stopped: git could not run." }, []),
    );
    await engine.sendMessage(f.project.id, "Review commits a..b");
    expect(report).toContain(`Exact error: ${error}`);
    expect(report).toMatch(/operational problem .*not a reasoning failure/);
    expect(report).toContain("Stopped: git could not run.");
    const messages = await f.store.getMessages(f.project.id);
    expect(messages.some((m) => m.text.startsWith("Investigation stopped:"))).toBe(true);
    expect(await f.store.getPlan(f.project.id)).toBeUndefined();
  });
});
