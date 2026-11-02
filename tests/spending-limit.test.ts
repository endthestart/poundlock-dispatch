import { autopilotArrivals } from "@shared/autopilot-card";
import { isSpendingRefusal } from "@shared/spending-limit";
import { expect, it } from "vitest";

it("tells a spending refusal from a wait and from other failures", () => {
  for (const refusal of [
    "402 Insufficient credits. Add more using https://openrouter.ai/credits",
    "This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1200.",
    "litellm.BudgetExceededError: Budget has been exceeded! Current cost: 20.04, Max budget: 20.0",
    "You exceeded your current quota, please check your plan and billing details.",
  ])
    expect(isSpendingRefusal(refusal), refusal).toBe(true);
  for (const other of [
    // OpenRouter's in-flight credit budget asks for a retry later: a wait.
    "402 in_flight_budget exceeded; Retry-After: 30",
    "429 Too Many Requests",
    "fetch failed",
    "The manager model returned an error.",
    undefined,
  ])
    expect(isSpendingRefusal(other), String(other)).toBe(false);
});

it("notifies the owner when a running Autopilot moves to the local fallback", () => {
  const active = { label: "Building 3/9", tone: "active" as const };
  const local = {
    label: "Building 3/9 · on local fallback",
    tone: "active" as const,
    onFallback: true as const,
  };
  expect(autopilotArrivals({ p: active }, { p: local })).toEqual([
    { projectId: "p", glance: local },
  ]);
  expect(
    autopilotArrivals({ p: local }, { p: { ...local, label: "Building 4/9 · on local fallback" } }),
  ).toEqual([]);
});
