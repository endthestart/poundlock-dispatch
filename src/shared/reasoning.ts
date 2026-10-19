import {
  type InteractiveModel,
  REASONING_LEVELS,
  type ReasoningChoice,
  type ReasoningLevel,
} from "./types";

/**
 * Which reasoning setting a turn uses, and why. Most specific first:
 * this conversation's choice, then the role's saved default, then — for an
 * external manager only — `none`, then the model's own default (send nothing,
 * so Poundlock's profile default and then the upstream default apply).
 *
 * Nothing is ever substituted. A saved choice the model does not support is an
 * error the user resolves, not a value quietly changed to one that works.
 */
type ReasoningSource = "conversation" | "role" | "external_manager_default" | "model_default";

export class ReasoningUnsupportedError extends Error {
  constructor(
    readonly choice: ReasoningChoice,
    readonly model: string,
    readonly supported: ReasoningLevel[],
    readonly source: ReasoningSource,
  ) {
    const where =
      source === "conversation"
        ? "this conversation"
        : source === "role"
          ? "Settings → Models"
          : "the default";
    super(
      `Reasoning "${choice}" is not available for ${model}. ${
        supported.length
          ? `Poundlock has verified: ${supported.join(", ")}.`
          : "Poundlock has verified no explicit levels for it, so only Model default can be used."
      } Change it in ${where}; nothing was sent.`,
    );
    this.name = "ReasoningUnsupportedError";
  }
}

export function isReasoningChoice(value: unknown): value is ReasoningChoice {
  return value === "model_default" || (REASONING_LEVELS as readonly unknown[]).includes(value);
}

/** The settings a user may pick for this model: always Model default, then verified levels. */
export function offeredReasoning(
  model: Pick<InteractiveModel, "reasoningLevels">,
): ReasoningChoice[] {
  return ["model_default", ...(model.reasoningLevels ?? [])];
}

export function resolveReasoning(input: {
  model: Pick<InteractiveModel, "id" | "reasoningLevels" | "dataDestination">;
  role: "manager" | "interactive";
  roleDefault?: ReasoningChoice;
  conversation?: ReasoningChoice;
}): { choice: ReasoningChoice; source: ReasoningSource } {
  const supported = input.model.reasoningLevels ?? [];
  const pick = (): { choice: ReasoningChoice; source: ReasoningSource } => {
    if (input.conversation) return { choice: input.conversation, source: "conversation" };
    if (input.roleDefault) return { choice: input.roleDefault, source: "role" };
    if (
      input.role === "manager" &&
      input.model.dataDestination === "external" &&
      supported.includes("none")
    )
      return { choice: "none", source: "external_manager_default" };
    return { choice: "model_default", source: "model_default" };
  };
  const resolved = pick();
  if (resolved.choice !== "model_default" && !supported.includes(resolved.choice))
    throw new ReasoningUnsupportedError(
      resolved.choice,
      input.model.id,
      supported,
      resolved.source,
    );
  return resolved;
}

export function reasoningLabel(choice: ReasoningChoice | undefined): string {
  switch (choice ?? "model_default") {
    case "model_default":
      return "Model default";
    case "none":
      return "None";
    case "xhigh":
      return "Extra high";
    default:
      return choice!.charAt(0).toUpperCase() + choice!.slice(1);
  }
}

/**
 * What the composer shows for a conversation: the settings the manager's
 * current profile offers, and the one the next turn will use (or why none can
 * be used). `profile` is absent when the catalog has not been fetched or the
 * manager runs on this computer, where only Model default applies.
 */
export function conversationReasoningView(input: {
  project: Pick<
    import("./types").ProjectRecord,
    "policy" | "managerEscalation" | "reasoningOverride"
  >;
  roles: import("./roles").RoleMap;
  models: InteractiveModel[];
  localManager?: boolean;
}): {
  offered: ReasoningChoice[];
  roleDefault?: ReasoningChoice;
  /** What "Manager default" means here, when it can be used. */
  defaultChoice?: ReasoningChoice;
  defaultSource?: ReasoningSource;
  effective?: ReasoningChoice;
  source?: ReasoningSource;
  error?: string;
  profileName?: string;
} {
  if (input.localManager) return { offered: ["model_default"], effective: "model_default" };
  const escalated = input.project.managerEscalation?.profile.profileId;
  const id = escalated || input.project.policy.managerModel || input.roles.manager?.profileId;
  const profile = input.models.find((model) =>
    [model.id, model.profileId, model.name, ...(model.aliases ?? [])].includes(id),
  );
  if (!profile) return { offered: ["model_default"] };
  const roleDefault =
    !escalated && !input.project.policy.managerModel ? input.roles.manager?.reasoning : undefined;
  let fallback: { choice: ReasoningChoice; source: ReasoningSource } | undefined;
  try {
    fallback = resolveReasoning({ model: profile, role: "manager", roleDefault });
  } catch {
    fallback = undefined;
  }
  try {
    const resolved = resolveReasoning({
      model: profile,
      role: "manager",
      roleDefault,
      conversation: input.project.reasoningOverride,
    });
    return {
      offered: offeredReasoning(profile),
      roleDefault,
      defaultChoice: fallback?.choice,
      defaultSource: fallback?.source,
      effective: resolved.choice,
      source: resolved.source,
      profileName: profile.name ?? profile.id,
    };
  } catch (error) {
    return {
      offered: offeredReasoning(profile),
      roleDefault,
      defaultChoice: fallback?.choice,
      defaultSource: fallback?.source,
      error: error instanceof Error ? error.message : String(error),
      profileName: profile.name ?? profile.id,
    };
  }
}
