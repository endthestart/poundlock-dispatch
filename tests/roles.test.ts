import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseInteractiveModels } from "@core/poundlock";
import { createFolderProject } from "@core/projects";
import { resolveVerifierProfile } from "@core/role-routing";
import { listLiveProjectFiles } from "@core/snapshot";
import { FileStore } from "@core/store";
import {
  catalogFromProbe,
  guessRoleMap,
  hasUse,
  interactiveUnavailableReason,
  ROLE_DEFINITIONS,
  roleMapReady,
  roleUnavailableReason,
  sameRuntimeSlot,
} from "@shared/roles";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

describe("execution role guessing", () => {
  it("maps a Poundlock catalog like the generic installation", () => {
    const interactiveModels = parseInteractiveModels([
      listed("node-a-fast", { workload_class: "interactive-coding", upstream_model: "qwen3.5:4b" }),
      listed("node-a-predict", {
        profile_id: "predict-id",
        aliases: ["predict"],
        workload_class: "fast-code-completion",
        upstream_model: "qwen25-coder-3b-fim",
      }),
      listed("predict", {
        profile_id: "predict-id",
        canonical_name: "node-a-predict",
        aliases: ["predict"],
        workload_class: "fast-code-completion",
        upstream_model: "qwen25-coder-3b-fim",
      }),
      listed("node-a-workflow", {
        workload_class: "durable-coding-agent",
        upstream_model: "qwen3.5:4b",
      }),
      listed("documents-profile", {
        workload_class: "interactive-coding",
        upstream_model: "qwen35-4b-documents",
      }),
      listed("node-b-durable", {
        workload_class: "durable-coding-agent",
        upstream_model: "node-b-active",
      }),
      listed("node-b-general", {
        profile_id: "general-id",
        aliases: ["coding"],
        workload_class: "interactive-coding",
        upstream_model: "node-b-active",
      }),
      listed("coding", {
        profile_id: "general-id",
        canonical_name: "node-b-general",
        aliases: ["coding"],
        workload_class: "interactive-coding",
        upstream_model: "node-b-active",
      }),
    ]);
    expect(interactiveModels.map((model) => model.id)).toEqual([
      "node-a-fast",
      "node-a-predict",
      "node-a-workflow",
      "documents-profile",
      "node-b-durable",
      "node-b-general",
    ]);
    const roles = guessRoleMap({ interactiveModels });
    expect(roles.snippet?.profileName).toBe("node-a-predict");
    expect(roles.manager?.profileName).toBe("node-a-fast");
    expect(roles.interactive?.profileName).toBe("documents-profile");
    // Job profiles are not bound to anything: no role is for them.
    expect(Object.keys(roles)).not.toContain("durable");
    expect(roles.escalation).toBeUndefined();
    expect(roleMapReady(roles)).toBe(true);
  });

  it("does not turn a gateway or provider name into escalation authority", () => {
    const interactiveModels = [
      {
        id: "documents-profile",
        name: "documents-profile",
        context_tokens: 8192,
        max_output_tokens: 1024,
      },
      {
        id: "frontier-chat",
        name: "frontier-chat",
        aliases: ["claude-sonnet"],
        upstreamModel: "claude-sonnet-4",
        endpointKind: "litellm",
      },
    ];
    const roles = guessRoleMap({ interactiveModels });
    expect(roles.escalation).toBeUndefined();
  });

  it("does not silently assign the manager profile as the interactive worker", () => {
    const roles = guessRoleMap({
      interactiveModels: [
        { id: "only", name: "only", context_tokens: 8192, max_output_tokens: 1024 },
      ],
    });
    expect(roles.manager?.profileName).toBe("only");
    expect(roles.interactive).toBeUndefined();
    expect(roleMapReady(roles)).toBe(false);
  });

  it("lets a profile that also runs jobs serve as a worker", () => {
    const [vega] = parseInteractiveModels([
      listed("vega", {
        workload_class: "interactive-coding",
        uses: ["durable", "interactive"],
        upstream_model: "node-b-active",
      }),
    ]);
    expect(vega?.uses).toEqual(["durable", "interactive"]);
    expect(interactiveUnavailableReason(vega!)).toBeUndefined();
    const [entry] = catalogFromProbe({ interactiveModels: [vega!] });
    expect(roleUnavailableReason(entry, "interactive")).toBeUndefined();
  });

  it("offers only the interactive profiles, though the probe also lists jobs", () => {
    const interactiveModels = [
      { id: "worker", name: "worker", context_tokens: 8192, max_output_tokens: 1024 },
    ];
    const probe = {
      interactiveModels,
      durableModels: [
        {
          id: "uuid-job",
          name: "job-profile",
          aliases: [],
          model_id: "node-b-active",
          context_tokens: 131072,
          max_output_tokens: 4096,
          workload_class: "durable-coding-agent",
          wake_policy: "on-demand",
        },
      ],
    };
    expect(catalogFromProbe(probe).map((profile) => profile.name)).toEqual(["worker"]);
  });

  it("falls back to the single workload class from older Poundlock servers", () => {
    expect(interactiveUnavailableReason({ workload_class: "durable-coding-agent" })).toBe(
      "Background jobs only",
    );
    expect(interactiveUnavailableReason({ workload_class: "fast-code-completion" })).toBe(
      "Autocomplete only",
    );
    expect(hasUse({ workload_class: "durable-coding-agent" }, "durable")).toBe(true);
    expect(hasUse({}, "interactive")).toBe(true);
  });
});

