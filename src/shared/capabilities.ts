import type { CapabilityMeasurement, CapabilityName, TaskKind } from "./types";

/**
 * What a profile's own measured evidence says about one named capability,
 * collapsed to what routing can safely act on. This is the only place that
 * interprets a `CapabilityMeasurement`; `role-routing.ts` never reads the raw
 * record.
 *
 * `measured_failure` is the sole status Dispatch enforces mechanically (a
 * rung is dropped from the automatic choice — see
 * `resolveStartingWorkerBinding`); every other status is advisory. `unknown`
 * is never treated as capable: an absent entry, a stale one (Poundlock's own
 * >30-day rule), one whose measured settings no longer match how the profile
 * is configured now, or an `insufficient` verdict with zero attempts all
 * degrade to `unknown` rather than silently keeping an earlier verdict.
 */
type CapabilityStatus = "qualified" | "smoke" | "measured_failure" | "unknown";

/** The capability each task kind is routed against. Absent from the map = no capability check applies. */
export const TASK_KIND_CAPABILITY: Record<TaskKind, CapabilityName> = {
  closed_implementation: "code_repair_verified",
  open_investigation: "sealed_investigation",
  planning: "plan_tool_schema",
};

export function capabilityStatus(
  profile: { capabilities?: CapabilityMeasurement[] } | undefined,
  name: CapabilityName,
): CapabilityStatus {
  const entry = profile?.capabilities?.find((item) => item.name === name);
  if (!entry) return "unknown";
  if (entry.stale) return "unknown";
  if (entry.settings_match !== "exact") return "unknown";
  // Poundlock derives this alongside `stale` and `settings_match`. The local
  // fallback keeps older controllers working and states the same rule:
  // `status` alone cannot carry it, because `insufficient` covers both "it
  // failed" and "we could not tell", and treating those alike would drop a
  // working profile from routing.
  if (entry.measured_failure ?? (entry.attempted > 0 && entry.passed === 0))
    return "measured_failure";
  if (entry.status === "qualified") return "qualified";
  if (entry.status === "smoke") return "smoke";
  return "unknown";
}

/**
 * One plain sentence describing a published capability measurement, for the
 * manager's `list_execution_profiles` evidence (`listProfiles` in
 * `core/orchestration.ts`). Never a ranking, and never claims the profile can
 * do a particular task — callers append that caveat once, alongside these
 * sentences.
 */
export function capabilityEvidenceSentence(entry: CapabilityMeasurement): string {
  const verdict =
    entry.attempted > 0 && entry.passed === 0
      ? "measured failure"
      : entry.status === "qualified"
        ? "qualified"
        : entry.status === "smoke"
          ? "smoke"
          : "insufficient evidence";
  const clauses = [`${entry.passed} of ${entry.attempted} attempts passed`];
  if (entry.measured_at || entry.measured_settings) {
    const date = entry.measured_at ? entry.measured_at.slice(0, 10) : "an unrecorded date";
    const context = entry.measured_settings?.context_tokens ?? "an unrecorded";
    const reasoning =
      entry.measured_settings?.reasoning && entry.measured_settings.reasoning !== "off"
        ? "on"
        : "off";
    clauses.push(`measured ${date} at ${context} context, thinking ${reasoning}`);
  }
  if (entry.stale) clauses.push("stale");
  if (entry.settings_match && entry.settings_match !== "exact")
    clauses.push("measured settings no longer match this profile");
  return `${entry.name}: ${verdict} — ${clauses.join(", ")}.`;
}

/** Shown once alongside capability evidence sentences, never repeated as a per-line qualifier. */
export const CAPABILITY_EVIDENCE_CAVEAT =
  "This is frozen-fixture evidence, not a ranking, and does not establish the profile can do this particular task.";
