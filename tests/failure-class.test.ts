import {
  classifyAttemptFailure,
  classifyLoopOutcome,
  consumesEscalationBudget,
  consumesRepairBudget,
} from "@core/failure-class";
import { isInfrastructureCode } from "@core/recovery";
import type { AttemptRecord } from "@shared/types";
import { describe, expect, it } from "vitest";

function attempt(overrides: Partial<AttemptRecord>): AttemptRecord {
  return {
    id: "a1",
    number: 1,
    idempotencyKey: "k",
    requestHash: "h",
    profileId: "p",
    profileName: "p",
    harnessId: "pi",
    status: "completed",
    createdAt: "t",
    selectionReason: "r",
    ...overrides,
  };
}

describe("classifyLoopOutcome", () => {
  it("is a repair when there is no attempt yet", () => {
    expect(classifyLoopOutcome(undefined)).toBe("repair");
  });

  it("is free for a user pause, no matter what failure class was recorded", () => {
    expect(classifyLoopOutcome(attempt({ status: "paused" }))).toBe("free");
    expect(classifyLoopOutcome(attempt({ status: "paused", failureClass: "infrastructure" }))).toBe(
      "free",
    );
    expect(classifyLoopOutcome(attempt({ status: "paused", failureClass: "work" }))).toBe("free");
  });

  it("is free for an explicitly denied approval", () => {
    expect(
      classifyLoopOutcome(attempt({ status: "failed", failureClass: "policy", error: "denied" })),
    ).toBe("free");
  });

  it("is free for an environment problem on the user's machine", () => {
    expect(
      classifyLoopOutcome(
        attempt({ status: "failed", failureClass: "environment", error: "command not found" }),
      ),
    ).toBe("free");
  });

  it("is a repair for an actual work/code defect", () => {
    expect(classifyLoopOutcome(attempt({ status: "completed", failureClass: "work" }))).toBe(
      "repair",
    );
  });

  it("is a retry-after-interruption (recovery) for automatic infrastructure or ambiguous-stream failures", () => {
    for (const failureClass of ["infrastructure", "ambiguous_inference"] as const) {
      expect(classifyLoopOutcome(attempt({ status: "failed", failureClass }))).toBe("recovery");
    }
  });

  it("is a retry-after-interruption (recovery) for context/output limit failures", () => {
    for (const failureClass of ["context_limit", "output_limit"] as const) {
      expect(classifyLoopOutcome(attempt({ status: "failed", failureClass }))).toBe("recovery");
    }
  });

  it("falls back to the check output for a completed attempt with no failure class", () => {
    const missingDependency = attempt({
      status: "completed",
      result: {
        status: "completed",
        output: "",
        patches: [],
        verification: {
          status: "failed",
          commands: [
            {
              command: "pytest",
              exitCode: 1,
              output: "ModuleNotFoundError: No module named 'django'",
            },
          ],
        },
      },
    });
    // A missing dependency surfaced only through check output is still an
    // environment problem: free, not a repair or a counted retry.
    expect(classifyLoopOutcome(missingDependency)).toBe("free");

    const genuineFailure = attempt({
      status: "completed",
      result: {
        status: "completed",
        output: "",
        patches: [],
        verification: {
          status: "failed",
          commands: [{ command: "pytest", exitCode: 1, output: "AssertionError: 1 != 2" }],
        },
      },
    });
    expect(classifyLoopOutcome(genuineFailure)).toBe("repair");
  });
});

describe("Poundlock's own reason codes", () => {
  it("classifies on the code rather than on how the message happens to read", () => {
    // The pattern used to look for `wake_pending`, `model_starting` and
    // `model_loading` — none of which the controller has ever emitted — so a
    // real infrastructure event only matched when its prose happened to say
    // "timed out" or "wake". When it did not, the model was blamed and the
    // user's repair and escalation budgets paid for it.
    for (const code of [
      "readiness_timeout",
      "ensure_failed",
      "runtime_lease_lost",
      "node_unavailable",
      "selected_network_unavailable",
      "runner_lost",
    ]) {
      expect(isInfrastructureCode(code)).toBe(true);
      expect(classifyAttemptFailure({ code, error: "the job did not complete" })).toBe(
        "infrastructure",
      );
      expect(consumesRepairBudget(classifyAttemptFailure({ code, error: "x" }))).toBe(false);
      expect(consumesEscalationBudget(classifyAttemptFailure({ code, error: "x" }))).toBe(false);
    }

    // The three that never existed are gone, and a genuine code failure is
    // still the model's to answer for.
    for (const phantom of ["wake_pending", "model_starting", "model_loading"]) {
      expect(isInfrastructureCode(phantom)).toBe(false);
    }
    expect(classifyAttemptFailure({ error: "the tests still fail on line 12" })).toBe("work");
  });
});

it("treats a reply with no stop reason as unusable, not as a work failure", () => {
  expect(classifyAttemptFailure({ error: "Incomplete model response" })).toBe(
    "ambiguous_inference",
  );
});

it("treats a Rust toolchain that cannot be selected as an environment problem", () => {
  expect(
    classifyAttemptFailure({
      error: "Check failed",
      verificationOutput:
        "error: rustup could not choose a version of cargo to run, because one wasn't specified explicitly, and no default is configured.",
    }),
  ).toBe("environment");
});
