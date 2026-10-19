import { countProjectsNeedingYou, projectNeedsYou } from "@shared/needs-you";
import { resolveTaskRoute, TASK_EXECUTION_PLACE } from "@shared/types";
import { expect, it } from "vitest";

it("marks approval, plan review, follow-up, pause, and a stopped run as needing you", () => {
  expect(projectNeedsYou({ id: "a", status: "running" })).toBe(false);
  expect(projectNeedsYou({ id: "a", status: "awaiting_approval" })).toBe(true);
  expect(projectNeedsYou({ id: "a", status: "needs_input" })).toBe(true);
  expect(projectNeedsYou({ id: "a", status: "paused" })).toBe(true);
  // Matches projectStatusView: a failed run always needs a decision from the user (either
  // Resume when it's resumable, or telling the manager how to proceed when it is not).
  expect(projectNeedsYou({ id: "a", status: "failed" })).toBe(true);
  expect(projectNeedsYou({ id: "a", status: "completed" })).toBe(false);
  expect(projectNeedsYou({ id: "a", status: "running" }, [{ projectId: "a" }])).toBe(true);
  expect(
    countProjectsNeedingYou(
      [
        { id: "a", status: "paused" },
        { id: "b", status: "running" },
        { id: "c", archived: true, status: "paused" },
      ],
      [{ projectId: "b" }],
    ),
  ).toBe(2);
});

it("counts a project whose needsInput survives into an otherwise-quiet status", () => {
  // A cancelled run whose remote cancellation is unconfirmed still asks the user to reconnect
  // and retry (projectStatusView's "cancelled" cause), even though "cancelled" itself isn't in
  // the needs-you status list.
  expect(
    projectNeedsYou({
      id: "a",
      status: "cancelled",
      needsInput: { question: "q", askedAt: "t", kind: "submission_uncertain" },
    }),
  ).toBe(true);
  expect(projectNeedsYou({ id: "a", status: "cancelled" })).toBe(false);
});

it("names this Mac as where a task runs", () => {
  expect(TASK_EXECUTION_PLACE).toMatch(/this Mac/);
  expect(resolveTaskRoute({ difficulty: "small", route: "interactive" })).toBe("interactive");
  expect(resolveTaskRoute({ difficulty: "small", route: "snippet" })).toBe("snippet");
});
