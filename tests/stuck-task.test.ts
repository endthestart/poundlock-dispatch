import type { EscalationSettings } from "@shared/escalation";
import { buildStuckTaskBrief, categorizeStuckTask } from "@shared/stuck-task";
import type { TaskRecord } from "@shared/types";
import { describe, expect, it } from "vitest";

describe("categorizeStuckTask", () => {
  it("is policy when the failure class is an explicit denial, regardless of which loop exhausted", () => {
    expect(categorizeStuckTask("repair", "policy")).toBe("policy");
    expect(categorizeStuckTask("recovery", "policy")).toBe("policy");
  });

  it("is environment when the failure class is an environment problem", () => {
    expect(categorizeStuckTask("repair", "environment")).toBe("environment");
    expect(categorizeStuckTask("recovery", "environment")).toBe("environment");
  });

  it("is work quality when the fix-round allowance ran out on anything else", () => {
    expect(categorizeStuckTask("repair", "work")).toBe("work_quality");
    expect(categorizeStuckTask("repair", undefined)).toBe("work_quality");
    expect(categorizeStuckTask("repair", "infrastructure")).toBe("work_quality");
  });

  it("is model capability when the retry-after-interruption allowance ran out on a context/output limit", () => {
    expect(categorizeStuckTask("recovery", "context_limit")).toBe("model_capability");
    expect(categorizeStuckTask("recovery", "output_limit")).toBe("model_capability");
  });

  it("is model availability when the retry-after-interruption allowance ran out on infrastructure or an ambiguous stream", () => {
    expect(categorizeStuckTask("recovery", "infrastructure")).toBe("model_availability");
    expect(categorizeStuckTask("recovery", "ambiguous_inference")).toBe("model_availability");
    expect(categorizeStuckTask("recovery", undefined)).toBe("model_availability");
  });
});

function stuckTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1",
    title: "Broken",
    objective: "fix",
    workerPrompt: "fix",
    acceptanceCriteria: "tests pass",
    dependsOn: [],
    difficulty: "small",
    contextNote: "",
    status: "needs_review",
    repairCount: 2,
    recoveryCount: 0,
    attempts: [
      {
        id: "a1",
        number: 1,
        idempotencyKey: "k1",
        requestHash: "h1",
        profileId: "p",
        profileName: "coding",
        harnessId: "pi",
        status: "completed",
        createdAt: "t",
        selectionReason: "r",
        result: {
          status: "completed",
          output: "",
          patches: [],
          verification: {
            status: "failed",
            commands: [{ command: "pytest", exitCode: 1, output: "AssertionError: 1 != 2" }],
          },
        },
      },
    ],
    ...overrides,
  };
}

const escalation: EscalationSettings = {
  profiles: [{ profileId: "strong", profileName: "Strong model", source: "interactive" }],
  mode: "ask",
  maxTransitionsPerRun: 3,
};

describe("buildStuckTaskBrief", () => {
  it("does not offer an escalation the owner declined", () => {
    const result = buildStuckTaskBrief({
      task: stuckTask(),
      outcome: "repair",
      escalation,
      externalEscalationsUsed: 0,
      declinedProfiles: ["strong"],
    });
    expect(result.brief).toMatch(/declined escalation to Strong model/);
    expect(result.brief).not.toMatch(/call request_escalation/);
  });

  it("names the failing test, not the warnings cargo prints first", () => {
    const task = stuckTask();
    task.attempts[0].result!.verification!.commands[0] = {
      command: "cargo test",
      exitCode: 101,
      output: [
        "warning: unnecessary `unsafe` block",
        "   --> crates/lrc-core/src/abi.rs:1525:9",
        "running 16 tests",
        "---- preview_of_catalog_only_raw_reports_format_error stdout ----",
        "test result: FAILED. 14 passed; 2 failed",
      ].join("\n"),
    };
    const result = buildStuckTaskBrief({
      task,
      outcome: "repair",
      escalation,
      externalEscalationsUsed: 0,
    });
    expect(result.reason).toMatch(/preview_of_catalog_only_raw_reports_format_error/);
    expect(result.reason).not.toMatch(/unsafe/);
  });

  it("names the actual issue, the category, what is on disk, the counters, and every alternative", () => {
    const task = stuckTask();
    const result = buildStuckTaskBrief({
      task,
      outcome: "repair",
      escalation,
      externalEscalationsUsed: 0,
    });
    expect(result.category).toBe("work_quality");
    expect(result.reason).toMatch(/pytest/);
    expect(result.brief).toContain('Task "Broken" is stuck');
    expect(result.brief).toContain("Fix rounds used: 2 of 2");
    expect(result.brief).toContain("Retries after interruption used: 0 of 3");
    expect(result.brief).toMatch(/Edits are already written in the project folder/);
    expect(result.brief).toContain("request_escalation");
    expect(result.brief).toContain("Strong model");
    expect(result.brief).toContain("propose_plan");
    expect(result.brief).toContain("ask_user");
  });

  it("says explicitly when no further rung is configured", () => {
    const task = stuckTask();
    const result = buildStuckTaskBrief({
      task,
      outcome: "repair",
      escalation: { profiles: [], mode: "ask", maxTransitionsPerRun: 3 },
      externalEscalationsUsed: 0,
    });
    expect(result.brief).toMatch(/No further rung is configured/);
  });

  it("says explicitly when the escalation transition limit for this run is used up", () => {
    const task = stuckTask();
    const result = buildStuckTaskBrief({
      task,
      outcome: "repair",
      escalation,
      externalEscalationsUsed: 3,
    });
    expect(result.brief).toMatch(/escalation transition limit.*used up/);
    expect(result.brief).toMatch(/rung on your own infrastructure never spends this limit/);
  });

  it("states the true remaining external-provider allowance, unaffected by plan revision", () => {
    const task = stuckTask();
    const result = buildStuckTaskBrief({
      task,
      outcome: "repair",
      escalation,
      externalEscalationsUsed: 1,
    });
    // 3 configured, 1 already used this run: 2 remain, regardless of the
    // plan's current revision (buildStuckTaskBrief is never given a revision).
    expect(result.brief).toContain("2 of 3 escalation transitions to an external provider remain");
    expect(result.brief).toContain("unaffected by plan revisions");
  });
});

