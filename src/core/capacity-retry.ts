export const CAPACITY_RETRY = {
  deadlineMs: 15 * 60_000,
  maxRejectedAttempts: 30,
  minWaitMs: 2_000,
  maxWaitMs: 60_000,
  jitter: 0.1,
} as const;

type CapacityWaitStatus =
  | "waiting"
  | "paused"
  | "cancelled"
  | "exhausted"
  | "route_changed"
  | "ready";

/** Where a waiting request stands in Poundlock's line (contract revision 5). */
export interface CapacityQueuePlace {
  /** 1 is next. */
  position: number;
  holderKind?: "interactive" | "job";
}

export interface CapacityWaitState {
  status: CapacityWaitStatus;
  /** The place the controller reported, when it keeps a line. */
  queue?: CapacityQueuePlace;
  rejectedBeforeInference: true;
  attemptCount: number;
  startedAt: number;
  nextWaitMs: number;
  payloadHash: string;
  profileId: string;
  routingRevision: string;
  tokenFingerprint: string;
  dataDestination: string;
  operation: "inference" | "job";
}

export class AmbiguousInferenceError extends Error {
  readonly failureClass = "ambiguous_inference" as const;
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousInferenceError";
  }
}

export function parseRetryAfterMs(header: string | null | undefined, fallbackMs = 15_000): number {
  if (!header?.trim()) return clampWait(fallbackMs);
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return clampWait(seconds * 1000);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return clampWait(fallbackMs);
  return clampWait(Math.max(0, date - Date.now()));
}

export function clampWait(ms: number): number {
  return Math.min(CAPACITY_RETRY.maxWaitMs, Math.max(CAPACITY_RETRY.minWaitMs, ms));
}

export function applyJitter(ms: number, random: () => number = Math.random): number {
  const jitter = 1 + (random() * 2 - 1) * CAPACITY_RETRY.jitter;
  return clampWait(Math.round(ms * jitter));
}

export function startCapacityWait(input: {
  now: number;
  retryAfterMs: number;
  payloadHash: string;
  profileId: string;
  routingRevision: string;
  tokenFingerprint: string;
  dataDestination?: string;
  operation: "inference" | "job";
  random?: () => number;
}): CapacityWaitState {
  return {
    status: "waiting",
    rejectedBeforeInference: true,
    attemptCount: 1,
    startedAt: input.now,
    nextWaitMs: applyJitter(input.retryAfterMs, input.random),
    payloadHash: input.payloadHash,
    profileId: input.profileId,
    routingRevision: input.routingRevision,
    tokenFingerprint: input.tokenFingerprint,
    dataDestination: input.dataDestination ?? "",
    operation: input.operation,
  };
}

export function capacityIdentityChanged(
  state: Pick<
    CapacityWaitState,
    "profileId" | "routingRevision" | "tokenFingerprint" | "dataDestination"
  >,
  live: {
    liveProfileId: string;
    liveRoutingRevision: string;
    liveTokenFingerprint: string;
    liveDataDestination?: string;
  },
): boolean {
  if (live.liveProfileId !== state.profileId) return true;
  if (live.liveRoutingRevision !== state.routingRevision) return true;
  if (live.liveTokenFingerprint !== state.tokenFingerprint) return true;
  if (
    live.liveDataDestination != null &&
    state.dataDestination !== "" &&
    live.liveDataDestination !== state.dataDestination
  ) {
    return true;
  }
  return false;
}

export function nextCapacityWait(
  state: CapacityWaitState,
  input: {
    now: number;
    retryAfterMs: number;
    liveProfileId: string;
    liveRoutingRevision: string;
    liveTokenFingerprint: string;
    liveDataDestination?: string;
    random?: () => number;
  },
): CapacityWaitState {
  if (state.status === "paused" || state.status === "cancelled") return state;
  if (capacityIdentityChanged(state, input)) {
    return { ...state, status: "route_changed", nextWaitMs: 0 };
  }
  const attemptCount = state.attemptCount + 1;
  if (
    attemptCount > CAPACITY_RETRY.maxRejectedAttempts ||
    input.now - state.startedAt >= CAPACITY_RETRY.deadlineMs
  ) {
    return { ...state, status: "exhausted", attemptCount, nextWaitMs: 0 };
  }
  return {
    ...state,
    status: "waiting",
    attemptCount,
    nextWaitMs: applyJitter(input.retryAfterMs, input.random),
  };
}

/** ", 2nd in line behind a job", from the place Poundlock reported; empty without one. */
export function capacityPlace(wait: Pick<CapacityWaitState, "queue">): string {
  if (!wait.queue) return "";
  const { position, holderKind } = wait.queue;
  const ordinal =
    position === 1
      ? "next"
      : `${position}${position === 2 ? "nd" : position === 3 ? "rd" : "th"} in line`;
  return `, ${ordinal}${holderKind ? ` behind ${holderKind === "job" ? "a job" : "another session"}` : ""}`;
}

export function isCapacityRejection(error: {
  status?: number;
  code?: string;
  message?: string;
}): boolean {
  return error.status === 409 && error.code === "capacity_in_use";
}

export function isAmbiguousInferenceFailure(
  error: { message?: string; status?: number; code?: string },
  submitted: boolean,
): boolean {
  if (!submitted) return false;
  if (isCapacityRejection(error)) return false;
  return /timed? out|ECONNRESET|ECONNABORTED|fetch failed|network error|malformed|interrupted|abort|incomplete|hang up|socket/i.test(
    error.message ?? "",
  );
}
