import { approvalView } from "@shared/approval-view";
import { lifecycleBlocker, projectMenuActions } from "@shared/project-actions";
import { projectLifecycleActions } from "@shared/project-status";
import { changedFiles, managerDecisionText, taskStateView } from "@shared/task-view";
import {
  type AttemptRecord,
  defaultBudget,
  defaultPolicy,
  type ProjectSnapshot,
  type ProjectStatus,
  type TaskRecord,
  type TaskStatus,
} from "@shared/types";
import { describe, expect, it } from "vitest";

function task(status: TaskStatus, attempts: Partial<AttemptRecord>[] = []): TaskRecord {
  return {
    id: `t-${status}`,
    title: status,
    objective: "",
    workerPrompt: "",
    acceptanceCriteria: "",
    dependsOn: [],
    difficulty: "small",
    contextNote: "",
    status,
    repairCount: 0,
    attempts: attempts.map((item, index) => ({
      id: `a${index}`,
      number: index + 1,
      idempotencyKey: "k",
      requestHash: "h",
      profileId: "p",
      profileName: "Worker",
      harnessId: "pi",
      status: "completed",
      createdAt: "t",
      selectionReason: "",
      ...item,
    })),
  } as TaskRecord;
}

function snapshot(
  status: ProjectStatus,
  extra: Partial<ProjectSnapshot> = {},
  project: Record<string, unknown> = {},
): ProjectSnapshot {
  return {
    project: {
      id: "p1",
      name: "Tasks app",
      archived: false,
      createdAt: "t",
      updatedAt: "t",
      status,
      source: {
        kind: "local_folder",
        originalPath: "/Users/me/tasks",
        capturedAt: "t",
        snapshotSha256: "x",
        baseRevision: "x",
        includedFiles: 1,
        includedBytes: 1,
        excludedPatterns: [],
        includedUncommitted: false,
        originalFingerprint: "x",
      },
      policy: defaultPolicy(),
      budget: defaultBudget(),
      integration: { headRevision: "x", expectedBase: "x", appliedPatchSha256: [] },
      planRevision: 1,
      managerSessionId: "s",
      eventCursor: 0,
      ...project,
    } as ProjectSnapshot["project"],
    tasks: [],
    messages: [{ id: "m", role: "user", text: "hi", createdAt: "t" }],
    ...extra,
  };
}

const plan = {
  revision: 2,
  summary: "Build it",
  acceptanceCriteria: [],
  authority: "",
  approved: true,
  createdAt: "t",
};

function ids(menu: ReturnType<typeof projectMenuActions>) {
  return menu.actions.map((item) => item.id);
}

describe("projectMenuActions", () => {
  it("offers every lifecycle action for an idle project with a finished run", () => {
    const menu = projectMenuActions({
      snapshot: snapshot("completed", { plan, tasks: [task("applied")] }),
    });
    expect(ids(menu)).toEqual([
      "newConversation",
      "newRun",
      "compact",
      "history",
      "settings",
      "archive",
      "remove",
    ]);
    expect(menu.blockedReason).toBeUndefined();
  });

  it("hides lifecycle actions while work is active and says why", () => {
    for (const status of ["planning", "running", "reviewing", "waiting_for_capacity"] as const) {
      const menu = projectMenuActions({ snapshot: snapshot(status, { plan }) });
      // Running work does not stop a compaction; the manager answering does.
      expect(ids(menu)).toEqual(
        status === "planning" || status === "reviewing"
          ? ["history", "settings"]
          : ["compact", "history", "settings"],
      );
      expect(menu.blockedReason).toBeTruthy();
    }
  });

  it("guards pending approvals, a running worker and busy state", () => {
    const idle = snapshot("paused", { plan, tasks: [task("running")] });
    expect(lifecycleBlocker({ snapshot: idle })).toBeUndefined();
    expect(lifecycleBlocker({ snapshot: idle, busy: true })).toMatch(/current action/);
    expect(lifecycleBlocker({ snapshot: idle, approvals: [{ projectId: "p1" }] })).toMatch(
      /approval/,
    );
    expect(lifecycleBlocker({ snapshot: idle, approvals: [{ projectId: "other" }] })).toBe(
      undefined,
    );
    const running = snapshot("paused", {
      plan,
      tasks: [task("running", [{ status: "running" }])],
    });
    expect(lifecycleBlocker({ snapshot: running })).toMatch(/worker is still running/);
    expect(ids(projectMenuActions({ snapshot: running }))).not.toContain("remove");
  });

  it("omits run actions when there is nothing to reset", () => {
    const empty = snapshot("draft", { messages: [] });
    expect(ids(projectMenuActions({ snapshot: empty }))).toEqual([
      "history",
      "settings",
      "archive",
      "remove",
    ]);
    const talkOnly = snapshot("draft");
    expect(ids(projectMenuActions({ snapshot: talkOnly }))).toContain("newConversation");
    expect(ids(projectMenuActions({ snapshot: talkOnly }))).not.toContain("newRun");
  });

  it("confirms destructive actions and promises the source folder is kept", () => {
    const menu = projectMenuActions({ snapshot: snapshot("completed", { plan }) });
    const remove = menu.actions.find((item) => item.id === "remove");
    expect(remove?.destructive).toBe(true);
    expect(remove?.confirm?.body).toContain("/Users/me/tasks is not touched");
    for (const id of ["newConversation", "newRun", "archive"]) {
      expect(menu.actions.find((item) => item.id === id)?.confirm).toBeTruthy();
    }
  });
});

