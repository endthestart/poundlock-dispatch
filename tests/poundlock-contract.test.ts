import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTED_API_MAJOR,
  EXPECTED_CONTRACT_REVISION,
  missingCapabilityFeatures,
  parseCapabilities,
  TESTED_POUNDLOCK_VERSION,
} from "@core/capabilities";
import { parseInteractiveModels } from "@core/poundlock";
import { describe, expect, it } from "vitest";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/poundlock-contract-revision-2.json"), "utf8"),
) as {
  api_major: number;
  contract_revision: number;
  interactive_catalog_example: Parameters<typeof parseInteractiveModels>[0] extends
    | (infer T)[]
    | undefined
    ? T
    : never;
};
const compatibility = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "compat", "poundlock.json"), "utf8"),
) as {
  schema_version: number;
  tested_with: { poundlock_version: string; api_major: number; contract_revision: number };
  api_major: number;
  minimum_contract_revision: number;
  required_features: string[];
};

describe("Poundlock compatibility", () => {
  it("compat/poundlock.json states what the client enforces, and names no private build", () => {
    expect(fixture.api_major).toBe(EXPECTED_API_MAJOR);
    expect(fixture.contract_revision).toBe(EXPECTED_CONTRACT_REVISION);
    expect(compatibility).toMatchObject({
      schema_version: 2,
      tested_with: {
        poundlock_version: TESTED_POUNDLOCK_VERSION,
        api_major: 1,
        contract_revision: 5,
      },
      api_major: EXPECTED_API_MAJOR,
      minimum_contract_revision: EXPECTED_CONTRACT_REVISION,
    });
    expect(Object.keys(compatibility).sort()).toEqual([
      "api_major",
      "minimum_contract_revision",
      "required_features",
      "schema_version",
      "tested_with",
    ]);
    expect(
      missingCapabilityFeatures(
        parseCapabilities({
          api_major: 1,
          contract_revision: 3,
          features: compatibility.required_features,
        }),
      ),
    ).toEqual([]);
  });

  it("tolerates unknown capability fields and binds aliases to one profile UUID", () => {
    const capabilities = parseCapabilities({
      api_major: 1,
      contract_revision: 3,
      features: [
        "access_preflight",
        "availability_reasons",
        "data_destination",
        "durable_jobs",
        "external_invoke_permission",
        "managed_application_identities",
        "routing_revision",
        "usage_summary",
        "verifier_toolchain",
        "future_flag",
      ],
      extra_operator_field: { ignored: true },
    });
    expect(missingCapabilityFeatures(capabilities)).toEqual([]);
    expect(capabilities.extra_operator_field).toEqual({ ignored: true });
    const models = parseInteractiveModels([
      fixture.interactive_catalog_example,
      {
        id: "deepseek-flash",
        poundlock: {
          profile_id: "11111111-1111-1111-1111-111111111111",
          canonical_name: "frontier-deepseek-flash",
          aliases: ["deepseek-flash"],
        },
      },
    ]);
    expect(models).toHaveLength(1);
    expect(models[0].profileId).toBe("11111111-1111-1111-1111-111111111111");
    expect(models[0].id).toBe("frontier-deepseek-flash");
    expect(models[0].aliases).toContain("deepseek-flash");
  });
});

describe("Poundlock contract revision 4 models fixture", () => {
  const path = join(import.meta.dirname, "fixtures/poundlock-models-contract-revision-4.json");
  const document = JSON.parse(readFileSync(path, "utf8")) as {
    poundlock: { contract_revision: number };
    data: Parameters<typeof parseInteractiveModels>[0];
  };

  it("is Poundlock's own published fixture", () => {
    // Poundlock generates this file from the row its relay emits. When both
    // repositories are checked out side by side, the copies must say the same thing.
    const owner = join(
      import.meta.dirname,
      "../../poundlock/docs/reference/fixtures/models-contract-revision-4.json",
    );
    if (existsSync(owner)) expect(document).toEqual(JSON.parse(readFileSync(owner, "utf8")));
    expect(document.poundlock.contract_revision).toBe(4);
  });

  it("parses verified reasoning, route facts and a disabled status", () => {
    const [model] = parseInteractiveModels(document.data);
    expect(model).toMatchObject({
      id: "frontier-gpt-sol",
      dataDestination: "external",
      reasoningLevels: ["none", "low", "medium", "high", "xhigh"],
      reasoningVerifiedAt: "2026-09-23T14:05:00Z",
      servedModel: "openrouter/openai/gpt-6-sol",
      provider: "openrouter",
      pricing: { inputPerMtok: 2, outputPerMtok: 10, source: "litellm_route" },
      status: "disabled",
      disabled: {
        source: "relay",
        since: "2026-09-23T15:00:00Z",
        lastCheck: "2026-09-23T15:00:00Z",
      },
    });
  });

  it("offers nothing it cannot verify from a revision 3 row or a malformed one", () => {
    const [plain] = parseInteractiveModels([{ id: "local", poundlock: { profile_id: "p" } }]);
    expect(plain.reasoningLevels).toEqual([]);
    expect(plain.pricing).toBeUndefined();
    expect(plain.status).toBeUndefined();
    const [odd] = parseInteractiveModels([
      {
        id: "odd",
        poundlock: {
          profile_id: "q",
          reasoning: { supported: ["max", "HIGH", "none", 3] },
          pricing: { input_per_mtok: "2", output_per_mtok: 10, source: "x" },
        },
      },
    ]);
    expect(odd.reasoningLevels).toEqual(["none"]);
    expect(odd.pricing).toBeUndefined();
  });
});