describe("the rung the stuck-task brief offers next", () => {
  const ladder: EscalationSettings = {
    profiles: ["rung-a", "rung-b", "rung-c"].map((id) => ({
      profileId: id,
      profileName: id,
      source: "interactive" as const,
    })),
    mode: "standing",
    maxTransitionsPerRun: 3,
  };
  function onRung(profileId: string): TaskRecord {
    const task = stuckTask();
    task.attempts[0] = { ...task.attempts[0], profileId, profileName: profileId };
    return task;
  }
  const brief = (task: TaskRecord) =>
    buildStuckTaskBrief({
      task,
      outcome: "repair",
      escalation: ladder,
      externalEscalationsUsed: 0,
    }).brief;

  it("names the rung above the one the task ran on, as request_escalation would use", () => {
    expect(brief(onRung("rung-b"))).toContain("Next eligible rung: rung-c.");
  });

  it("starts at the first rung for a task on a profile that is not a rung", () => {
    expect(brief(onRung("base-worker"))).toContain("Next eligible rung: rung-a.");
  });

  it("says there is nothing further from the top rung", () => {
    expect(brief(onRung("rung-c"))).toContain("No further rung is configured");
  });
});

describe("a task stuck over an untested line", () => {
  it("names the break no check caught and offers to accept it and plan the test", () => {
    const base = stuckTask();
    const task = stuckTask({
      attempts: [
        {
          ...base.attempts[0],
          result: {
            status: "completed",
            output: "",
            patches: [],
            verification: {
              status: "passed",
              commands: [{ command: "swift test", exitCode: 0, output: "ok" }],
            },
          },
          mutation: {
            at: "t",
            mutants: [
              { path: "Sources/A.swift", line: 139, change: "`+` → `-`", caught: true },
              { path: "Sources/MainWindow.swift", line: 72, change: "`!=` → `==`", caught: false },
            ],
          },
        },
      ],
    });
    const result = buildStuckTaskBrief({
      task,
      outcome: "repair",
      escalation,
      externalEscalationsUsed: 0,
    });
    expect(result.reason).toBe(
      "Checks pass, but the mutation check broke Sources/MainWindow.swift:72 `!=` → `==` and no check noticed.",
    );
    expect(result.brief).toMatch(/- Accept it as is:[\s\S]*request_apply_result now succeeds/);
    expect(result.brief).not.toMatch(/without a recorded error/);
  });
});

it("offers accepting a passing attempt and moving what is left into its own task", () => {
  const base = stuckTask();
  const task = stuckTask({
    attempts: [
      {
        ...base.attempts[0],
        result: {
          status: "completed",
          output: "",
          patches: [],
          verification: {
            status: "passed",
            commands: [{ command: "swift test", exitCode: 0, output: "ok" }],
          },
        },
      },
    ],
  });
  const result = buildStuckTaskBrief({
    task,
    outcome: "repair",
    escalation,
    externalEscalationsUsed: 0,
  });
  expect(result.reason).toBe(
    "Its checks passed; the fix rounds ran out on further work you asked for.",
  );
  expect(result.brief).toMatch(/- Accept it as is with request_apply_result[\s\S]*delegate_task/);
});
