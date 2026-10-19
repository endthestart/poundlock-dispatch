import {
  DIFFICULTY_CONTEXT_THRESHOLD,
  projectWorkerRoles,
  resolveInteractiveWorkerProfile,
  resolveStartingWorkerBinding,
} from "@core/role-routing";
import type { RoleBinding, RoleMap } from "@shared/roles";
import type { CapabilityMeasurement, ConnectionSettings, InteractiveModel } from "@shared/types";
import { describe, expect, it } from "vitest";

function capability(
  name: CapabilityMeasurement["name"],
  overrides: Partial<CapabilityMeasurement> = {},
): CapabilityMeasurement {
  return {
    name,
    status: "qualified",
    passed: 3,
    attempted: 3,
    settings_match: "exact",
    ...overrides,
  };
}

function binding(id: string): RoleBinding {
  return { profileId: id, profileName: id, source: "interactive" };
}

function localModel(
  id: string,
  contextTokens: number,
  extra: Partial<InteractiveModel> = {},
): InteractiveModel {
  return {
    id,
    profileId: id,
    name: id,
    aliases: [],
    workload_class: "interactive-coding",
    context_tokens: contextTokens,
    max_output_tokens: 4096,
    dataDestination: "operator_network",
    ...extra,
  };
}

function externalModel(id: string, contextTokens: number): InteractiveModel {
  return localModel(id, contextTokens, { dataDestination: "external" });
}

const roles: RoleMap = { interactive: binding("orion") };

function connectionWith(profiles: RoleBinding[]): ConnectionSettings {
  return {
    url: "",
    token: "",
    roles,
    escalation: { profiles, mode: "ask", maxTransitionsPerRun: 3 },
  };
}

describe("resolveStartingWorkerBinding: difficulty picks the starting rung", () => {
  const vega = localModel("vega", 200_000);
  const base = localModel("orion", 32_768);

  it("always starts small tasks on the base worker, even with a bigger local rung configured", () => {
    const models = [base, vega];
    const connection = connectionWith([binding("vega")]);
    const result = resolveStartingWorkerBinding(models, roles, connection, "small");
    expect(result.model.id).toBe("orion");
  });

  it("climbs to the first local rung whose context meets the medium threshold", () => {
    const models = [base, vega];
    const connection = connectionWith([binding("vega")]);
    expect(DIFFICULTY_CONTEXT_THRESHOLD.medium).toBe(64 * 1024);
    const result = resolveStartingWorkerBinding(models, roles, connection, "medium");
    expect(result.model.id).toBe("vega");
  });

  it("picks the first sufficient rung in ladder order, not the largest one", () => {
    const midRung = localModel("mid", 80_000);
    const bigRung = localModel("big", 500_000);
    const models = [base, midRung, bigRung];
    const connection = connectionWith([binding("mid"), binding("big")]);
    const result = resolveStartingWorkerBinding(models, roles, connection, "medium");
    expect(result.model.id).toBe("mid");
  });

  it("needs the large threshold (128K) and falls back to the largest local rung when nothing qualifies", () => {
    const smallLocal = localModel("small-local", 40_000);
    const models = [base, smallLocal];
    const connection = connectionWith([binding("small-local")]);
    const result = resolveStartingWorkerBinding(models, roles, connection, "large");
    expect(result.model.id).toBe("small-local");
  });

  it("falls back to the base worker when no ladder rung is configured", () => {
    const models = [base];
    const connection = connectionWith([]);
    const result = resolveStartingWorkerBinding(models, roles, connection, "large");
    expect(result.model.id).toBe("orion");
  });
});

describe("resolveStartingWorkerBinding: an external rung is never auto-selected", () => {
  const base = localModel("orion", 8_192);
  const localRung = localModel("vega", 40_000);
  const frontier = externalModel("frontier", 1_000_000);

  it("skips a bigger external rung even when it is the only one with enough context", () => {
    const models = [base, localRung, frontier];
    const connection = connectionWith([binding("vega"), binding("frontier")]);
    const result = resolveStartingWorkerBinding(models, roles, connection, "large");
    // Neither local rung meets the 128K threshold; the external rung is never
    // considered, so the largest eligible LOCAL rung wins instead.
    expect(result.model.id).toBe("vega");
    expect(result.model.dataDestination).toBe("operator_network");
  });

  it("skips an external rung even when it is ordered before a qualifying local one", () => {
    const bigLocal = localModel("mac-studio", 200_000);
    const models = [base, frontier, bigLocal];
    const connection = connectionWith([binding("frontier"), binding("mac-studio")]);
    const result = resolveStartingWorkerBinding(models, roles, connection, "medium");
    expect(result.model.id).toBe("mac-studio");
  });

  it("never returns an external profile even via resolveInteractiveWorkerProfile", () => {
    const models = [base, frontier];
    const connection = connectionWith([binding("frontier")]);
    const project = { policy: { allowedWorkerProfileIds: [] } } as never;
    const selected = resolveInteractiveWorkerProfile(
      models,
      roles,
      project,
      { difficulty: "large", attempts: [] },
      connection,
    );
    expect(selected.dataDestination).not.toBe("external");
    expect(selected.id).toBe("orion");
  });
});

