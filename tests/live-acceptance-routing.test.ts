/**
 * Acceptance test for capability-measured routing, run against a whole
 * `/v1/models` payload in the controller's contract-revision-3 shape rather
 * than single hand-built rows: two local profiles with measured evidence, local
 * and gateway profiles without any, and the derived `stale`/`settings_match`
 * fields the controller adds. The case it guards: an open-ended feasibility
 * question ("can we run PostgreSQL here?") that is small by every size
 * measure must not start on a worker whose evidence shows it fails that kind
 * of task.
 *
 * The payload in `tests/fixtures/models-capabilities.json` is synthetic.
 */

import { readFileSync } from "node:fs";
import { parseInteractiveModels } from "@core/poundlock";
import { resolveStartingWorkerBinding } from "@core/role-routing";
import type { RoleBinding, RoleMap } from "@shared/roles";
import type { ConnectionSettings } from "@shared/types";
import { describe, expect, it } from "vitest";

const live = JSON.parse(
  readFileSync(new URL("./fixtures/models-capabilities.json", import.meta.url), "utf8"),
) as { data?: Parameters<typeof parseInteractiveModels>[0] };
const models = parseInteractiveModels(live.data);
const fast = models.find((model) => model.name === "fast-local");
const general = models.find((model) => model.name === "general-local");

function binding(model: { profileId?: string; id: string; name?: string }): RoleBinding {
  return {
    profileId: model.profileId ?? model.id,
    profileName: model.name ?? "",
    source: "interactive",
  };
}

describe("capability routing against a whole published model list", () => {
  it("publishes both local profiles with usable measured evidence", () => {
    expect(fast).toBeDefined();
    expect(general).toBeDefined();
    // If this fails the measurements are stale or no longer describe the
    // profile, and every assertion below would silently pass for the wrong
    // reason — an unknown capability never excludes a rung.
    for (const entry of fast?.capabilities ?? []) {
      expect(entry.stale).toBe(false);
      expect(entry.settings_match).toBe("exact");
    }
    expect(fast?.capabilities?.map((entry) => [entry.name, entry.passed])).toEqual(
      expect.arrayContaining([
        ["sealed_investigation", 0],
        ["plan_tool_schema", 0],
      ]),
    );
  });

  const roles: RoleMap = { interactive: binding(fast!) };
  const connection: ConnectionSettings = {
    url: "",
    token: "",
    roles,
    escalation: { profiles: [binding(general!)], mode: "ask", maxTransitionsPerRun: 3 },
  };

  it("still starts a small closed implementation task on the base worker", () => {
    const chosen = resolveStartingWorkerBinding(
      models,
      roles,
      connection,
      "small",
      "closed_implementation",
    );
    expect(chosen.model.name).toBe("fast-local");
  });

  it("does not start the PostgreSQL-style open investigation on the measured-failed rung", () => {
    const chosen = resolveStartingWorkerBinding(
      models,
      roles,
      connection,
      "small",
      "open_investigation",
    );
    expect(chosen.model.name).toBe("general-local");
    expect(chosen.reason).toContain("general-local");
  });

  it("excludes the same rung for planning, which it also measured-failed", () => {
    const chosen = resolveStartingWorkerBinding(models, roles, connection, "small", "planning");
    expect(chosen.model.name).toBe("general-local");
  });

  it("reproduces today's behaviour exactly when the manager names no task kind", () => {
    const chosen = resolveStartingWorkerBinding(models, roles, connection, "small");
    expect(chosen.model.name).toBe("fast-local");
  });
});
