import {
  fixRoundsPerTask,
  MAX_MANAGER_TURNS,
  MAX_RECOVERIES_PER_TASK,
  MAX_REPAIRS_PER_TASK,
  managerTurnsForPlan,
} from "@shared/policy-limits";
import { describe, expect, it } from "vitest";

describe("policy limits", () => {
  it("are the values every project used to carry with no way to change them", () => {
    // No UI or API ever wrote a project-specific maxManagerTurns,
    // maxRepairsPerTask, maxRecoveriesPerTask or maxConcurrentWorkers — see
    // releases/0.1.3/SIMPLIFICATION-REVIEW.md, "Per-project policy with no
    // UI". These are named constants now, not a per-project setting nobody
    // could reach.
    expect(MAX_MANAGER_TURNS).toBe(24);
    expect(MAX_REPAIRS_PER_TASK).toBe(2);
    expect(MAX_RECOVERIES_PER_TASK).toBe(3);
  });
});

it("takes fix rounds from the project, then the app default, then 2", () => {
  expect(fixRoundsPerTask(4, 1)).toBe(4);
  expect(fixRoundsPerTask(0, 3)).toBe(0);
  expect(fixRoundsPerTask(undefined, 3)).toBe(3);
  expect(fixRoundsPerTask(undefined, undefined)).toBe(2);
  expect(fixRoundsPerTask(9, 1.5)).toBe(2);
});

it("gives a plan enough manager turns for its tasks", () => {
  expect(managerTurnsForPlan(0)).toBe(24);
  expect(managerTurnsForPlan(15)).toBe(68);
});
