import type { ConnectionProbe, InteractiveModel } from "./types";

export const EXECUTION_ROLES = [
  "snippet",
  "interactive",
  "manager",
  "escalation",
  "verifier",
] as const;

export type ExecutionRole = (typeof EXECUTION_ROLES)[number];

export interface RoleBinding {
  /** Stable Poundlock profile UUID. Names are display/request aliases only. */
  profileId: string;
  profileName: string;
  source: "interactive";
  /** Last operator-approved route. Live catalog revisions are compared against this, not stored as a new binding. */
  lastApprovedRoutingRevision?: string;
  /** @deprecated Prefer lastApprovedRoutingRevision. Kept for saved role maps. */
  routingRevision?: string;
  /** Exact destination approved when this role was saved. */
  approvedDataDestination?: import("./types").DataDestination;
  /** This role's reasoning default for this profile. Absent: Model default (an external manager uses `none` when verified). */
  reasoning?: import("./types").ReasoningChoice;
}

export type RoleMap = Partial<Record<ExecutionRole, RoleBinding>>;

interface RoleDefinition {
  id: ExecutionRole;
  label: string;
  required: boolean;
  hint: string;
}

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    id: "snippet",
    label: "Autocomplete",
    required: false,
    hint: "Fill-in-the-middle model for editor completions. Optional — leave unset unless you have an autocomplete profile.",
  },
  {
    id: "interactive",
    label: "Worker",
    required: true,
    hint: "Implements and tests work in your project folder. The same profile can fill Manager and Worker only when you choose it for each.",
  },
  {
    id: "manager",
    label: "Manager",
    required: true,
    hint: "Plans the project, splits it into tasks and reviews worker results.",
  },
  {
    id: "escalation",
    label: "Escalation",
    required: false,
    hint: "Optional profile for a different capability. Destination and execution consent are separate from this role.",
  },
  {
    id: "verifier",
    label: "Verifier",
    required: false,
    hint: "Reviews new plans and checks each round's accepted work against your requirements, read-only. Called a few times per round, so your strongest model is affordable here. Unset: the Worker does it.",
  },
];

export interface CatalogProfile {
  modelLabel?: string | null;
  id: string;
  name: string;
  aliases: string[];
  workload_class?: string;
  uses?: string[];
  context_tokens?: number;
  source: "interactive";
  profileId?: string;
  upstreamModel?: string;
  endpointKind?: string;
  dataDestination?: import("./types").DataDestination;
  thinking?: import("./types").ProfileThinkingDefault;
  max_output_tokens?: number;
  busy?: boolean;
  occupancy?: import("./types").ModelOccupancy;
  routingRevision?: string;
  capabilities?: import("./types").CapabilityMeasurement[];
  reasoningLevels?: import("./types").ReasoningLevel[];
  servedModel?: string;
  pricing?: import("./types").ModelPricing;
  status?: "enabled" | "disabled";
  disabled?: import("./types").ModelDisabledState;
}

export function roleMapReady(roles: RoleMap | undefined): boolean {
  return Boolean(roles?.manager?.profileId && roles?.interactive?.profileId);
}

