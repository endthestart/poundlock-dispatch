import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseInteractiveModels } from "@core/poundlock";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import {
  approvedRoutingRevision,
  approvedRoutingRevisionForProfile,
  bindingAuthorizesDestination,
  bindingForProfile,
  canonicalRoleMap,
  catalogFromProbe,
  catalogMatchesBinding,
  effectiveDestination,
  interactiveUnavailableReason,
  managerChoice,
  profileDisplayName,
  profileRouteLabel,
  roleUnavailableReason,
  savedRoleAuthorizesDestination,
  selectedManagerAuthorizesDestination,
  unavailableSelectionLabel,
} from "@shared/roles";
import { defaultPolicy } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const catalog = catalogFromProbe({
  interactiveModels: parseInteractiveModels([
    {
      id: "new-profile",
      poundlock: {
        profile_id: "stable-id",
        canonical_name: "new-profile",
        aliases: ["old-profile", "coding"],
        model_label: "Example model",
        data_destination: "operator_network",
        workload_class: "interactive-coding",
        context_tokens: 4096,
        max_output_tokens: 1024,
        routing_revision: "route-1",
      },
    },
  ]),
});

it("describes model location before gateway transport", () => {
  expect(profileRouteLabel({ ...catalog[0], endpointKind: "litellm" })).toBe(
    "Your infrastructure · via LiteLLM",
  );
  expect(
    profileRouteLabel({ ...catalog[0], endpointKind: "litellm", dataDestination: "external" }),
  ).toBe("External provider · via LiteLLM");
});

it("treats an unchanged saved default route as standing destination approval", () => {
  const binding = bindingForProfile(catalog[0]);
  expect(bindingAuthorizesDestination(binding, catalog[0], "operator_network")).toBe(true);
  expect(savedRoleAuthorizesDestination({ manager: binding }, catalog[0], "operator_network")).toBe(
    true,
  );
  expect(
    bindingAuthorizesDestination(
      binding,
      { ...catalog[0], routingRevision: "route-2" },
      "external",
    ),
  ).toBe(false);
  expect(bindingAuthorizesDestination(binding, catalog[0], "unknown")).toBe(false);
  expect(
    bindingAuthorizesDestination(
      { ...binding, approvedDataDestination: "operator_network" },
      { ...catalog[0], dataDestination: "external" },
      "external",
    ),
  ).toBe(false);
});

it("treats a saved external default as standing authorization for that exact route", () => {
  const external = {
    ...catalog[0],
    dataDestination: "external" as const,
  };
  const binding = bindingForProfile(external);
  expect(savedRoleAuthorizesDestination({ manager: binding }, external, "external")).toBe(true);
  expect(
    savedRoleAuthorizesDestination(
      { manager: binding },
      { ...external, routingRevision: "route-2" },
      "external",
    ),
  ).toBe(false);
  expect(savedRoleAuthorizesDestination({ manager: binding }, external, "unknown")).toBe(false);
});

it("treats the currently selected manager as standing consent for a declared destination", () => {
  const external = {
    ...catalog[0],
    dataDestination: "external" as const,
  };
  expect(selectedManagerAuthorizesDestination("stable-id", external, "external")).toBe(true);
  expect(selectedManagerAuthorizesDestination("new-profile", external, "external")).toBe(true);
  expect(selectedManagerAuthorizesDestination("old-profile", external, "external")).toBe(true);
  expect(selectedManagerAuthorizesDestination("other-profile", external, "external")).toBe(false);
  expect(selectedManagerAuthorizesDestination("stable-id", external, "unknown")).toBe(false);
});

it("compares lastApproved only against a binding for the selected profile", () => {
  const frontier = {
    ...catalog[0],
    id: "frontier-gpt-sol",
    name: "frontier-gpt-sol",
    profileId: "frontier-id",
    aliases: ["frontier-gpt-sol"],
    routingRevision: "frontier-r1",
    dataDestination: "external" as const,
  };
  const roles = { manager: bindingForProfile(catalog[0]) };
  expect(approvedRoutingRevisionForProfile(roles, catalog[0])).toBe("route-1");
  expect(approvedRoutingRevisionForProfile(roles, frontier)).toBeUndefined();
  expect(approvedRoutingRevision(roles.manager)).not.toBe(frontier.routingRevision);
});

it("updates route approval only through an explicit role-map save", () => {
  const changed = {
    ...catalog[0],
    routingRevision: "route-2",
    dataDestination: "external" as const,
  };
  const old = { manager: bindingForProfile(catalog[0]) };
  expect(canonicalRoleMap(old, [changed]).manager?.lastApprovedRoutingRevision).toBe("route-1");
  expect(canonicalRoleMap(old, [changed], { approve: true }).manager).toMatchObject({
    lastApprovedRoutingRevision: "route-2",
    approvedDataDestination: "external",
  });
});

