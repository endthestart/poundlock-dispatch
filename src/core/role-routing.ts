import { capabilityStatus, TASK_KIND_CAPABILITY } from "@shared/capabilities";
import { type EscalationGrant, escalationSettings } from "@shared/escalation";
import {
  approvedRoutingRevision,
  effectiveDestination,
  interactiveUnavailableReason,
  type RoleBinding,
  type RoleMap,
  routeRevisionChanged,
} from "@shared/roles";
import type {
  ConnectionSettings,
  Difficulty,
  InteractiveModel,
  ProjectRecord,
  TaskKind,
  TaskRecord,
} from "@shared/types";
import { validEscalationGrant } from "./escalation";

export class RoleIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleIsolationError";
  }
}

export class RouteRevisionChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteRevisionChangedError";
  }
}

function matches(
  model: Pick<InteractiveModel, "id" | "profileId" | "aliases" | "name">,
  id: string | undefined,
): boolean {
  if (!id) return false;
  return [model.id, model.profileId, model.name, ...(model.aliases ?? [])].includes(id);
}

/**
 * Context needed to start a task without spending a frontier decision: medium
 * needs at least 64K, large at least 128K. Small always uses the base worker.
 * K is 1024 tokens, matching how context windows are normally reported.
 */
export const DIFFICULTY_CONTEXT_THRESHOLD: Record<Difficulty, number> = {
  small: 0,
  medium: 64 * 1024,
  large: 128 * 1024,
};

function plainBaseWorker(models: InteractiveModel[], base: RoleBinding): InteractiveModel {
  const mapped = models.find((model) => matches(model, base.profileId));
  if (!mapped) {
    throw new RoleIsolationError(
      "The mapped interactive worker is not currently eligible. Choose another worker profile.",
    );
  }
  const unavailable = interactiveUnavailableReason(mapped);
  if (unavailable) {
    throw new RoleIsolationError(
      `The mapped interactive worker is not currently eligible. ${unavailable}.`,
    );
  }
  return mapped;
}

/** The base worker plus the model ladder's own rungs, in ladder order. */
function ladderCandidates(roles: RoleMap, connection: ConnectionSettings): RoleBinding[] {
  const base = roles.interactive;
  if (!base) return [];
  const ladder = escalationSettings(connection.escalation, roles);
  return [base, ...ladder.profiles];
}

type StartingCandidate = { binding: RoleBinding; model: InteractiveModel };
type StartingBinding = StartingCandidate & { reason: string };

function byLargestContext(candidates: StartingCandidate[]): StartingCandidate {
  return [...candidates].sort(
    (a, b) => (b.model.context_tokens ?? 0) - (a.model.context_tokens ?? 0),
  )[0];
}

/**
 * The rung Dispatch starts a task on, before any manager-driven escalation.
 *
 * Order of decisions, none of which ever throws for a resolvable task:
 * 1. `small` short-circuits to the base worker, but only when `taskKind` is
 *    absent or `"closed_implementation"` — an open-ended task is never
 *    "small" just because it looked small by context size. This is the fix
 *    for the motivating failure: an open-ended feasibility question was small
 *    by every size measure and went to the base worker, which confidently
 *    answered wrong.
 * 2. Eligibility (interactive use, not busy, no `interactiveUnavailableReason`,
 *    destination `operator_network` via `effectiveDestination`) is computed
 *    exactly as before. Capability evidence is layered on top of this set and
 *    can never widen it — an ineligible rung is never chosen no matter what
 *    it claims to be capable of.
 * 3. When `taskKind` names a required capability
 *    (`TASK_KIND_CAPABILITY`), a rung with a *measured failure* for it is
 *    dropped from the automatic choice. This is the only mechanical
 *    enforcement; qualified, smoke-tested, and unknown evidence are all
 *    advisory and never exclude a rung.
 * 4. The existing `DIFFICULTY_CONTEXT_THRESHOLD` search runs over
 *    capability-qualified rungs first, then every non-measured-failure rung
 *    (qualified, smoke, or unknown), then falls back to the largest-context
 *    rung among those — exactly today's search, just scoped to rungs that
 *    have not measured-failed.
 * 5. If every eligible rung has a measured failure for the required
 *    capability, filtering would leave nothing to choose from: Dispatch falls
 *    back to today's capability-blind result (never throws) and says so in
 *    the returned reason, so a task is never stranded by evidence that turns
 *    out to cover the whole ladder.
 */
