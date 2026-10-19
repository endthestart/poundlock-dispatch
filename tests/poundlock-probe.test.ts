import { INFERENCE_PERMISSION_PROBE_MODEL, PoundlockClient } from "@core/poundlock";
import { describe, expect, it } from "vitest";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const FEATURES = [
  "access_preflight",
  "availability_reasons",
  "data_destination",
  "durable_jobs",
  "external_invoke_permission",
  "managed_application_identities",
  "routing_revision",
  "usage_summary",
  "verifier_toolchain",
];

function poundlockFetch(options: {
  jobPermissions?: string[];
  modelsRead?: boolean;
  inference?: boolean;
  role?: string;
  /** Job options refused with 403, as for a token without job permissions. */
  jobOptionsForbidden?: boolean;
  /** null: a controller with no capabilities endpoint. */
  capabilities?: Record<string, unknown> | null;
}): typeof fetch {
  const jobPermissions = options.jobPermissions ?? ["jobs:read", "jobs:submit", "jobs:cancel"];
  const modelsRead = options.modelsRead ?? true;
  const inference = options.inference ?? true;
  const role = options.role ?? "developer";

  return (async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/readyz")) return json({ status: "ready", version: "0.1.0" });
    if (url.endsWith("/api/v1/job-options")) {
      if (options.jobOptionsForbidden)
        return json({ error: { message: "jobs:read permission required" } }, 403);
      return json({
        role,
        permissions: jobPermissions,
        models: [
          {
            id: "model-durable",
            name: "coding",
            workload_class: "durable-coding-agent",
            context_tokens: 8192,
            max_output_tokens: 1024,
          },
        ],
        harnesses: [{ id: "pi", name: "Pi", kind: "pi", version: "1.0.0" }],
        git_hosts: [],
        outbound_network_allowed: false,
        source_limits: { bytes: 1024, files: 10 },
      });
    }
    if (url.endsWith("/api/v1/capabilities")) {
      if (options.capabilities === null) return json({ error: { message: "not found" } }, 404);
      return json(
        options.capabilities ?? { api_major: 1, contract_revision: 5, features: FEATURES },
      );
    }
    if (url.endsWith("/api/v1/usage")) {
      return json({
        managed_identities: [
          { endpoint_id: "gateway", status: "ready", usage_status: "available" },
        ],
      });
    }
    if (url.endsWith("/v1/models")) {
      if (!modelsRead) {
        return json(
          { error: { message: "valid API token with models:read permission required" } },
          401,
        );
      }
      return json({ object: "list", data: [{ id: "coding" }] });
    }
    if (method === "POST" && url.endsWith("/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      expect(body.model).toBe(INFERENCE_PERMISSION_PROBE_MODEL);
      if (!inference) {
        return json(
          { error: { message: "valid API token with inference:invoke permission required" } },
          401,
        );
      }
      return json(
        {
          error: {
            message: "model must name a coordinator model profile",
            code: "unknown_model_profile",
          },
        },
        404,
      );
    }
    return json({ error: { message: `unexpected ${method} ${url}` } }, 500);
  }) as typeof fetch;
}

