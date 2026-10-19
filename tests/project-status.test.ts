import { TURN_BUDGET_STOP } from "@shared/policy-limits";
import {
  planProgressEvidence,
  projectStatusView,
  runStopBlocksResume,
} from "@shared/project-status";
import { defaultBudget, defaultPolicy, type TaskStatus } from "@shared/types";
import { expect, it } from "vitest";

function tasks(...status: TaskStatus[]) {
  return status.map((item) => ({ status: item }));
}

it("names the current task instead of counting overlapping started work", () => {
  expect(planProgressEvidence(tasks("applied", "running", "ready", "blocked"))).toBe(
    "1 of 4 tasks accepted. Task 2 of 4 started.",
  );
});

it("does not treat an accepted task as a second started count", () => {
  expect(planProgressEvidence(tasks("applied", "queued", "ready", "blocked"))).toBe(
    "1 of 4 tasks accepted. Task 2 of 4 started.",
  );
});

it("says when the next unpublished task is waiting", () => {
  expect(planProgressEvidence(tasks("applied", "ready", "blocked", "blocked"))).toBe(
    "1 of 4 tasks accepted. Task 2 of 4 is next.",
  );
});

it("reports review and completion without a started tally", () => {
  expect(planProgressEvidence(tasks("applied", "needs_review", "ready"))).toBe(
    "1 of 3 tasks accepted. Task 2 of 3 is in review.",
  );
  expect(planProgressEvidence(tasks("applied", "applied", "applied"))).toBe(
    "All 3 tasks accepted.",
  );
  expect(planProgressEvidence(tasks("applied"))).toBe("The task was accepted.");
});

it("names parallel in-flight work", () => {
  expect(planProgressEvidence(tasks("applied", "running", "queued"))).toBe(
    "1 of 3 tasks accepted. Tasks 2 and 3 of 3 started.",
  );
});