export function resolveStartingWorkerBinding(
  models: InteractiveModel[],
  roles: RoleMap,
  connection: ConnectionSettings,
  difficulty: Difficulty,
  taskKind?: TaskKind,
): StartingBinding {
  const base = roles.interactive;
  if (!base?.profileId) {
    throw new RoleIsolationError("Choose an interactive worker model in Settings → Models.");
  }
  if (difficulty === "small" && (taskKind === undefined || taskKind === "closed_implementation")) {
    return {
      binding: base,
      model: plainBaseWorker(models, base),
      reason: "Small closed-implementation task: always starts on the base worker.",
    };
  }
  const resolveLocal = (binding: RoleBinding) => {
    const model = models.find((item) => matches(item, binding.profileId));
    if (!model || model.busy || interactiveUnavailableReason(model)) return undefined;
    const destination = effectiveDestination(
      model.dataDestination,
      connection.profiles?.[model.profileId ?? model.id]?.approvedDestination,
    );
    return destination === "operator_network" ? { binding, model } : undefined;
  };
  const eligible = ladderCandidates(roles, connection)
    .map(resolveLocal)
    .filter((item): item is StartingCandidate => Boolean(item));
  if (!eligible.length) {
    return {
      binding: base,
      model: plainBaseWorker(models, base),
      reason: "No eligible ladder rung is available; using the mapped base worker.",
    };
  }
  const threshold = DIFFICULTY_CONTEXT_THRESHOLD[difficulty];
  const byThreshold = (candidates: StartingCandidate[]) =>
    candidates.find((item) => (item.model.context_tokens ?? 0) >= threshold);
  const rungName = (item: StartingCandidate) => item.model.name ?? item.model.id;
  const requiredCapability = taskKind ? TASK_KIND_CAPABILITY[taskKind] : undefined;

  if (!requiredCapability) {
    const sufficient = byThreshold(eligible);
    if (sufficient) {
      return {
        ...sufficient,
        reason: `${rungName(sufficient)} is the first ladder rung with at least ${threshold.toLocaleString()} tokens of context for a ${difficulty} task.`,
      };
    }
    const largest = byLargestContext(eligible);
    return {
      ...largest,
      reason: `No eligible rung meets the ${difficulty} context threshold; using the largest-context eligible rung (${rungName(largest)}).`,
    };
  }

  const nonFailing = eligible.filter(
    (item) => capabilityStatus(item.model, requiredCapability) !== "measured_failure",
  );
  if (!nonFailing.length) {
    const sufficient = byThreshold(eligible) ?? byLargestContext(eligible);
    return {
      ...sufficient,
      reason: `Every eligible rung has a measured failure for ${requiredCapability}; falling back to today's capability-blind choice (${rungName(sufficient)}).`,
    };
  }
  const capableOnly = nonFailing.filter((item) =>
    (["qualified", "smoke"] as const).includes(
      capabilityStatus(item.model, requiredCapability) as "qualified" | "smoke",
    ),
  );
  const fromCapable = byThreshold(capableOnly);
  if (fromCapable) {
    return {
      ...fromCapable,
      reason: `${rungName(fromCapable)} has measured ${requiredCapability} and enough context for a ${difficulty} ${taskKind} task.`,
    };
  }
  const fromNonFailing = byThreshold(nonFailing);
  if (fromNonFailing) {
    return {
      ...fromNonFailing,
      reason: `No rung with measured ${requiredCapability} meets the context threshold; using ${rungName(fromNonFailing)} (capability unknown, not a measured failure).`,
    };
  }
  const largest = byLargestContext(nonFailing);
  return {
    ...largest,
    reason: `No eligible rung meets the ${difficulty} context threshold; using the largest-context rung without a measured failure for ${requiredCapability} (${rungName(largest)}).`,
  };
}

/**
 * The roles a project's workers run under: the app's, with the Worker role
 * replaced by the project's own choice when it has one. The ladder's further
 * rungs are unchanged.
 */
export function projectWorkerRoles(
  roles: RoleMap,
  policy: Pick<ProjectRecord["policy"], "workerModel">,
): RoleMap {
  if (!policy.workerModel || policy.workerModel === roles.interactive?.profileId) return roles;
  return {
    ...roles,
    interactive: {
      profileId: policy.workerModel,
      profileName: policy.workerModel,
      source: "interactive",
    },
  };
}

