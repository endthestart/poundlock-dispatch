import { shouldPauseOnDispatchSession } from "@core/session-pause";
import { expect, it } from "vitest";

it("pauses in-flight and failed work when Dispatch quits or reopens", () => {
  expect(shouldPauseOnDispatchSession({ status: "failed" })).toBe(true);
  expect(shouldPauseOnDispatchSession({ status: "reviewing" })).toBe(true);
  expect(shouldPauseOnDispatchSession({ status: "planning" })).toBe(true);
  expect(shouldPauseOnDispatchSession({ status: "running" })).toBe(true);
  expect(shouldPauseOnDispatchSession({ status: "waiting_for_capacity" })).toBe(true);
});

it("does not pause idle or finished work", () => {
  expect(shouldPauseOnDispatchSession({ status: "paused" })).toBe(false);
  expect(shouldPauseOnDispatchSession({ status: "draft" })).toBe(false);
  expect(shouldPauseOnDispatchSession({ status: "awaiting_approval" })).toBe(false);
  expect(shouldPauseOnDispatchSession({ status: "needs_input" })).toBe(false);
  expect(shouldPauseOnDispatchSession({ status: "completed" })).toBe(false);
  expect(shouldPauseOnDispatchSession({ status: "cancelled" })).toBe(false);
});
