import { type PoundlockJob, parseJobResult } from "@core/poundlock";
import { describe, expect, it } from "vitest";

function job(overrides: { provenance?: Record<string, unknown> } = {}): PoundlockJob {
  return {
    id: "job-1",
    idempotency_key: "key-1",
    model_profile_id: "model-1",
    harness_profile_id: "pi",
    prompt: "do the thing",
    status: "completed",
    attempt_id: "attempt-1",
    cancel_requested: false,
    created_at: "t",
    updated_at: "t",
    result: {
      output: "done",
      patches: [],
      provenance: overrides.provenance ?? {},
    },
  };
}

describe("parseJobResult self-repairs", () => {
  it("is undefined when the job never reports an attempt count (an older Poundlock)", () => {
    expect(parseJobResult(job()).selfRepairs).toBeUndefined();
  });

  it("is 0 for a job that never repaired itself (attempt_count 1, matching the real UAT fixture)", () => {
    expect(parseJobResult(job({ provenance: { attempt_count: 1 } })).selfRepairs).toBe(0);
  });

  it("is attempt_count minus 1 when the job repaired itself inside this attempt", () => {
    expect(parseJobResult(job({ provenance: { attempt_count: 3 } })).selfRepairs).toBe(2);
  });

  it("falls back to previous_attempts length when attempt_count is missing", () => {
    expect(parseJobResult(job({ provenance: { previous_attempts: [{}, {}] } })).selfRepairs).toBe(
      2,
    );
  });

  it("never goes negative for a malformed attempt_count", () => {
    expect(parseJobResult(job({ provenance: { attempt_count: 0 } })).selfRepairs).toBe(0);
  });
});