describe("resolveStartingWorkerBinding: availability fallback stays local", () => {
  const base = localModel("orion", 32_768);
  const vega = localModel("vega", 200_000);
  const macStudio = localModel("mac-studio", 200_000);
  const frontier = externalModel("frontier", 1_000_000);

  it("skips a busy rung for the next eligible local one, in order", () => {
    const models = [base, { ...vega, busy: true }, macStudio];
    const connection = connectionWith([binding("vega"), binding("mac-studio")]);
    const result = resolveStartingWorkerBinding(models, roles, connection, "medium");
    expect(result.model.id).toBe("mac-studio");
  });

  it("never spills over to an external rung when every local rung is busy", () => {
    const models = [{ ...base, busy: true }, { ...vega, busy: true }, frontier];
    const connection = connectionWith([binding("vega"), binding("frontier")]);
    // No eligible local candidate remains, so Dispatch falls back to the
    // plainly-mapped base worker rather than reaching for the external rung.
    // This never needs consent: an external destination is simply never in
    // play for this automatic choice, regardless of the escalation mode.
    const result = resolveStartingWorkerBinding(models, roles, connection, "medium");
    expect(result.model.id).toBe("orion");
  });
});

describe("resolveStartingWorkerBinding: legacy escalation settings still load", () => {
  const base = localModel("orion", 8_192);
  const vega = localModel("vega", 200_000);

  it("honors a pre-ladder single `roles.escalation` binding when no connection.escalation is saved", () => {
    const legacyRoles: RoleMap = {
      interactive: binding("orion"),
      escalation: binding("vega"),
    };
    const connection: ConnectionSettings = { url: "", token: "", roles: legacyRoles };
    const models = [base, vega];
    const result = resolveStartingWorkerBinding(models, legacyRoles, connection, "medium");
    expect(result.model.id).toBe("vega");
  });

  it("loads a saved binding that only has the deprecated routingRevision field", () => {
    const legacyBinding: RoleBinding = {
      profileId: "vega",
      profileName: "vega",
      source: "interactive",
      routingRevision: "r1",
    };
    const connection: ConnectionSettings = {
      url: "",
      token: "",
      roles,
      escalation: { profiles: [legacyBinding], mode: "standing", maxTransitionsPerRun: 3 },
    };
    const models = [base, { ...vega, routingRevision: "r1" }];
    const result = resolveStartingWorkerBinding(models, roles, connection, "medium");
    expect(result.model.id).toBe("vega");
  });
});

describe("resolveStartingWorkerBinding: taskKind narrows the small short-circuit", () => {
  const base = localModel("orion", 32_768);
  const vega = localModel("vega", 200_000);

  it("small + closed_implementation still starts on the base worker", () => {
    const models = [base, vega];
    const connection = connectionWith([binding("vega")]);
    const result = resolveStartingWorkerBinding(
      models,
      roles,
      connection,
      "small",
      "closed_implementation",
    );
    expect(result.model.id).toBe("orion");
  });

  it("small + closed_implementation forces the base worker even when it is busy, exactly as an undefined taskKind does today", () => {
    const models = [{ ...base, busy: true }, vega];
    const connection = connectionWith([binding("vega")]);
    const withKind = resolveStartingWorkerBinding(
      models,
      roles,
      connection,
      "small",
      "closed_implementation",
    );
    const withoutKind = resolveStartingWorkerBinding(models, roles, connection, "small");
    expect(withKind.model.id).toBe("orion");
    expect(withoutKind.model.id).toBe("orion");
  });

  // The plan's own motivating failure: an open-ended feasibility question was
  // "small" by every context-size measure and was force-started on the base
  // worker regardless of its own eligibility. Not short-circuiting means an
  // open_investigation (or planning) task instead goes through the same
  // eligibility gate medium/large tasks already use — including the busy
  // check `plainBaseWorker` never applied.
  it("small + open_investigation does not force a busy base worker; it climbs to the next eligible rung", () => {
    const models = [{ ...base, busy: true }, vega];
    const connection = connectionWith([binding("vega")]);
    const result = resolveStartingWorkerBinding(
      models,
      roles,
      connection,
      "small",
      "open_investigation",
    );
    expect(result.model.id).toBe("vega");
  });

  it("small + planning does not force a busy base worker either", () => {
    const models = [{ ...base, busy: true }, vega];
    const connection = connectionWith([binding("vega")]);
    const result = resolveStartingWorkerBinding(models, roles, connection, "small", "planning");
    expect(result.model.id).toBe("vega");
  });
});

