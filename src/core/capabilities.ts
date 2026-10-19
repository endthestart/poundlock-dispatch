import { PoundlockError } from "./poundlock.js";

/** The Poundlock release this Dispatch was tested with (compat/poundlock.json). */
export const TESTED_POUNDLOCK_VERSION = "0.3.0";
export const EXPECTED_API_MAJOR = 1;
/** The oldest contract this Dispatch accepts; newer revisions only add fields. */
export const EXPECTED_CONTRACT_REVISION = 3;

const REQUIRED_CAPABILITY_FEATURES = [
  "access_preflight",
  "availability_reasons",
  "data_destination",
  "durable_jobs",
  "external_invoke_permission",
  "managed_application_identities",
  "routing_revision",
  "usage_summary",
  "verifier_toolchain",
] as const;

type PoundlockCapabilityFeature = (typeof REQUIRED_CAPABILITY_FEATURES)[number] | string;

export interface PoundlockCapabilities {
  api_major: number;
  contract_revision: number;
  features: PoundlockCapabilityFeature[];
  [key: string]: unknown;
}

export function parseCapabilities(value: unknown): PoundlockCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PoundlockError("Poundlock capabilities response was not an object.", 500);
  }
  const record = value as Record<string, unknown>;
  const apiMajor = Number(record.api_major);
  const contractRevision = Number(record.contract_revision);
  if (!Number.isInteger(apiMajor) || apiMajor < 1) {
    throw new PoundlockError("Poundlock did not report a valid API major version.", 500);
  }
  if (!Number.isInteger(contractRevision) || contractRevision < 0) {
    throw new PoundlockError("Poundlock did not report a valid contract revision.", 500);
  }
  const features = Array.isArray(record.features)
    ? record.features.filter((item): item is string => typeof item === "string")
    : [];
  return { ...record, api_major: apiMajor, contract_revision: contractRevision, features };
}

export function missingCapabilityFeatures(capabilities: { features: string[] }): string[] {
  return REQUIRED_CAPABILITY_FEATURES.filter((feature) => !capabilities.features.includes(feature));
}

/**
 * Why this controller cannot serve this Dispatch, or undefined when it can.
 * `capabilities` is undefined when the controller has no capabilities
 * endpoint at all, which only controllers older than any supported one lack.
 */
export function compatibilityProblem(
  capabilities:
    | Pick<PoundlockCapabilities, "api_major" | "contract_revision" | "features">
    | undefined,
): { error: string; hint: string } | undefined {
  const hint = `Upgrade Poundlock to ${TESTED_POUNDLOCK_VERSION} or newer (API ${EXPECTED_API_MAJOR}, contract revision ${EXPECTED_CONTRACT_REVISION} or later), then test the connection again.`;
  if (!capabilities)
    return { error: "This Poundlock controller does not say which API version it serves.", hint };
  if (capabilities.api_major !== EXPECTED_API_MAJOR)
    return {
      error: `This Poundlock controller serves API ${capabilities.api_major}; this Dispatch needs API ${EXPECTED_API_MAJOR}.`,
      hint:
        capabilities.api_major > EXPECTED_API_MAJOR
          ? "Use a Dispatch release made for this controller."
          : hint,
    };
  if (capabilities.contract_revision < EXPECTED_CONTRACT_REVISION)
    return {
      error: `This Poundlock controller publishes contract revision ${capabilities.contract_revision}; this Dispatch needs ${EXPECTED_CONTRACT_REVISION} or later.`,
      hint,
    };
  const missing = missingCapabilityFeatures(capabilities);
  if (missing.length)
    return {
      error: `This Poundlock controller does not offer ${missing.join(", ")}, which this Dispatch needs.`,
      hint,
    };
  return undefined;
}