export function catalogFromProbe(
  probe: Pick<ConnectionProbe, "interactiveModels">,
): CatalogProfile[] {
  const seen = new Set<string>();
  const catalog: CatalogProfile[] = [];
  const add = (profile: CatalogProfile) => {
    const key = `${profile.source}:${profile.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    catalog.push(profile);
  };
  for (const model of probe.interactiveModels) {
    add(fromInteractive(model));
  }
  return catalog;
}

/**
 * Where a profile's data actually goes. The per-profile override exists to fill
 * in missing server metadata, so it can never downgrade a destination Poundlock
 * reports: `external` from either side wins, and a known server value outranks
 * the override.
 */
export function effectiveDestination(
  reported: string | undefined,
  approved: string | undefined,
): string {
  if (reported === "external" || approved === "external") return "external";
  if (reported && reported !== "unknown") return reported;
  return approved ?? reported ?? "unknown";
}

export function destinationLabel(value: CatalogProfile["dataDestination"]): string {
  return value === "operator_network"
    ? "Your infrastructure"
    : value === "external"
      ? "External provider"
      : "Destination unknown";
}

export function endpointKindLabel(value: CatalogProfile["endpointKind"]): string {
  return value === "litellm"
    ? "Routed through LiteLLM"
    : value === "openai"
      ? "Direct OpenAI-compatible endpoint"
      : "Connection type not reported";
}

/** Describe where project data goes first; the adapter is secondary transport detail. */
export function profileRouteLabel(profile: CatalogProfile): string {
  const destination = destinationLabel(profile.dataDestination);
  return profile.endpointKind === "litellm"
    ? `${destination} · via LiteLLM`
    : profile.endpointKind === "openai"
      ? `${destination} · direct`
      : `${destination} · connection not reported`;
}

export function guessRoleMap(probe: Pick<ConnectionProbe, "interactiveModels">): RoleMap {
  const catalog = catalogFromProbe(probe);
  const used = new Set<string>();
  const pick = (predicate: (profile: CatalogProfile) => boolean): CatalogProfile | undefined => {
    const found = catalog.find((profile) => !used.has(keyOf(profile)) && predicate(profile));
    if (found) used.add(keyOf(found));
    return found;
  };
  const bind = (profile: CatalogProfile | undefined): RoleBinding | undefined =>
    profile ? bindingForProfile(profile) : undefined;

  // Suggestions use published execution capabilities only, never host/model names.
  // The user confirms these bindings against the operator's qualification report.
  const snippet = pick(
    (profile) => profile.source === "interactive" && hasUse(profile, "completion"),
  );
  const manager =
    pick(
      (profile) =>
        profile.source === "interactive" &&
        !interactiveUnavailableReason(profile) &&
        profile.dataDestination !== "external",
    ) ??
    pick((profile) => profile.source === "interactive" && !interactiveUnavailableReason(profile));
  const interactive = pick(
    (profile) =>
      profile.source === "interactive" &&
      !interactiveUnavailableReason(profile) &&
      !hasUse(profile, "completion"),
  );
  const escalation = undefined;

  const roles: RoleMap = {};
  const managerBinding = bind(manager);
  const interactiveBinding = bind(interactive);
  if (snippet) roles.snippet = bind(snippet);
  if (managerBinding) roles.manager = managerBinding;
  if (interactiveBinding) roles.interactive = interactiveBinding;
  if (escalation) roles.escalation = bind(escalation);
  return roles;
}

export function catalogMatchesBinding(
  catalog: CatalogProfile[],
  binding: RoleBinding,
): CatalogProfile | undefined {
  return catalog.find(
    (item) =>
      item.id === binding.profileId ||
      item.name === binding.profileId ||
      item.profileId === binding.profileId ||
      item.aliases.includes(binding.profileId),
  );
}

function fromInteractive(model: InteractiveModel): CatalogProfile {
  return {
    id: model.id,
    name: model.name || model.id,
    aliases: model.aliases ?? [],
    workload_class: model.workload_class,
    uses: model.uses,
    context_tokens: model.context_tokens,
    source: "interactive",
    profileId: model.profileId,
    upstreamModel: model.upstreamModel,
    modelLabel: model.modelLabel,
    endpointKind: model.endpointKind,
    dataDestination: model.dataDestination,
    thinking: model.thinking,
    max_output_tokens: model.max_output_tokens,
    busy: model.busy,
    occupancy: model.occupancy,
    routingRevision: model.routingRevision,
    capabilities: model.capabilities,
    reasoningLevels: model.reasoningLevels,
    servedModel: model.servedModel,
    pricing: model.pricing,
    status: model.status,
    disabled: model.disabled,
  };
}

function matches(profile: CatalogProfile, pattern: RegExp): boolean {
  return [profile.id, profile.name, ...profile.aliases].some((value) => pattern.test(value));
}

function keyOf(profile: CatalogProfile): string {
  return `${profile.source}:${profile.id}`;
}

/**
 * No role binds a job-only profile any more, but Poundlock still reports one,
 * and without its "durable" use it would read as the interactive default.
 */
type ProfileUse = "interactive" | "durable" | "completion";

const USE_BY_CLASS: Record<string, ProfileUse> = {
  "interactive-coding": "interactive",
  "durable-coding-agent": "durable",
  "fast-code-completion": "completion",
};

/** What a profile may be used for. Older Poundlock servers report one workload class only. */
function profileUses(model: { uses?: string[]; workload_class?: string }): Set<ProfileUse> {
  if (model.uses?.length) return new Set(model.uses as ProfileUse[]);
  const use = model.workload_class ? USE_BY_CLASS[model.workload_class] : undefined;
  // Profiles without a reported class have always been treated as interactive.
  return new Set([use ?? "interactive"]);
}

export function hasUse(
  model: { uses?: string[]; workload_class?: string },
  use: ProfileUse,
): boolean {
  return profileUses(model).has(use);
}

/** One eligibility rule for selectors and interactive execution; not a quality rating. */
/**
 * Whether two profiles compete for one exclusive runtime slot — one machine's
 * runtime, where only one model is loaded at a time. Moving work between two
 * such profiles means unloading one model and loading the other.
 *
 * Reads the controller's published `occupancy.slot`. A controller that
 * predates it fills in `node_id`/`runtime_profile` whether or not the slot is
 * exclusive, so for those the pair is the best available answer and may
 * over-report sharing.
 */
export function sameRuntimeSlot(
  a: { occupancy?: import("./types").ModelOccupancy } | undefined,
  b: { occupancy?: import("./types").ModelOccupancy } | undefined,
): boolean {
  const slot = (model: typeof a) => {
    const occupancy = model?.occupancy;
    if (!occupancy) return undefined;
    if (occupancy.slot !== undefined) return occupancy.slot ?? undefined;
    return occupancy.node_id && occupancy.runtime_profile
      ? `${occupancy.node_id}/${occupancy.runtime_profile}`
      : undefined;
  };
  const first = slot(a);
  return first !== undefined && first === slot(b);
}

export function interactiveUnavailableReason(
  model: Pick<InteractiveModel, "workload_class" | "uses" | "context_tokens" | "max_output_tokens">,
): string | undefined {
  if (!hasUse(model, "interactive"))
    return hasUse(model, "completion") ? "Autocomplete only" : "Background jobs only";
  if (!model.context_tokens) return "Context limit not reported";
  if (!model.max_output_tokens) return "Output limit not reported";
  if (model.context_tokens < 4096) return "Needs at least 4K context";
  if (model.max_output_tokens !== undefined && model.max_output_tokens <= 128)
    return "Output limit is too small for agent tools";
  return undefined;
}
export function roleUnavailableReason(
  profile: CatalogProfile,
  role: ExecutionRole,
): string | undefined {
  if (role === "snippet")
    return hasUse(profile, "completion") ? undefined : "Not an autocomplete profile";
  return interactiveUnavailableReason(profile);
}
export function approvedRoutingRevision(binding: RoleBinding | undefined): string | undefined {
  return binding?.lastApprovedRoutingRevision ?? binding?.routingRevision;
}

function profileIdentityMatches(
  profile: {
    id: string;
    name?: string;
    aliases?: string[];
    profileId?: string;
  },
  candidate: string | undefined,
): boolean {
  if (!candidate) return false;
  return [profile.id, profile.name, profile.profileId, ...(profile.aliases ?? [])].includes(
    candidate,
  );
}

function bindingMatchingProfile(
  roles: RoleMap | undefined,
  profile: Parameters<typeof profileIdentityMatches>[0],
): RoleBinding | undefined {
  return Object.values(roles ?? {}).find((binding): binding is RoleBinding =>
    Boolean(binding && profileIdentityMatches(profile, binding.profileId)),
  );
}

/** Last approved route for this profile, never a different saved role. */
export function approvedRoutingRevisionForProfile(
  roles: RoleMap | undefined,
  profile: Parameters<typeof profileIdentityMatches>[0],
): string | undefined {
  return approvedRoutingRevision(bindingMatchingProfile(roles, profile));
}

/**
 * Choosing this profile as the current manager (Settings default or project override)
 * is standing inference consent for a declared destination. Unknown still asks.
 */
export function selectedManagerAuthorizesDestination(
  selectedId: string,
  profile: Parameters<typeof profileIdentityMatches>[0],
  destination: CatalogProfile["dataDestination"] | string | undefined,
): boolean {
  if (!destination || destination === "unknown") return false;
  return profileIdentityMatches(profile, selectedId);
}

/**
 * Saving a default role is a standing choice to use that exact published route.
 * Unknown destinations and changed routes still require a fresh decision.
 */
export function bindingAuthorizesDestination(
  binding: RoleBinding | undefined,
  profile: {
    id: string;
    name?: string;
    aliases?: string[];
    profileId?: string;
    routingRevision?: string;
    dataDestination?: CatalogProfile["dataDestination"];
  },
  destination: CatalogProfile["dataDestination"],
): boolean {
  if (!binding || !destination || destination === "unknown") return false;
  const approved = approvedRoutingRevision(binding);
  const identityMatches = [
    profile.id,
    profile.name,
    profile.profileId,
    ...(profile.aliases ?? []),
  ].includes(binding.profileId);
  return Boolean(
    approved &&
      profile.routingRevision &&
      approved === profile.routingRevision &&
      binding.approvedDataDestination === destination &&
      identityMatches,
  );
}

export function catalogProfileForDestination(profile: {
  id: string;
  name?: string;
  aliases?: string[];
  profileId?: string;
  routingRevision?: string;
  routing_revision?: string;
}): {
  id: string;
  name?: string;
  aliases?: string[];
  profileId?: string;
  routingRevision?: string;
} {
  return {
    id: profile.id,
    name: profile.name,
    aliases: profile.aliases,
    profileId: profile.profileId ?? profile.id,
    routingRevision: profile.routingRevision ?? profile.routing_revision,
  };
}

/**
 * A saved default role is standing authorization for that exact published route.
 * Selecting the same profile as the current manager is also standing for a
 * declared destination. Unknown destinations still require a decision.
 */
export function savedRoleAuthorizesDestination(
  roles: RoleMap | undefined,
  profile: Parameters<typeof bindingAuthorizesDestination>[1],
  destination: CatalogProfile["dataDestination"] | string | undefined,
): boolean {
  if (!roles || !destination || destination === "unknown") return false;
  return Object.values(roles).some((binding) =>
    bindingAuthorizesDestination(
      binding,
      profile,
      destination as CatalogProfile["dataDestination"],
    ),
  );
}

export function bindingForProfile(profile: CatalogProfile, previous?: RoleBinding): RoleBinding {
  const lastApproved = approvedRoutingRevision(previous) ?? profile.routingRevision;
  const approvedDestination =
    profile.dataDestination && profile.dataDestination !== "unknown"
      ? profile.dataDestination
      : undefined;
  return {
    profileId: profile.profileId ?? profile.id,
    profileName: profile.name,
    source: profile.source,
    ...(lastApproved
      ? { lastApprovedRoutingRevision: lastApproved, routingRevision: lastApproved }
      : {}),
    ...(approvedDestination ? { approvedDataDestination: approvedDestination } : {}),
  };
}

export function routeRevisionChanged(
  binding: RoleBinding | undefined,
  live: { routingRevision?: string } | undefined,
): boolean {
  const approved = approvedRoutingRevision(binding);
  return Boolean(approved && live?.routingRevision && approved !== live.routingRevision);
}

/**
 * Reconciles a role map against the live catalog. By default the previous approval (if any)
 * is carried forward unchanged; with `approve: true` (an explicit Models save) the route and
 * destination visible right now are approved instead.
 */
export function canonicalRoleMap(
  roles: RoleMap,
  catalog: CatalogProfile[],
  options?: { approve?: boolean },
): RoleMap {
  return Object.fromEntries(
    Object.entries(roles).map(([role, binding]) => {
      const found = binding && catalogMatchesBinding(catalog, binding);
      return [
        role,
        found
          ? {
              ...bindingForProfile(found, options?.approve ? undefined : binding),
              // A choice made for this profile; approving its route does not reset it.
              ...(binding.reasoning ? { reasoning: binding.reasoning } : {}),
            }
          : binding,
      ];
    }),
  );
}

/** Leads with what model this actually is; the profile name is the machine/route serving it. */
export function profileDisplayName(
  profile: Pick<CatalogProfile, "name" | "modelLabel" | "upstreamModel">,
): string {
  const identity = profile.modelLabel || profile.upstreamModel || undefined;
  return identity ? `${identity} — ${profile.name}` : profile.name;
}

/** A saved role binding Poundlock no longer advertises: prefer the saved name over a raw profile id. */
export function unavailableSelectionLabel(binding: {
  profileId: string;
  profileName?: string;
}): string {
  return binding.profileName && binding.profileName !== binding.profileId
    ? binding.profileName
    : binding.profileId;
}

/** One-line fix shown alongside an unavailable saved selection. */
export const UNAVAILABLE_SELECTION_MESSAGE =
  "This profile was removed in Poundlock. Choose another model.";
export function managerChoice(
  project: Pick<import("./types").ProjectRecord, "policy" | "managerEscalation">,
  roles: RoleMap,
): {
  id: string;
  fallbackName: string;
  origin: "default" | "project" | "escalation";
} {
  const grant = project.managerEscalation?.profile;
  if (grant)
    return {
      id: grant.profileId,
      fallbackName: grant.profileName,
      origin: "escalation",
    };
  if (project.policy.managerModel)
    return {
      id: project.policy.managerModel,
      fallbackName: project.policy.managerModel,
      origin: "project",
    };
  return {
    id: roles.manager?.profileId ?? roles.manager?.profileName ?? "",
    fallbackName: roles.manager?.profileName ?? "Not selected",
    origin: "default",
  };
}

export function requireInteractiveLimits(
  model: Pick<InteractiveModel, "workload_class" | "uses" | "context_tokens" | "max_output_tokens">,
): { contextTokens: number; maxOutputTokens: number } {
  const reason = interactiveUnavailableReason(model);
  if (reason) throw new Error(`This model cannot run interactive agent tools: ${reason}.`);
  return {
    contextTokens: model.context_tokens!,
    maxOutputTokens: model.max_output_tokens!,
  };
}