describe("resolveStartingWorkerBinding: capability-aware routing", () => {
  const base = localModel("orion", 32_768);

  it("drops a rung with a measured failure for the task's required capability", () => {
    const failedRung = localModel("vega", 200_000, {
      capabilities: [capability("sealed_investigation", { status: "insufficient", passed: 0 })],
    });
    const capableRung = localModel("mac-studio", 200_000, {
      capabilities: [capability("sealed_investigation")],
    });
    const models = [base, failedRung, capableRung];
    const connection = connectionWith([binding("vega"), binding("mac-studio")]);
    const result = resolveStartingWorkerBinding(
      models,
      roles,
      connection,
      "medium",
      "open_investigation",
    );
    expect(result.model.id).toBe("mac-studio");
  });

  it("never excludes a rung with no capability measurement at all", () => {
    const unmeasured = localModel("vega", 200_000);
    const models = [base, unmeasured];
    const connection = connectionWith([binding("vega")]);
    const result = resolveStartingWorkerBinding(
      models,
      roles,
      connection,
      "medium",
      "open_investigation",
    );
    expect(result.model.id).toBe("vega");
  });

  it("treats a stale measurement as unknown rather than qualified", () => {
    // The only "qualified" evidence anywhere is stale, so it must not be
    // preferred over an equally unmeasured rung purely on its stale label.
    const stale = localModel("vega", 200_000, {
      capabilities: [capability("sealed_investigation", { stale: true })],
    });
    const models = [base, stale];
    const connection = connectionWith([binding("vega")]);
    const result = resolveStartingWorkerBinding(
      models,
      roles,
      connection,
      "medium",
      "open_investigation",
    );
    // Still picked (it is the only medium-eligible rung), but via the
    // unknown-inclusive search tier, not because it looked qualified.
    expect(result.model.id).toBe("vega");
  });

  it("treats a settings-mismatched measurement as unknown rather than qualified", () => {
    const mismatched = localModel("vega", 200_000, {
      capabilities: [capability("sealed_investigation", { settings_match: "different" })],
    });
    const models = [base, mismatched];
    const connection = connectionWith([binding("vega")]);
    const result = resolveStartingWorkerBinding(
      models,
      roles,
      connection,
      "medium",
      "open_investigation",
    );
    expect(result.model.id).toBe("vega");
  });

  it("falls back to today's capability-blind choice, without throwing, when every eligible rung has measured-failed", () => {
    // Including the base worker's own rung: the empty-after-filter fallback
    // only fires when there is truly nothing left, not merely when the
    // ladder's added rungs failed.
    const failedBase = localModel("orion", 32_768, {
      capabilities: [capability("sealed_investigation", { status: "insufficient", passed: 0 })],
    });
    const failedA = localModel("vega", 200_000, {
      capabilities: [capability("sealed_investigation", { status: "insufficient", passed: 0 })],
    });
    const failedB = localModel("mac-studio", 500_000, {
      capabilities: [capability("sealed_investigation", { status: "insufficient", passed: 0 })],
    });
    const models = [failedBase, failedA, failedB];
    const connection = connectionWith([binding("vega"), binding("mac-studio")]);
    expect(() =>
      resolveStartingWorkerBinding(models, roles, connection, "medium", "open_investigation"),
    ).not.toThrow();
    const result = resolveStartingWorkerBinding(
      models,
      roles,
      connection,
      "medium",
      "open_investigation",
    );
    // Today's context-threshold search, ignoring capability entirely: the
    // first ladder rung meeting the medium threshold.
    expect(result.model.id).toBe("vega");
    expect(result.reason).toMatch(/measured failure/i);
  });

  it("does not apply any capability check when taskKind is absent, reproducing today's selection exactly", () => {
    const failedRung = localModel("vega", 200_000, {
      capabilities: [capability("sealed_investigation", { status: "insufficient", passed: 0 })],
    });
    const models = [base, failedRung];
    const connection = connectionWith([binding("vega")]);
    const result = resolveStartingWorkerBinding(models, roles, connection, "medium");
    expect(result.model.id).toBe("vega");
  });
});

describe("a project's own worker", () => {
  const appWorker = localModel("orion", 32_768);
  const projectWorker = localModel("vega", 200_000);
  const appRoles: RoleMap = {
    manager: binding("manager"),
    interactive: binding("orion"),
  };

  it("starts small tasks on the project's worker instead of the app default", () => {
    const project = {
      policy: { allowedWorkerProfileIds: [], workerModel: "vega" },
    } as never;
    const selected = resolveInteractiveWorkerProfile(
      [appWorker, projectWorker],
      appRoles,
      project,
      { difficulty: "small", attempts: [] },
      connectionWith([]),
    );
    expect(selected.id).toBe("vega");
  });

  it("uses the app default when the project has none, and never changes the app roles", () => {
    expect(projectWorkerRoles(appRoles, {})).toBe(appRoles);
    const overridden = projectWorkerRoles(appRoles, { workerModel: "vega" });
    expect(overridden.interactive?.profileId).toBe("vega");
    expect(overridden.manager).toBe(appRoles.manager);
    expect(appRoles.interactive?.profileId).toBe("orion");
  });

  it("does not substitute when the project's worker is not served", () => {
    const project = { policy: { allowedWorkerProfileIds: [], workerModel: "gone" } } as never;
    expect(() =>
      resolveInteractiveWorkerProfile(
        [appWorker],
        appRoles,
        project,
        { difficulty: "small", attempts: [] },
        connectionWith([]),
      ),
    ).toThrow(/not currently eligible/);
  });
});
