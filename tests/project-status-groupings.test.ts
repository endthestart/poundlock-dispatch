import { IN_FLIGHT, IN_FLIGHT_OR_REVIEW, projectStatusView } from "@shared/project-status";
import { defaultBudget, defaultPolicy } from "@shared/types";
import { expect, it } from "vitest";

it("exposes one in-flight task-status set, and a superset that also covers review", () => {
  expect(IN_FLIGHT).toEqual(["running", "queued", "repairing"]);
  expect(IN_FLIGHT_OR_REVIEW).toEqual(["running", "queued", "repairing", "needs_review"]);
});

it("marks waiting_for_capacity active, matching the dock's own active-status grouping", () => {
  const snapshot = {
    project: {
      id: "p",
      name: "recipe-box",
      archived: false,
      createdAt: "t",
      updatedAt: "t",
      status: "waiting_for_capacity" as const,
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
      planRevision: 1,
      workflowId: "w",
      managerSessionId: "m",
      eventCursor: 0,
    },
    tasks: [],
    messages: [],
  };
  const view = projectStatusView(snapshot);
  expect(view.active).toBe(true);
});
