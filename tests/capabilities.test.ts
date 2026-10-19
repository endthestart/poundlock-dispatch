import {
  CAPABILITY_EVIDENCE_CAVEAT,
  capabilityEvidenceSentence,
  capabilityStatus,
  TASK_KIND_CAPABILITY,
} from "@shared/capabilities";
import type { CapabilityMeasurement } from "@shared/types";
import { describe, expect, it } from "vitest";

function measurement(overrides: Partial<CapabilityMeasurement> = {}): CapabilityMeasurement {
  return {
    name: "sealed_investigation",
    status: "qualified",
    passed: 3,
    attempted: 3,
    settings_match: "exact",
    ...overrides,
  };
}

describe("capabilityStatus", () => {
  it("is unknown when the profile has no entry for the capability at all", () => {
    expect(capabilityStatus(undefined, "sealed_investigation")).toBe("unknown");
    expect(capabilityStatus({ capabilities: [] }, "sealed_investigation")).toBe("unknown");
    expect(
      capabilityStatus(
        { capabilities: [measurement({ name: "plan_tool_schema" })] },
        "sealed_investigation",
      ),
    ).toBe("unknown");
  });

  it("is measured_failure when at least one attempt ran and none passed, regardless of the reported status", () => {
    expect(
      capabilityStatus(
        { capabilities: [measurement({ status: "insufficient", passed: 0, attempted: 3 })] },
        "sealed_investigation",
      ),
    ).toBe("measured_failure");
    // Even a status the server marked "qualified" is overridden by 0-of-N.
    expect(
      capabilityStatus(
        { capabilities: [measurement({ status: "qualified", passed: 0, attempted: 1 })] },
        "sealed_investigation",
      ),
    ).toBe("measured_failure");
  });

  it("is never measured_failure when nothing was attempted", () => {
    expect(
      capabilityStatus(
        { capabilities: [measurement({ status: "insufficient", passed: 0, attempted: 0 })] },
        "sealed_investigation",
      ),
    ).toBe("unknown");
  });

  it("passes through qualified and smoke when settings match and the measurement is fresh", () => {
    expect(
      capabilityStatus(
        { capabilities: [measurement({ status: "qualified" })] },
        "sealed_investigation",
      ),
    ).toBe("qualified");
    expect(
      capabilityStatus(
        { capabilities: [measurement({ status: "smoke" })] },
        "sealed_investigation",
      ),
    ).toBe("smoke");
  });

  it("degrades a stale measurement to unknown even when it reports qualified", () => {
    expect(
      capabilityStatus(
        { capabilities: [measurement({ status: "qualified", stale: true })] },
        "sealed_investigation",
      ),
    ).toBe("unknown");
  });

  it("degrades a settings-mismatched measurement to unknown even when it reports qualified", () => {
    expect(
      capabilityStatus(
        { capabilities: [measurement({ status: "qualified", settings_match: "different" })] },
        "sealed_investigation",
      ),
    ).toBe("unknown");
    expect(
      capabilityStatus(
        { capabilities: [measurement({ status: "qualified", settings_match: undefined })] },
        "sealed_investigation",
      ),
    ).toBe("unknown");
  });

  it("never treats insufficient evidence with a partial pass as capable", () => {
    expect(
      capabilityStatus(
        { capabilities: [measurement({ status: "insufficient", passed: 1, attempted: 3 })] },
        "sealed_investigation",
      ),
    ).toBe("unknown");
  });
});

describe("TASK_KIND_CAPABILITY", () => {
  it("maps each task kind to exactly one fixture-named capability", () => {
    expect(TASK_KIND_CAPABILITY.closed_implementation).toBe("code_repair_verified");
    expect(TASK_KIND_CAPABILITY.open_investigation).toBe("sealed_investigation");
    expect(TASK_KIND_CAPABILITY.planning).toBe("plan_tool_schema");
  });
});

describe("capabilityEvidenceSentence", () => {
  it("names the failure plainly with counts, date, and measured settings", () => {
    const sentence = capabilityEvidenceSentence(
      measurement({
        name: "plan_tool_schema",
        status: "insufficient",
        passed: 0,
        attempted: 3,
        measured_at: "2026-09-19T00:00:00Z",
        measured_settings: { context_tokens: 65536, reasoning: "off" },
      }),
    );
    expect(sentence).toContain("plan_tool_schema");
    expect(sentence).toContain("measured failure");
    expect(sentence).toContain("0 of 3 attempts passed");
    expect(sentence).toContain("2026-09-19");
    expect(sentence).toContain("65536 context");
    expect(sentence).toContain("thinking off");
  });

  it("is never a ranking claim on its own; callers append the fixed caveat", () => {
    expect(CAPABILITY_EVIDENCE_CAVEAT).toMatch(/not a ranking/);
    expect(CAPABILITY_EVIDENCE_CAVEAT).toMatch(/does not establish/);
  });
});

describe("what counts as a measured failure", () => {
  const entry = (over: Partial<CapabilityMeasurement>): CapabilityMeasurement =>
    ({
      name: "code_repair_verified",
      status: "insufficient",
      passed: 3,
      attempted: 3,
      source: "poundlock_toolkit",
      measured_at: new Date().toISOString(),
      stale: false,
      settings_match: "exact",
      ...over,
    }) as CapabilityMeasurement;

  it("is not the same thing as an insufficient verdict", () => {
    // Today's live evidence is `insufficient, 3/3`: every attempt passed, but
    // identity and freshness could not be confirmed. Treating `insufficient`
    // as a measured failure would drop that profile from routing — which is
    // every profile this machine has measured.
    expect(capabilityStatus({ capabilities: [entry({})] }, "code_repair_verified")).toBe("unknown");
    expect(
      capabilityStatus(
        { capabilities: [entry({ passed: 0, attempted: 3 })] },
        "code_repair_verified",
      ),
    ).toBe("measured_failure");
  });

  it("takes Poundlock's own derivation when it is published", () => {
    // Derived beside `stale` and `settings_match`, so every client reads one
    // answer rather than each inventing its own.
    expect(
      capabilityStatus(
        { capabilities: [entry({ measured_failure: true })] },
        "code_repair_verified",
      ),
    ).toBe("measured_failure");
  });
});