describe("path-only folder projects", () => {
  it("attaches a folder without copying files or applying the 50 MiB job limit", async () => {
    const folder = await tempDir("dispatch-live-");
    await writeFile(join(folder, "app.ts"), "export {}\n");
    await mkdir(join(folder, "node_modules"), { recursive: true });
    await writeFile(join(folder, "node_modules", "huge.js"), "nope\n");
    const data = await tempDir("dispatch-data-");
    const store = new FileStore(data);
    await store.init();
    const project = await createFolderProject({ store, folder, name: "live" });
    expect(project.source.kind).toBe("local_folder");
    if (project.source.kind !== "local_folder") throw new Error("expected folder");
    expect(project.source.originalPath).toBe(await realpath(folder));
    expect(project.source.includedFiles).toBe(0);
    expect(project.source.originalFingerprint).toBe("");
    const listed = await listLiveProjectFiles(folder);
    expect(listed.some((file) => file.path === "app.ts")).toBe(true);
    expect(listed.some((file) => file.path.includes("node_modules"))).toBe(false);
  });
});

function listed(
  id: string,
  poundlock: {
    profile_id?: string;
    canonical_name?: string;
    aliases?: string[];
    workload_class?: string;
    uses?: string[];
    upstream_model?: string;
  },
) {
  return {
    id,
    poundlock: {
      context_tokens: 8192,
      max_output_tokens: 1024,
      profile_id: poundlock.profile_id ?? `${id}-id`,
      canonical_name: poundlock.canonical_name ?? id,
      aliases: poundlock.aliases ?? [],
      upstream_model: poundlock.upstream_model,
      workload_class: poundlock.workload_class,
      uses: poundlock.uses,
    },
  };
}

describe("which profiles share one model slot", () => {
  const on = (slot: string | null | undefined, node = "n", runtime = "local-general") => ({
    occupancy: {
      kind: null,
      ...(slot === undefined ? {} : { slot }),
      node_id: node,
      runtime_profile: runtime,
    },
  });

  it("follows the controller's published slot", () => {
    expect(sameRuntimeSlot(on("n/local-general"), on("n/local-general"))).toBe(true);
    expect(sameRuntimeSlot(on("n/local-general"), on("n/other"))).toBe(false);
  });

  it("does not call two unslotted profiles contended just because they share a machine", () => {
    // The controller fills node and runtime in for every profile, exclusive
    // or not; a null slot is its word that there is nothing to contend for.
    expect(sameRuntimeSlot(on(null), on(null))).toBe(false);
  });

  it("falls back to node and runtime for a controller that predates slot", () => {
    expect(sameRuntimeSlot(on(undefined), on(undefined))).toBe(true);
    expect(sameRuntimeSlot(on(undefined), on(undefined, "other"))).toBe(false);
    expect(sameRuntimeSlot({}, on(undefined))).toBe(false);
  });
});

describe("the Verifier role", () => {
  const strong = {
    id: "strong",
    context_tokens: 131072,
    max_output_tokens: 8192,
    dataDestination: "operator_network" as const,
    workload_class: "interactive-coding",
    routingRevision: "r2",
  };
  const bind = (routingRevision?: string) => ({
    verifier: {
      profileId: "strong",
      profileName: "Strong",
      source: "interactive" as const,
      ...(routingRevision ? { lastApprovedRoutingRevision: routingRevision } : {}),
    },
  });

  it("is optional: unset means the caller falls back to the worker", () => {
    expect(resolveVerifierProfile([strong], {})).toBeUndefined();
    expect(ROLE_DEFINITIONS.find((role) => role.id === "verifier")?.required).toBe(false);
  });

  it("resolves the bound profile and refuses one that is gone, ineligible or rerouted", () => {
    expect(resolveVerifierProfile([strong], bind("r2"))?.id).toBe("strong");
    expect(() => resolveVerifierProfile([], bind())).toThrow(/no longer served/);
    expect(() =>
      resolveVerifierProfile([{ ...strong, workload_class: "fast-code-completion" }], bind()),
    ).toThrow(/cannot run read-only checks: Autocomplete only/);
    expect(() => resolveVerifierProfile([strong], bind("r1"))).toThrow(/route changed/);
  });
});