describe("Poundlock connection probe", () => {
  it.each<[string, Record<string, unknown> | null, string]>([
    ["no capabilities endpoint", null, "does not say which API version"],
    [
      "an older contract",
      { api_major: 1, contract_revision: 2, features: FEATURES },
      "contract revision 2",
    ],
    ["another API", { api_major: 2, contract_revision: 1, features: FEATURES }, "serves API 2"],
    [
      "a missing feature",
      { api_major: 1, contract_revision: 5, features: FEATURES.slice(1) },
      "access_preflight",
    ],
  ])(
    "refuses a controller with %s, saying what to upgrade",
    async (_case, capabilities, message) => {
      const client = new PoundlockClient(
        "https://poundlock.example",
        "token",
        poundlockFetch({ capabilities }),
      );
      const probe = await client.probe();
      expect(probe.ok).toBe(false);
      expect(probe.error).toContain(message);
      expect(probe.hint).toMatch(/Upgrade Poundlock|Dispatch release/);
    },
  );

  it("accepts the tested controller and a newer, additive one", async () => {
    for (const capabilities of [
      { api_major: 1, contract_revision: 5, features: FEATURES },
      {
        api_major: 1,
        contract_revision: 9,
        features: [...FEATURES, "future_feature"],
        extra: true,
      },
    ]) {
      const probe = await new PoundlockClient(
        "https://poundlock.example",
        "token",
        poundlockFetch({ capabilities }),
      ).probe();
      expect(probe.ok, probe.error).toBe(true);
    }
  });

  it("reports TLS trust failures instead of a generic unreachable controller", async () => {
    const cause = Object.assign(new Error("unable to get local issuer certificate"), {
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    });
    const client = new PoundlockClient("https://poundlock.example", "token", (async () => {
      throw new TypeError("fetch failed", { cause });
    }) as typeof fetch);

    const probe = await client.probe();

    expect(probe.error).toContain("Could not verify the TLS certificate");
    expect(probe.hint).toContain("system trust store");
  });

  it.each<[number, string]>([
    [200, '{"error":{"code":"unknown_model_profile"}}'],
    [400, '{"error":{"code":"unknown_model_profile"}}'],
    [404, '{"error":{"code":"route_not_found"}}'],
    [500, '{"error":{"code":"unknown_model_profile"}}'],
    [404, "not json"],
    [404, "null"],
  ])("rejects ambiguous permission response %s %s", async (status, body) => {
    const fallback = poundlockFetch({});
    const wrapper: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/v1/chat/completions")) {
        expect(JSON.parse(String(init?.body))).toEqual({ model: "", messages: [] });
        return new Response(body, { status });
      }
      return fallback(input, init);
    };
    const client = new PoundlockClient("https://poundlock.example", "token", wrapper);
    const result = await client.probe();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Could not determine inference permission");
  });

  it("treats a full Access token as usable even though job-options omits models and inference", async () => {
    const client = new PoundlockClient(
      "https://poundlock.example",
      "token",
      poundlockFetch({
        jobPermissions: ["jobs:read", "jobs:submit", "jobs:cancel"],
        modelsRead: true,
        inference: true,
      }),
    );
    const probe = await client.probe();
    expect(probe.ok, probe.hint).toBe(true);
    expect(probe.missingPermissions).toEqual([]);
    expect(probe.permissions).toEqual(
      expect.arrayContaining(["models:read", "inference:invoke", "jobs:read"]),
    );
    expect(probe.interactiveModels.map((model) => model.id)).toContain("coding");
    expect(probe.managedIdentities).toEqual([
      { endpoint_id: "gateway", status: "ready", usage_status: "available" },
    ]);
  });

  it("collapses /v1 alias rows onto one profile", async () => {
    const client = new PoundlockClient("https://poundlock.example", "token", (async (input) => {
      const url = String(input);
      if (url.endsWith("/readyz")) return json({ status: "ready", version: "0.1.0" });
      if (url.endsWith("/api/v1/job-options")) {
        return json({
          role: "developer",
          permissions: ["jobs:read", "jobs:submit", "jobs:cancel"],
          models: [],
          harnesses: [],
          git_hosts: [],
          outbound_network_allowed: false,
          source_limits: { bytes: 1024, files: 10 },
        });
      }
      if (url.endsWith("/v1/models")) {
        return json({
          object: "list",
          data: [
            {
              id: "node-a-predict",
              poundlock: {
                profile_id: "p1",
                canonical_name: "node-a-predict",
                aliases: ["predict"],
                upstream_model: "qwen25-coder-3b-fim",
                workload_class: "fast-code-completion",
              },
            },
            {
              id: "predict",
              poundlock: {
                profile_id: "p1",
                canonical_name: "node-a-predict",
                aliases: ["predict"],
                upstream_model: "qwen25-coder-3b-fim",
                workload_class: "fast-code-completion",
              },
            },
          ],
        });
      }
      if (url.endsWith("/v1/chat/completions")) {
        return json({ error: { message: "unknown", code: "unknown_model_profile" } }, 404);
      }
      return json({ error: { message: url } }, 500);
    }) as typeof fetch);
    const probe = await client.probe();
    expect(probe.interactiveModels).toHaveLength(1);
    expect(probe.interactiveModels[0]?.id).toBe("node-a-predict");
    expect(probe.interactiveModels[0]?.aliases).toEqual(["predict"]);
    expect(probe.interactiveModels[0]?.upstreamModel).toBe("qwen25-coder-3b-fim");
  });

  it("reports the Access labels when models and inference are actually missing", async () => {
    const client = new PoundlockClient(
      "https://poundlock.example",
      "token",
      poundlockFetch({
        jobPermissions: ["jobs:read", "jobs:submit", "jobs:cancel"],
        modelsRead: false,
        inference: false,
      }),
    );
    const probe = await client.probe();
    expect(probe.ok).toBe(false);
    expect(probe.missingPermissions).toEqual(["models:read", "inference:invoke"]);
    expect(probe.hint).toContain("List available models");
    expect(probe.hint).toContain("Send inference requests");
    expect(probe.hint).not.toContain("models:read");
  });

  it("connects a token that has only model and inference permissions", async () => {
    const client = new PoundlockClient(
      "https://poundlock.example",
      "token",
      poundlockFetch({ jobPermissions: [], jobOptionsForbidden: true }),
    );
    const probe = await client.probe();
    expect(probe.ok).toBe(true);
    expect(probe.missingPermissions).toEqual([]);
    expect(probe.permissions).not.toContain("jobs:submit");
    expect(probe.durableModels).toEqual([]);
  });
});