it("asks to resume when a paused run still has a task in review", () => {
  const view = projectStatusView({
    project: {
      id: "p",
      name: "recipe-box",
      archived: false,
      createdAt: "t",
      updatedAt: "t",
      status: "paused",
      source: {
        kind: "local_folder",
        originalPath: "/tmp",
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
      planRevision: 6,
      workflowId: "w",
      managerSessionId: "m",
      eventCursor: 0,
    },
    plan: {
      revision: 6,
      summary: "Day 4",
      acceptanceCriteria: [],
      authority: "docs",
      approved: true,
      createdAt: "t",
    },
    tasks: [
      {
        id: "t1",
        title: "Audit Day 4 status",
        objective: "Audit",
        workerPrompt: "Audit",
        acceptanceCriteria: "Written",
        dependsOn: [],
        difficulty: "small",
        contextNote: "",
        status: "needs_review",
        repairCount: 0,
        attempts: [],
      },
      {
        id: "t2",
        title: "Reconcile roadmap",
        objective: "Reconcile",
        workerPrompt: "Reconcile",
        acceptanceCriteria: "Written",
        dependsOn: ["t1"],
        difficulty: "small",
        contextNote: "",
        status: "blocked",
        repairCount: 0,
        attempts: [],
      },
    ],
    messages: [],
  });
  expect(view.title).toBe("Review needs a decision");
  expect(view.next).toMatch(/Resume sends that result/i);
  expect(view.canResume).toBe(true);
});

it("covers an empty or idle board", () => {
  expect(planProgressEvidence([])).toBe("No worker tasks have been started.");
  expect(planProgressEvidence(tasks("blocked", "blocked", "blocked", "blocked"))).toBe(
    "4 tasks on the board. None started.",
  );
  expect(planProgressEvidence(tasks("running"))).toBe("Task 1 of 1 started.");
});

it("rescues a legacy exhausted-budget dead end with a stuck-task decision card instead of Resume", () => {
  const snapshot = {
    project: {
      id: "p",
      name: "recipe-box",
      archived: false,
      createdAt: "t",
      updatedAt: "t",
      status: "paused" as const,
      source: {
        kind: "local_folder" as const,
        originalPath: "/tmp",
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
      budget: {
        ...defaultBudget(),
        stopReason: "Recovery budget exhausted for “Audit”. Remaining results are kept.",
      },
      integration: { headRevision: "x", expectedBase: "x", appliedPatchSha256: [] },
      planRevision: 6,
      workflowId: "w",
      managerSessionId: "m",
      eventCursor: 0,
    },
    plan: {
      revision: 6,
      summary: "Day 4",
      acceptanceCriteria: [],
      authority: "docs",
      approved: true,
      createdAt: "t",
    },
    tasks: [
      {
        id: "t1",
        title: "Audit",
        objective: "Audit",
        workerPrompt: "Audit",
        acceptanceCriteria: "Written",
        dependsOn: [],
        difficulty: "small" as const,
        contextNote: "",
        status: "failed" as const,
        repairCount: 0,
        attempts: [],
      },
    ],
    messages: [],
  };
  const view = projectStatusView(snapshot);
  // A pre-Phase-1 project stuck at the old "budget exhausted" dead end gets a
  // stuck-task decision card, not a dead "Work stopped" message: Retry task
  // is offered, Resume never is (it would just re-throw the same stop).
  expect(view.cause).toBe("stuck_task");
  expect(view.title).toBe("A task needs your direction");
  expect(view.next).toMatch(/interrupted too many times/);
  expect(view.next).not.toMatch(/budget/i);
  expect(view.canResume).toBe(false);
  expect(view.canOverride).toBe(false);
  expect(view.actions).toContainEqual(
    expect.objectContaining({ id: "retry_task", taskId: "t1", primary: true }),
  );
});

it("shows the stuck-task decision card when the manager ends a review without choosing", () => {
  const snapshot = {
    project: {
      id: "p",
      name: "recipe-box",
      archived: false,
      createdAt: "t",
      updatedAt: "t",
      status: "paused" as const,
      pause: { cause: "undecided_review" as const, detail: "no decision", at: "t" },
      source: {
        kind: "local_folder" as const,
        originalPath: "/tmp",
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
      planRevision: 6,
      workflowId: "w",
      managerSessionId: "m",
      eventCursor: 0,
    },
    plan: {
      revision: 6,
      summary: "Day 4",
      acceptanceCriteria: [],
      authority: "docs",
      approved: true,
      createdAt: "t",
    },
    tasks: [
      {
        id: "t1",
        title: "Broken",
        objective: "fix",
        workerPrompt: "fix",
        acceptanceCriteria: "tests pass",
        dependsOn: [],
        difficulty: "small" as const,
        contextNote: "",
        status: "needs_review" as const,
        repairCount: 2,
        attempts: [],
        stuck: {
          since: "t",
          category: "work_quality" as const,
          reason: 'Check "pytest" failed: AssertionError',
          brief: 'Task "Broken" is stuck (Work quality): …',
        },
      },
    ],
    messages: [],
  };
  const view = projectStatusView(snapshot);
  expect(view.cause).toBe("stuck_task");
  expect(view.title).toBe("A task needs your direction");
  expect(view.next).toMatch(/Work quality/);
  expect(view.next).toMatch(/AssertionError/);
  expect(view.actions).toContainEqual(
    expect.objectContaining({ id: "retry_task", taskId: "t1", primary: true }),
  );
  // Resume genuinely works here (no stopReason blocks it), so it stays
  // offered alongside Retry task rather than being suppressed.
  expect(view.canResume).toBe(true);
  // An override only records a note; on a stuck task it looked like a fix.
  expect(view.canOverride).toBe(false);
});

it("gives a changed route the specific Settings instruction, from the structured needsInput.kind", () => {
  const view = projectStatusView({
    project: {
      id: "p",
      name: "recipe-box",
      archived: false,
      createdAt: "t",
      updatedAt: "t",
      status: "needs_input",
      source: {
        kind: "local_folder",
        originalPath: "/tmp",
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
      managerSessionId: "m",
      eventCursor: 0,
      needsInput: {
        question:
          "The authorized worker route changed in Poundlock. Review its destination before retrying.",
        askedAt: "t",
        // Structured, not a substring match on the question text.
        kind: "route_change",
      },
    },
    tasks: [],
    messages: [],
  });
  expect(view.cause).toBe("route_change");
  expect(view.title).toBe("Profile route changed");
  expect(view.next).toMatch(/route changed in Poundlock/);
  expect(view.next).toMatch(/Settings → Models and routing/);
  expect(view.next).toMatch(/Approve current route/);
});

it("keeps a manager question with options a question, answered on its card or in words", () => {
  const view = projectStatusView({
    project: {
      id: "p",
      name: "recipe-box",
      archived: false,
      createdAt: "t",
      updatedAt: "t",
      status: "needs_input",
      source: {
        kind: "local_folder",
        originalPath: "/tmp",
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
      managerSessionId: "m",
      eventCursor: 0,
      needsInput: {
        question: "Which scope comes first?",
        askedAt: "t",
        kind: "question",
        choices: [
          { id: "option:1", label: "Catalog and export" },
          { id: "option:2", label: "Full workflow" },
        ],
      },
    },
    tasks: [],
    messages: [],
  });
  expect(view.cause).toBe("question");
  expect(view.actions.map((action) => action.id)).toContain("reply");
  expect(view.actions.some((action) => action.id === "choose")).toBe(false);
});

it("offers only read on a folder card that asked for read", () => {
  const base = projectStatusView({
    project: {
      id: "p",
      name: "x",
      archived: false,
      createdAt: "t",
      updatedAt: "t",
      status: "needs_input",
      source: {
        kind: "local_folder",
        originalPath: "/tmp",
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
      managerSessionId: "m",
      eventCursor: 0,
      needsInput: {
        question: "May this project read /src/other?",
        askedAt: "t",
        kind: "folder_access",
        folder: { path: "/src/other", mode: "read", reason: "Reuse" },
        choices: [
          { id: "folder:read", label: "Allow read-only" },
          { id: "folder:deny", label: "Don't allow" },
        ],
      },
    },
    tasks: [],
    messages: [],
  });
  expect(base.next).toMatch(/^Allow it read-only, or refuse\./);
});

it("lets Resume continue past the manager-turn cap", () => {
  expect(runStopBlocksResume({ budget: { stopReason: TURN_BUDGET_STOP } })).toBe(false);
  // A stop recorded before 0.2.6, with the older wording, resumes too.
  expect(
    runStopBlocksResume({
      budget: {
        stopReason: "The manager-turn budget is exhausted. Remaining worker results are kept.",
      },
    }),
  ).toBe(false);
  expect(runStopBlocksResume({ budget: { stopReason: "Cancelled by you." } })).toBe(true);
});
