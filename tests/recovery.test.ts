import { classifyInfrastructureError, recoveryEvidence } from "@core/recovery";
import { projectStatusView } from "@shared/project-status";
import { defaultBudget, defaultPolicy, type ProjectSnapshot, type TaskRecord } from "@shared/types";
import { describe, expect, it } from "vitest";

function snapshotWithStuckAttempt(
  attempt: Partial<TaskRecord["attempts"][number]>,
): ProjectSnapshot {
  const task: TaskRecord = {
    id: "t1",
    title: "Write the report",
    objective: "Write",
    workerPrompt: "Write",
    acceptanceCriteria: "Written",
    dependsOn: [],
    difficulty: "small",
    contextNote: "",
    status: "needs_review",
    repairCount: 0,
    recoveryCount: 0,
    attempts: [
      {
        id: "a1",
        number: 1,
        idempotencyKey: "k1",
        requestHash: "h1",
        profileId: "p",
        profileName: "vega-general",
        harnessId: "pi",
        execution: "interactive",
        status: "failed",
        createdAt: "t",
        selectionReason: "r",
        ...attempt,
      },
    ],
  };
  return {
    project: {
      id: "proj",
      name: "Example",
      archived: false,
      createdAt: "t",
      updatedAt: "t",
      // Paused with no specific cause, and a task still in review: the same
      // "undecided_review" state projectStatusView reaches after a worked
      // attempt lands in needs_review and nobody has decided yet.
      status: "paused",
      source: {
        kind: "local_folder",
        originalPath: "/tmp/example",
        capturedAt: "t",
        snapshotSha256: "",
        baseRevision: "",
        includedFiles: 0,
        includedBytes: 0,
        excludedPatterns: [],
        includedUncommitted: true,
        originalFingerprint: "",
      },
      policy: defaultPolicy(),
      budget: defaultBudget(),
      integration: { headRevision: "", expectedBase: "", appliedPatchSha256: [] },
      planRevision: 0,
      managerSessionId: "manager",
      eventCursor: 0,
    },
    tasks: [task],
    messages: [],
  };
}

describe("infrastructure error classification", () => {
  it("separates identity repair from temporary capacity", () => {
    const identity = classifyInfrastructureError("managed_identity_unavailable");
    expect(identity.retryable).toBe(false);
    expect(identity.issue.title).toBe("Gateway access needs attention");
    expect(identity.issue.detail).toContain("No model request ran");

    const capacity = classifyInfrastructureError("409 capacity_in_use");
    expect(capacity.retryable).toBe(true);
    expect(capacity.issue.title).toBe("Waiting for model capacity");
  });

  it("distinguishes model startup, network, and service failures", () => {
    expect(classifyInfrastructureError("wake_pending").issue.code).toBe("model_startup");
    expect(classifyInfrastructureError("ECONNREFUSED").issue.code).toBe("network");
    expect(classifyInfrastructureError("HTTP 503 infrastructure_unavailable").issue.code).toBe(
      "service",
    );
  });
});

describe("environment recovery evidence", () => {
  it("treats missing modules generically rather than by framework name", () => {
    expect(recoveryEvidence("failed", "ModuleNotFoundError: No module named 'requests'")).toBe(
      true,
    );
    expect(recoveryEvidence("failed", "bash: uv: command not found")).toBe(true);
    expect(recoveryEvidence("assertion failed", "1 != 2")).toBe(false);
  });
});

describe("interactive attempt limit notices", () => {
  it("gives the 45-minute worker limit the same next action as the status view, never a second instruction", async () => {
    const { recoveryNoticesFromSnapshot } = await import("@core/recovery-notices");
    const snapshot = snapshotWithStuckAttempt({
      failureClass: "infrastructure",
      error:
        "Interactive worker reached the 45-minute attempt limit. Folder changes are retained. Request a recovery to continue this worker session.",
    });
    const notices = recoveryNoticesFromSnapshot(snapshot);
    const status = projectStatusView(snapshot);
    // The status line for this exact state says Resume sends the result on;
    // a notice that separately said "you do not need to press Resume" (the
    // pre-fix wording) would flatly contradict it. There is now only one
    // source for the next action, so they can never disagree.
    expect(status.next).toMatch(/Resume sends that result to the Project Manager again/);
    expect(notices).toEqual([
      expect.objectContaining({
        title: "Interactive worker reached the 45-minute limit",
        nextAction: status.next,
      }),
    ]);
  });

  it("shows nothing for an interruption a later attempt already got past", async () => {
    const { recoveryNoticesFromSnapshot } = await import("@core/recovery-notices");
    const snapshot = snapshotWithStuckAttempt({ status: "paused", failureClass: "infrastructure" });
    const stuck = snapshot.tasks[0].attempts[0];
    snapshot.tasks[0].attempts.push({
      ...stuck,
      status: "completed",
      failureClass: undefined,
      error: undefined,
    });
    snapshot.tasks[0].status = "needs_review";
    expect(recoveryNoticesFromSnapshot(snapshot)).toEqual([]);
    snapshot.tasks[0].attempts.pop();
    expect(recoveryNoticesFromSnapshot(snapshot)).toHaveLength(1);
  });

  it("gives a route-change decision the specific Settings guidance, from the status view, not a separate notice", async () => {
    const { recoveryNoticesFromSnapshot } = await import("@core/recovery-notices");
    const snapshot = snapshotWithStuckAttempt({ status: "completed", failureClass: undefined });
    snapshot.tasks[0].status = "applied";
    snapshot.project.status = "needs_input";
    snapshot.project.needsInput = {
      question:
        "The authorized worker route changed in Poundlock. Review its destination before retrying.",
      askedAt: "t",
      kind: "route_change",
    };
    const status = projectStatusView(snapshot);
    expect(status.next).toMatch(/Settings → Models and routing/);
    expect(status.next).toMatch(/Approve current route/);
    // No separate, possibly-contradictory notice is generated for this: the
    // status view already carries the specific instruction.
    expect(recoveryNoticesFromSnapshot(snapshot)).toEqual([]);
  });
});