it("resolves legacy aliases against a canonical-only listing and saves UUIDs without changing choices", () => {
  const roles = {
    manager: { profileId: "coding", profileName: "coding", source: "interactive" as const },
  };
  const migrated = canonicalRoleMap(roles, catalog);
  expect(migrated.manager).toEqual({
    profileId: "stable-id",
    profileName: "new-profile",
    source: "interactive",
    routingRevision: "route-1",
    lastApprovedRoutingRevision: "route-1",
    approvedDataDestination: "operator_network",
  });
  expect(catalogMatchesBinding(catalog, migrated.manager!)).toBe(catalog[0]);
  expect(roles.manager.profileId).toBe("coding");
  expect(canonicalRoleMap(roles, [])).toEqual(roles);
  expect(profileDisplayName(catalog[0])).toBe("Example model — new-profile");
});

it("leads with model identity, falling back to the upstream model id, then to the profile name", () => {
  expect(profileDisplayName({ name: "vega-general", modelLabel: "Qwen 3.6 35B-A3B" })).toBe(
    "Qwen 3.6 35B-A3B — vega-general",
  );
  expect(
    profileDisplayName({ name: "vega-general", modelLabel: undefined, upstreamModel: "qwen3.6" }),
  ).toBe("qwen3.6 — vega-general");
  expect(profileDisplayName({ name: "vega-general" })).toBe("vega-general");
});

it("shows the saved profile name, not a raw id, for a role Poundlock no longer advertises", () => {
  expect(
    unavailableSelectionLabel({ profileId: "8e6e1e2e-...-uuid", profileName: "vega-general" }),
  ).toBe("vega-general");
  expect(unavailableSelectionLabel({ profileId: "8e6e1e2e-...-uuid" })).toBe("8e6e1e2e-...-uuid");
});

it("uses the same 4K eligibility boundary for model pickers and agent execution", () => {
  const interactive = catalog[0];
  expect(roleUnavailableReason(interactive, "manager")).toBeUndefined();
  expect(roleUnavailableReason(interactive, "interactive")).toBeUndefined();
  expect(interactiveUnavailableReason(interactive)).toBeUndefined();
  for (const workload_class of ["fast-code-completion", "durable-coding-agent"]) {
    const candidate = { ...interactive, workload_class };
    expect(roleUnavailableReason(candidate, "manager")).toBe(
      interactiveUnavailableReason(candidate),
    );
    expect(interactiveUnavailableReason(candidate)).toBeTruthy();
  }
  expect(interactiveUnavailableReason({ ...interactive, context_tokens: 2048 })).toContain("4K");
  expect(interactiveUnavailableReason({})).toContain("not reported");
});

it("new projects follow changing defaults while an explicit saved override stays explicit", async () => {
  const root = await realpath(await tempDir("dispatch-defaults-"));
  const store = new FileStore(join(root, "data"));
  await store.init();
  const initial = {
    manager: bindingForProfile(catalog[0]),
    interactive: bindingForProfile(catalog[0]),
  };
  await store.saveConnection({ url: "http://fixture", token: "synthetic", roles: initial });
  const project = await createFolderProject({ store, folder: root });
  expect(project.policy.managerModel).toBe("");
  expect(managerChoice(project, initial)).toMatchObject({ id: "stable-id", origin: "default" });
  const next = {
    manager: { profileId: "second-id", profileName: "second", source: "interactive" as const },
  };
  expect(managerChoice(project, next)).toMatchObject({ id: "second-id", origin: "default" });
  const existing = { ...project, policy: { ...defaultPolicy(), managerModel: "coding" } };
  expect(managerChoice(existing, next)).toMatchObject({ id: "coding", origin: "project" });
  existing.policy.managerModel = "";
  expect(managerChoice(existing, next)).toMatchObject({ id: "second-id", origin: "default" });
});

describe("effective data destination", () => {
  it("never lets a saved override downgrade what Poundlock reports", () => {
    // A profile moved to an external endpoint must still prompt, even though
    // the user once approved it as their own infrastructure.
    expect(effectiveDestination("external", "operator_network")).toBe("external");
    expect(effectiveDestination("operator_network", "external")).toBe("external");
    // The override only fills in metadata the server does not report.
    expect(effectiveDestination("unknown", "operator_network")).toBe("operator_network");
    expect(effectiveDestination(undefined, "operator_network")).toBe("operator_network");
    expect(effectiveDestination("operator_network", undefined)).toBe("operator_network");
    expect(effectiveDestination(undefined, undefined)).toBe("unknown");
  });
});