export function resolveInteractiveWorkerProfile(
  models: InteractiveModel[],
  roles: RoleMap,
  project: ProjectRecord,
  task: Pick<
    TaskRecord,
    "escalation" | "difficulty" | "freshWorkerSession" | "attempts" | "taskKind"
  >,
  connection: ConnectionSettings,
): InteractiveModel {
  if (task.escalation) {
    return resolveExplicitEscalation(models, task.escalation, connection, project);
  }
  roles = projectWorkerRoles(roles, project.policy);
  if (!roles.interactive?.profileId) {
    throw new RoleIsolationError("Choose an interactive worker model in Settings → Models.");
  }
  const { binding: starting, model: mapped } = resolveStartingWorkerBinding(
    models,
    roles,
    connection,
    task.difficulty,
    task.taskKind,
  );
  const previous = task.freshWorkerSession ? undefined : task.attempts.at(-1)?.profileId;
  if (previous && previous !== (mapped.profileId ?? mapped.id)) {
    const approvedIds = new Set(project.policy.allowedWorkerProfileIds);
    const alternate = models.find(
      (model) =>
        [model.profileId, model.id].includes(previous) &&
        (approvedIds.has(model.profileId ?? model.id) || approvedIds.has(model.id)) &&
        !matches(model, roles.manager?.profileId),
    );
    if (alternate) {
      const prior = task.attempts.at(-1);
      if (
        prior?.routingRevision &&
        alternate.routingRevision &&
        prior.routingRevision !== alternate.routingRevision
      ) {
        throw new RouteRevisionChangedError(
          "The authorized worker route changed in Poundlock. Review its destination before retrying.",
        );
      }
      return alternate;
    }
  }
  if (routeRevisionChanged(starting, mapped)) {
    throw new RouteRevisionChangedError(
      "The authorized worker route changed in Poundlock. Review its destination before retrying.",
    );
  }
  return mapped;
}

function resolveExplicitEscalation(
  models: InteractiveModel[],
  grant: EscalationGrant,
  connection: ConnectionSettings,
  project: ProjectRecord,
): InteractiveModel {
  if (!validEscalationGrant(grant, connection, project)) {
    throw new RoleIsolationError(
      "The saved escalation authorization no longer matches current settings.",
    );
  }
  const profile = models.find((model) => matches(model, grant.profile.profileId));
  if (!profile) {
    throw new RoleIsolationError("The authorized escalation profile is no longer advertised.");
  }
  if (grant.routingRevision && grant.routingRevision !== profile.routingRevision) {
    throw new RouteRevisionChangedError(
      "The authorized escalation route changed in Poundlock. Review its destination before retrying.",
    );
  }
  return profile;
}

/**
 * The profile for plan reviews and round-end verification: the Verifier role
 * when it is bound and eligible, otherwise none and the caller uses the worker.
 */
export function resolveVerifierProfile(
  models: InteractiveModel[],
  roles: RoleMap,
): InteractiveModel | undefined {
  const binding = roles.verifier;
  if (!binding?.profileId) return undefined;
  const model = models.find((item) => matches(item, binding.profileId));
  if (!model) {
    throw new RoleIsolationError(
      `The Verifier model ${binding.profileName} is no longer served by Poundlock. Choose another in Settings → Models → Verifier, or clear it to use the Worker.`,
    );
  }
  const unavailable = interactiveUnavailableReason(model);
  if (unavailable)
    throw new RoleIsolationError(`The Verifier model cannot run read-only checks: ${unavailable}.`);
  if (routeRevisionChanged(binding, model))
    throw new RouteRevisionChangedError(
      "The Verifier route changed in Poundlock. Review its destination in Settings → Models → Verifier.",
    );
  return model;
}

export function lastApprovedWorkerRevision(
  task: Pick<TaskRecord, "escalation" | "attempts">,
  selected: Pick<InteractiveModel, "id" | "profileId" | "routingRevision">,
  roles: RoleMap,
): string | undefined {
  if (task.escalation) return task.escalation.routingRevision;
  if (roles.interactive && matches(selected, roles.interactive.profileId)) {
    return approvedRoutingRevision(roles.interactive);
  }
  if (roles.verifier && matches(selected, roles.verifier.profileId)) {
    return approvedRoutingRevision(roles.verifier);
  }
  const selectedId = selected.profileId ?? selected.id;
  const prior = [...task.attempts].reverse().find((attempt) => attempt.profileId === selectedId);
  return prior?.routingRevision ?? selected.routingRevision;
}
