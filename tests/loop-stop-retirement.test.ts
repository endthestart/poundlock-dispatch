import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { retireLegacyLoopStop } from "@core/loop-stop-retirement";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { TURN_BUDGET_STOP } from "@shared/policy-limits";
import { projectStatusView } from "@shared/project-status";
import { defaultBudget, type ProjectRecord, type TaskRecord } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

/** A project as a version before 19 Sep left it when a task ran out of attempts. */
async function legacyProject(
  status: ProjectRecord["status"],
  stopReason: string,
  taskStatus: TaskRecord["status"],
) {
  const root = await tempDir("dispatch-loop-stop-");
  const folder = join(root, "project");
  await mkdir(folder);
  const store = new FileStore(join(root, "data"));
  await store.init();
  const project = await createFolderProject({ store, folder, name: "legacy" });
  project.status = status;
  project.pause =
    status === "paused" ? { cause: "dispatch_closed", detail: "closed", at: "t" } : undefined;
  project.budget = { ...defaultBudget(), stopReason };
  await store.saveProject(project);
  await store.saveTasks(project.id, [
    {
      id: "t1",
      title: "Audit",
      objective: "Audit",
      workerPrompt: "Audit",
      acceptanceCriteria: "Written",
      dependsOn: [],
      difficulty: "small",
      contextNote: "",
      status: taskStatus,
      repairCount: 2,
      recoveryCount: 3,
      attempts: [],
    },
  ]);
  await store.savePlan(project.id, {
    revision: 1,
    summary: "Day 1",
    acceptanceCriteria: [],
    authority: "docs",
    approved: true,
    createdAt: "t",
  });
  return { store, id: project.id };
}

describe("a legacy exhausted-budget stop", () => {
  it("becomes a stuck task awaiting review, with Retry task offered", async () => {
    const { store, id } = await legacyProject(
      "paused",
      "Recovery budget exhausted for “Audit”. Remaining results are kept.",
      "failed",
    );
    await retireLegacyLoopStop(store, id);

    const project = (await store.getProject(id))!;
    const tasks = await store.getTasks(id);
    expect(project.budget.stopReason).toBeUndefined();
    expect(project.status).toBe("paused");
    expect(project.pause?.cause).toBe("undecided_review");
    expect(tasks[0].status).toBe("needs_review");
    expect(tasks[0].stuck?.reason).toMatch(/interrupted too many times/);
    // Counters stay until the owner decides, as for any stuck task.
    expect(tasks[0].recoveryCount).toBe(3);

    const view = projectStatusView({
      project,
      plan: await store.getPlan(id),
      tasks,
      messages: [],
    });
    expect(view.cause).toBe("stuck_task");
    expect(view.next).toMatch(/interrupted too many times/);
    expect(view.next).not.toMatch(/budget/i);
    expect(view.actions).toContainEqual(
      expect.objectContaining({ id: "retry_task", taskId: "t1", primary: true }),
    );
  });

  it("pauses a stopped run for Resume when no task is still failed", async () => {
    const { store, id } = await legacyProject(
      "failed",
      "Repair budget exhausted for “Audit”. Remaining results are kept.",
      "needs_review",
    );
    await retireLegacyLoopStop(store, id);

    const project = (await store.getProject(id))!;
    expect(project.budget.stopReason).toBeUndefined();
    expect(project.status).toBe("paused");
    expect(project.pause?.cause).toBe("awaiting_resume");
    expect((await store.getTasks(id))[0].stuck).toBeUndefined();
  });

  it("leaves any other stop as it is", async () => {
    const { store, id } = await legacyProject("paused", TURN_BUDGET_STOP, "failed");
    const before = await store.getProject(id);
    await retireLegacyLoopStop(store, id);
    expect(await store.getProject(id)).toEqual(before);
    expect((await store.getTasks(id))[0].status).toBe("failed");
  });
});
