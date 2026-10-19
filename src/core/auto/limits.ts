import { type AutoLimits, type AutoRunState, processedTokens } from "@shared/auto-run";

export interface LimitHit {
  kind: "wall_clock" | "cases" | "tokens" | "consecutive_failures" | "no_progress";
  level: "soft" | "hard";
  detail: string;
}

const hours = (from: string | undefined, now: Date) =>
  from ? (now.getTime() - Date.parse(from)) / 3_600_000 : 0;

/**
 * Soft limits stop new cases; the case in progress may finish. The hard limit
 * interrupts the attempt (its draft is saved first). Cache reads never count.
 */
export function checkLimits(state: AutoRunState, limits: AutoLimits, now: Date): LimitHit | null {
  const elapsed = hours(state.startedAt, now);
  if (elapsed >= limits.hardHours) {
    return {
      kind: "wall_clock",
      level: "hard",
      detail: `${limits.hardHours} h hard limit reached`,
    };
  }
  if (elapsed >= limits.softHours) {
    return { kind: "wall_clock", level: "soft", detail: `${limits.softHours} h limit reached` };
  }
  // Skipped cases never ran.
  const started = state.cases.filter((c) => c.stage !== "pending" && c.stage !== "skipped").length;
  if (started >= limits.maxCases) {
    return { kind: "cases", level: "soft", detail: `${limits.maxCases} cases started` };
  }
  if (limits.maxProcessedTokens && processedTokens(state.usage) >= limits.maxProcessedTokens) {
    return {
      kind: "tokens",
      level: "soft",
      detail: `${limits.maxProcessedTokens} processed tokens used`,
    };
  }
  if (state.consecutiveFailedCases >= limits.maxConsecutiveFailedCases) {
    return {
      kind: "consecutive_failures",
      level: "soft",
      detail: `${state.consecutiveFailedCases} cases in a row were blocked or abandoned`,
    };
  }
  if (hours(state.lastSubstantiveAt ?? state.startedAt, now) >= limits.noProgressHours) {
    return {
      kind: "no_progress",
      level: "soft",
      detail: `no accepted change for ${limits.noProgressHours} h`,
    };
  }
  return null;
}

/** Remaining milliseconds a case may still use, bounded by the hard limit. */
export function caseBudgetMs(
  state: AutoRunState,
  limits: AutoLimits,
  caseStartedAt: Date,
  now: Date,
): number {
  const caseLeft = limits.caseMinutes * 60_000 - (now.getTime() - caseStartedAt.getTime());
  const hardLeft = state.startedAt
    ? limits.hardHours * 3_600_000 - (now.getTime() - Date.parse(state.startedAt))
    : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(caseLeft, hardLeft));
}
