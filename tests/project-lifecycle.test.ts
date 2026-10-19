/**
 * Plan section 9 (backend): lifecycle actions bound to stable identity,
 * guarded against active states, and safe removal.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import type { WorkerPort } from "@core/interactive-worker";
import { projectFiles } from "@core/paths";
import { ProjectLifecycle } from "@core/project-lifecycle";
import { createFolderProject } from "@core/projects";
import { projectLifecycleActions } from "@shared/project-status";
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

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function snapshotOf(f: WorkflowFixture, id = f.project.id): Promise<ProjectSnapshot> {
  return {
    project: (await f.store.getProject(id))!,
    plan: await f.store.getPlan(id),
    tasks: await f.store.getTasks(id),
    pendingBoard: await f.store.getPendingBoard(id),
    messages: await f.store.getMessages(id),
  };
}

async function completedProject() {
  const f = await workflowFixture();
  await writeFile(join(f.folder, "source.py"), "print('keep me')\n");
  const approvals = new ApprovalBroker();
  const { manager } = countingManager(f.store, { tasks: [planTask("Write")] });
  const engine = engineFor(f, manager, recordingWorker().worker, approvals);
  await engine.sendMessage(f.project.id, "Write");
  await engine.approveAndStart(f.project.id);
  await settle(engine, f.project.id);
  const lifecycle = new ProjectLifecycle({ store: f.store, orchestrator: engine, approvals });
  return { f, engine, approvals, lifecycle };
}

describe("project removal", () => {
  it("removes only Dispatch-owned state, never the source, global settings or other projects", async () => {
    const { f, lifecycle } = await completedProject();
    const otherFolder = join(f.root, "other");
    await mkdir(otherFolder);
    const other = await createFolderProject({ store: f.store, folder: otherFolder });
    await f.store.savePermissions({
      defaultMode: "assist",
      grants: {
        [f.project.id]: [{ kind: "bash", action: "a", cwd: f.folder }],
        [other.id]: [{ kind: "bash", action: "b", cwd: otherFolder }],
      },
    });
    await f.store.saveUiPreferences({
      ...(await f.store.getUiPreferences()),
      desktopNotifications: true,
    });
    const connectionBefore = await f.store.getConnection();

    const text = await lifecycle.run("remove", {
      projectId: f.project.id,
      workflowId: f.project.workflowId,
    });

    expect(text).toMatch(/original folder or remote repository was not deleted/);
    expect(await readFile(join(f.folder, "source.py"), "utf8")).toBe("print('keep me')\n");
    expect(await exists(join(f.folder, "write-1.txt"))).toBe(true);
    expect(await exists(projectFiles(f.store.layout.root, f.project.id).dir)).toBe(false);
    expect(await f.store.getProject(f.project.id)).toBeUndefined();
    expect(await f.store.getProject(other.id)).toBeDefined();
    expect(await exists(projectFiles(f.store.layout.root, other.id).dir)).toBe(true);
    const permissions = await f.store.getPermissions();
    expect(permissions.defaultMode).toBe("assist");
    expect(permissions.grants).toEqual({
      [other.id]: [{ kind: "bash", action: "b", cwd: otherFolder }],
    });
    expect((await f.store.getUiPreferences()).desktopNotifications).toBe(true);
    expect(await f.store.getConnection()).toEqual(connectionBefore);
  });

  it("blocks removal while a worker is running, and allows it once the run is cancelled", async () => {
    const f = await workflowFixture();
    // A worker that runs until it is told to stop.
    const worker: WorkerPort = {
      async run(ctx) {
        await new Promise<void>((resolve) =>
          ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return passingResult("late.txt");
      },
    };
    const { manager } = countingManager(f.store, { tasks: [planTask("Slow")] });
    const engine = engineFor(f, manager, worker);
    await engine.sendMessage(f.project.id, "Slow");
    await engine.approveAndStart(f.project.id);
    const lifecycle = new ProjectLifecycle({ store: f.store, orchestrator: engine });
    const target = { projectId: f.project.id };
    await expect(lifecycle.run("remove", target)).rejects.toThrow(/Cannot remove this project yet/);
    expect(await f.store.getProject(f.project.id)).toBeDefined();

    await engine.cancel(f.project.id);
    await lifecycle.run("remove", target);
    expect(await f.store.getProject(f.project.id)).toBeUndefined();
  });

  it("finishes an interrupted removal on restart without touching the source", async () => {
    const { f, engine } = await completedProject();
    const project = (await f.store.getProject(f.project.id))!;
    project.removing = { startedAt: new Date().toISOString() };
    await f.store.saveProject(project);
    // Dispatch "crashes" here; a new process finishes the recorded removal.
    const restarted = new ProjectLifecycle({ store: f.store, orchestrator: engine });
    await expect(restarted.run("archive", { projectId: f.project.id })).rejects.toThrow(
      /no longer in Dispatch/,
    );
    expect(await restarted.completeInterruptedRemovals()).toEqual([f.project.id]);
    expect(await f.store.getProject(f.project.id)).toBeUndefined();
    expect(await exists(projectFiles(f.store.layout.root, f.project.id).dir)).toBe(false);
    expect(await readFile(join(f.folder, "source.py"), "utf8")).toBe("print('keep me')\n");
  });

  it("refuses when the attached folder lives inside the project's Dispatch data", async () => {
    const { f, lifecycle } = await completedProject();
    const nested = join(projectFiles(f.store.layout.root, f.project.id).dir, "attached");
    await mkdir(nested);
    await writeFile(join(nested, "keep.txt"), "source\n");
    const project = (await f.store.getProject(f.project.id))!;
    if (project.source.kind === "local_folder") project.source.originalPath = nested;
    await f.store.saveProject(project);
    await expect(lifecycle.run("remove", { projectId: f.project.id })).rejects.toThrow(
      /would delete source files/,
    );
    expect(await readFile(join(nested, "keep.txt"), "utf8")).toBe("source\n");
    expect((await f.store.getProject(f.project.id))?.removing).toBeUndefined();
  });
});

describe("lifecycle guards and identity", () => {
  it("rejects actions bound to a run that has since been replaced", async () => {
    const { f, lifecycle } = await completedProject();
    const stale = { projectId: f.project.id, workflowId: f.project.workflowId };
    await lifecycle.run("newRun", stale);
    const after = (await f.store.getProject(f.project.id))!;
    expect(after.workflowId).not.toBe(f.project.workflowId);
    await expect(lifecycle.run("remove", stale)).rejects.toThrow(/started a new run/);
    await expect(lifecycle.run("archive", stale)).rejects.toThrow(/started a new run/);
    expect(await f.store.getProject(f.project.id)).toBeDefined();
    expect(await readFile(join(f.folder, "source.py"), "utf8")).toBe("print('keep me')\n");
  });

  it.each([
    ["planning", /Project Manager to finish/],
    ["reviewing", /Pause or cancel/],
    ["running", /Pause or cancel/],
    ["waiting_for_capacity", /Pause or cancel/],
  ] as const)(
    "guards the %s state in the backend and the shared helper alike",
    async (status, reason) => {
      const { f, lifecycle } = await completedProject();
      const project = (await f.store.getProject(f.project.id))!;
      project.status = status;
      await f.store.saveProject(project);
      for (const action of ["newConversation", "newRun", "archive", "remove"] as const)
        await expect(lifecycle.run(action, { projectId: f.project.id }), action).rejects.toThrow(
          reason,
        );
      const views = projectLifecycleActions({ snapshot: await snapshotOf(f) });
      for (const view of views.filter((item) => item.id !== "unarchive")) {
        expect(view.available).toBe(false);
        expect(view.reason).toMatch(reason);
      }
    },
  );

  it("guards a pending approval and an unreconciled interrupted action", async () => {
    const { f, lifecycle, approvals } = await completedProject();
    const pending = approvals.request({
      projectId: f.project.id,
      projectName: "p",
      planRevision: 1,
      kind: "bash",
      action: "x",
      reason: "y",
    });
    await expect(lifecycle.run("remove", { projectId: f.project.id })).rejects.toThrow(
      /pending approval/,
    );
    expect(
      projectLifecycleActions({ snapshot: await snapshotOf(f), approvals: approvals.list() }).find(
        (view) => view.id === "remove",
      )?.available,
    ).toBe(false);
    approvals.cancel(f.project.id);
    await pending;
    const project = (await f.store.getProject(f.project.id))!;
    project.needsInput = { question: "?", askedAt: "t", kind: "tool_reconciliation" };
    await f.store.saveProject(project);
    await expect(lifecycle.run("newRun", { projectId: f.project.id })).rejects.toThrow(
      /interrupted action/,
    );
  });

  it("serializes lifecycle actions on one project", async () => {
    const { f, lifecycle } = await completedProject();
    const target = { projectId: f.project.id };
    const results = await Promise.allSettled([
      lifecycle.run("remove", target),
      lifecycle.run("archive", target),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(
      results.some(
        (result) =>
          result.status === "rejected" &&
          /still in progress|no longer in Dispatch/.test(String(result.reason)),
      ),
    ).toBe(true);
  });

  it("offers only the actions valid for the snapshot", async () => {
    const { f, lifecycle } = await completedProject();
    const active = projectLifecycleActions({ snapshot: await snapshotOf(f) });
    expect(active.filter((view) => view.available).map((view) => view.id)).toEqual([
      "newConversation",
      "newRun",
      "archive",
      "remove",
    ]);
    await lifecycle.run("archive", { projectId: f.project.id });
    const archived = projectLifecycleActions({ snapshot: await snapshotOf(f) });
    expect(archived.map((view) => view.id)).toContain("unarchive");
    await lifecycle.run("unarchive", { projectId: f.project.id });
    expect((await f.store.getProject(f.project.id))?.archived).toBe(false);
    const fresh = await workflowFixture();
    const empty = projectLifecycleActions({ snapshot: await snapshotOf(fresh) });
    expect(empty.find((view) => view.id === "newRun")).toMatchObject({
      available: false,
      reason: "There is no run to reset.",
    });
  });
});