describe("taskStateView", () => {
  it("gives a checkmark only to manager-accepted work", () => {
    const statuses: TaskStatus[] = [
      "blocked",
      "ready",
      "queued",
      "running",
      "needs_review",
      "repairing",
      "applied",
      "failed",
      "cancelled",
    ];
    const accepted = statuses.filter((status) => taskStateView(status).accepted);
    expect(accepted).toEqual(["applied"]);
    expect(taskStateView("needs_review").icon).not.toBe("check");
  });

  it("keeps queued, running, reviewing, blocked, failed and cancelled distinct", () => {
    const views = (["queued", "running", "needs_review", "blocked", "failed", "cancelled"] as const)
      .map(taskStateView)
      .map((view) => `${view.icon}:${view.label}`);
    expect(new Set(views).size).toBe(views.length);
  });

  it("describes the decision from workflow state, not worker completion", () => {
    expect(managerDecisionText(task("needs_review", [{ status: "completed" }]))).toMatch(/Waiting/);
    expect(managerDecisionText(task("applied"))).toMatch(/Accepted/);
  });
});

it("lists changed files from a unified diff", () => {
  const patch = [
    "diff --git a/app.py b/app.py",
    "--- a/app.py",
    "+++ b/app.py",
    "@@ -1 +1 @@",
    "--- /dev/null",
    "+++ b/new file.txt",
    "--- a/old.txt",
    "+++ /dev/null",
  ].join("\n");
  expect(changedFiles(patch)).toEqual(["app.py", "new file.txt", "old.txt"]);
});

it("describes approvals in ordinary language and keeps the exact command for expansion", () => {
  const view = approvalView({
    id: "a",
    projectId: "p1",
    projectName: "Tasks app",
    planRevision: 3,
    kind: "bash",
    action: "rm -rf build",
    reason: "Clean old output",
    cwd: "/Users/me/tasks",
  });
  expect(view.action).toBe("Run a command in tasks.");
  expect(view.exact).toBe("rm -rf build");
  expect(view.scope).toContain("/Users/me/tasks");
  expect(view.once).toBe("Allow once");
  expect(view.remember).not.toBe(view.once);
  expect(view.rememberDetail).toMatch(/Saves a permission/);
});

describe("Project menu shares the lifecycle authority", () => {
  it("shows exactly the available lifecycle actions, with their consequences", () => {
    for (const status of [
      "draft",
      "paused",
      "completed",
      "running",
      "cancelled",
    ] as ProjectStatus[]) {
      const input = { snapshot: snapshot(status, { plan: undefined, tasks: [task("ready")] }) };
      const available = projectLifecycleActions(input)
        .filter((item) => item.available && item.id !== "unarchive")
        .map((item) => item.id);
      const menu = projectMenuActions(input).actions.filter((item) =>
        ["newConversation", "newRun", "archive", "remove"].includes(item.id),
      );
      expect(menu.map((item) => item.id).sort()).toEqual([...available].sort());
      for (const item of menu) {
        const view = projectLifecycleActions(input).find((entry) => entry.id === item.id);
        expect(item.confirm?.body).toContain(view?.consequence);
      }
    }
  });
});
