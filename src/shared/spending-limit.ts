/**
 * A provider refusing for money: OpenRouter's 402 when its weekly limit or the
 * credit runs out, OpenRouter's workspace guardrail (a 403), LiteLLM's key budget,
 * a provider's quota, Poundlock's frontier budget for the install. Such a refusal
 * does not pass with waiting, so a cloud role moves once to the local
 * fallback the owner chose (27 Oct). A 402 that asks for a retry later
 * (OpenRouter's in-flight credit budget) is a wait, not this.
 */
const SPENDING =
  /\b402\b|payment required|insufficient[ _]credits|can only afford|credit balance is too low|budget has been exceeded|budget_exceeded|exceeded (?:your|the) (?:current )?quota|insufficient_quota|key limit exceeded|budget limit exceeded|frontier_budget_exhausted|frontier budget of \S+ is used up/i;
const LATER = /Retry-After|in_flight_budget/i;

export function isSpendingRefusal(error: string | undefined): boolean {
  return Boolean(error && SPENDING.test(error) && !LATER.test(error));
}

/** A role that moved to the local fallback, as the run log and the owner see it. */
export interface ModelFallback {
  role: "manager" | "planner" | "verifier" | "worker";
  from: string;
  to: string;
  reason: string;
}

export function fallbackNotice(fallback: ModelFallback): string {
  const role =
    fallback.role === "planner"
      ? "Planner"
      : fallback.role === "verifier"
        ? "Verifier"
        : fallback.role === "worker"
          ? "Worker"
          : "Manager";
  return `${role} switched from ${fallback.from} to the local fallback ${fallback.to}: the provider refused for a spending limit (${fallback.reason.slice(0, 200)}).`;
}
