import type { RoleBinding, RoleMap } from "./roles";

export interface EscalationSettings {
  profiles: RoleBinding[];
  mode: "ask" | "standing";
  maxTransitionsPerRun: number;
}
export interface EscalationGrant {
  profile: RoleBinding;
  policyKey: string;
  planRevision: number;
  destination: string;
  routingRevision?: string;
  reason: string;
}
export interface EscalationDecision extends EscalationGrant {
  target: "manager" | "worker";
  taskId?: string;
  createdAt: string;
}
export function escalationSettings(
  value?: EscalationSettings,
  roles?: RoleMap,
): EscalationSettings {
  return (
    value ?? {
      profiles: roles?.escalation ? [roles.escalation] : [],
      mode: "ask",
      maxTransitionsPerRun: 3,
    }
  );
}
export function validateEscalationSettings(value: EscalationSettings): EscalationSettings {
  if (
    !value ||
    !Array.isArray(value.profiles) ||
    !["ask", "standing"].includes(value.mode) ||
    !Number.isInteger(value.maxTransitionsPerRun) ||
    value.maxTransitionsPerRun < 1 ||
    value.maxTransitionsPerRun > 20
  )
    throw new Error("Choose a valid escalation policy and a transition limit from 1 to 20.");
  const seen = new Set<string>();
  for (const profile of value.profiles) {
    if (!profile || !profile.profileId || !profile.profileName || profile.source !== "interactive")
      throw new Error("Each escalation entry must be a published execution profile.");
    const key = `${profile.source}:${profile.profileId}`;
    if (seen.has(key))
      throw new Error("Each execution profile can appear only once in the escalation order.");
    seen.add(key);
  }
  return {
    profiles: value.profiles.map(
      ({ profileId, profileName, source, routingRevision, lastApprovedRoutingRevision }) => ({
        profileId,
        profileName,
        source,
        ...(lastApprovedRoutingRevision || routingRevision
          ? {
              lastApprovedRoutingRevision: lastApprovedRoutingRevision ?? routingRevision,
              routingRevision: lastApprovedRoutingRevision ?? routingRevision,
            }
          : {}),
      }),
    ),
    mode: value.mode,
    maxTransitionsPerRun: value.maxTransitionsPerRun,
  };
}

/**
 * The rung a task is on, so escalating moves up from it. That is the rung it
 * was escalated to, or else the profile its last attempt ran on when that
 * profile is one of the ladder's entries: a medium or large task starts on the
 * first rung with enough context, which need not be the first rung. A task on
 * the base worker, or on any profile that is not a rung, is on none, and its
 * first escalation is the first rung.
 */
export function rungOfTask(
  settings: EscalationSettings,
  task: { escalation?: { profile: RoleBinding }; attempts: Array<{ profileId?: string }> },
): RoleBinding | undefined {
  if (task.escalation) return task.escalation.profile;
  const running = task.attempts.at(-1)?.profileId;
  return running ? settings.profiles.find((item) => item.profileId === running) : undefined;
}

export function nextEscalation(settings: EscalationSettings, previous?: RoleBinding): RoleBinding {
  const start = previous
    ? settings.profiles.findIndex((item) => item.profileId === previous.profileId)
    : -1;
  if (previous && start < 0)
    throw new Error(
      "The previous escalation profile was removed. Review the changed escalation settings before continuing.",
    );
  const next = settings.profiles[start + 1];
  if (!next)
    throw new Error(
      "No further escalation profile is configured for this execution path. Ask the user how to proceed.",
    );
  return next;
}
