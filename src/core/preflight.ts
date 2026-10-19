import { sha256Text } from "./ids.js";

export type PreflightOperation = "inference" | "job";

export interface PreflightRequest {
  model: string;
  operation?: PreflightOperation;
  /** Expected stable binding metadata; these fields are validated locally and are not sent. */
  profileId?: string;
  destination?: string;
}

export interface PreflightResult {
  operation: PreflightOperation;
  destination?: string;
  data_destination?: string;
  profile_id?: string;
  profileId?: string;
  model?: string;
  access_state?: string;
  connection_mode?: string;
  managed_identity_status?: string;
  usage?: unknown;
  [key: string]: unknown;
}

interface PreflightCacheKey {
  controller: string;
  tokenFingerprint: string;
  profileId: string;
  routingRevision: string;
  operation: PreflightOperation;
}

export function preflightCacheKey(input: PreflightCacheKey): string {
  return [
    input.controller.replace(/\/+$/, ""),
    input.tokenFingerprint,
    input.profileId,
    input.routingRevision,
    input.operation,
  ].join("|");
}

export function tokenFingerprint(token: string): string {
  return sha256Text(token);
}

const TERMINAL_PREFLIGHT_CODES = new Set([
  "managed_budget_required",
  "managed_identity_provision_failed",
  "managed_identity_reconciliation_required",
  "data_destination_confirmation_required",
]);

export class PreflightCache {
  private values = new Map<string, PreflightResult>();

  get(input: PreflightCacheKey): PreflightResult | undefined {
    return this.values.get(preflightCacheKey(input));
  }

  set(input: PreflightCacheKey, result: PreflightResult): void {
    this.values.set(preflightCacheKey(input), result);
  }

  invalidate(input?: Partial<PreflightCacheKey>): void {
    if (!input || Object.keys(input).length === 0) {
      this.values.clear();
      return;
    }
    for (const key of [...this.values.keys()]) {
      const [controller, fingerprint, profileId, routingRevision, operation] = key.split("|");
      if (input.controller && controller !== input.controller.replace(/\/+$/, "")) continue;
      if (input.tokenFingerprint && fingerprint !== input.tokenFingerprint) continue;
      if (input.profileId && profileId !== input.profileId) continue;
      if (input.routingRevision && routingRevision !== input.routingRevision) continue;
      if (input.operation && operation !== input.operation) continue;
      this.values.delete(key);
    }
  }

  invalidateToken(tokenFingerprintValue: string): void {
    this.invalidate({ tokenFingerprint: tokenFingerprintValue });
  }
}

export function shouldInvalidatePreflight(error: { status?: number; code?: string }): boolean {
  if (error.status === 403) return true;
  return Boolean(error.code && TERMINAL_PREFLIGHT_CODES.has(error.code));
}

export function parsePreflightResult(
  value: unknown,
  _fallback: PreflightOperation,
): PreflightResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Poundlock preflight response was malformed.");
  }
  const record = value as Record<string, unknown>;
  if (record.operation !== "job" && record.operation !== "inference") {
    throw new Error(
      `Poundlock preflight did not report a valid operation (${String(record.operation ?? "missing")}).`,
    );
  }
  return { ...record, operation: record.operation };
}

const READY_ACCESS = new Set(["ready", "allowed", "available", "ok", "local"]);
const FAILED_IDENTITY = /fail|reconcil|required|blocked|denied/i;

export function blockedPreflightMessage(reason: string): string {
  if (reason === "external_permission_required") {
    return "This Poundlock application token cannot call external providers. In Poundlock Access, create a replacement token with Call external providers, then save and test it in Dispatch.";
  }
  if (reason === "data_destination_confirmation_required") {
    return "Poundlock blocked this profile because its data destination is not confirmed. Confirm its destination in Poundlock before sending project context.";
  }
  if (reason === "managed_budget_required") {
    return "This external profile has no usable managed budget. Review its Poundlock gateway identity and budget before retrying.";
  }
  return `Poundlock blocked this profile (${reason}). Project context was not sent.`;
}

export function assertReadyPreflight(
  result: PreflightResult,
  expected: {
    operation: PreflightOperation;
    profileId?: string;
    destination?: string;
    model?: string;
  },
): PreflightResult {
  if (result.operation !== expected.operation) {
    throw new Error(
      `Poundlock preflight operation was ${result.operation}, expected ${expected.operation}.`,
    );
  }
  const blocked = result.blocked_reason ?? result.blockedReason;
  if (blocked) {
    throw new Error(blockedPreflightMessage(String(blocked)));
  }
  const availability = String(result.availability ?? result.access_state ?? "").toLowerCase();
  if (!availability) {
    throw new Error(
      "Poundlock preflight did not report availability. Project context was not sent.",
    );
  }
  if (!READY_ACCESS.has(availability)) {
    throw new Error(
      `Poundlock preflight is not ready (${availability || "unspecified"}). Project context was not sent.`,
    );
  }
  const destination =
    (typeof result.data_destination === "string" && result.data_destination) ||
    (typeof result.destination === "string" && result.destination);
  if (expected.destination && !destination) {
    throw new Error("Poundlock preflight did not bind a data destination.");
  }
  if (expected.destination && destination !== expected.destination) {
    throw new Error("Poundlock preflight destination does not match the selected profile route.");
  }
  const identity =
    (typeof result.model === "string" && result.model) ||
    (typeof result.profile_id === "string" && result.profile_id) ||
    (typeof result.profileId === "string" && result.profileId);
  if (expected.profileId && !identity) {
    throw new Error("Poundlock preflight did not bind a profile identity.");
  }
  if (
    expected.profileId &&
    identity !== expected.profileId &&
    (!expected.model || identity !== expected.model)
  ) {
    throw new Error("Poundlock preflight profile identity does not match the selected binding.");
  }
  const managed = String(
    result.managed_identity_status ?? result.managedIdentityStatus ?? "",
  ).toLowerCase();
  if (managed && FAILED_IDENTITY.test(managed) && !READY_ACCESS.has(managed)) {
    throw new Error(`Poundlock managed identity is not ready (${managed}).`);
  }
  return result;
}
