import { DEFAULT_AUTO_LIMITS } from "./auto-run.js";
import { autopilotPlannerFor } from "./autopilot-tier.js";
import { goalMilestones } from "./milestones.js";
import { projectWorkerRoles } from "./roles.js";
import type { AppStateView } from "./types.js";

/** For a plan with requirements: its milestones, and the Planner the run would use. */
export interface GoalPreview {
  milestones: number;
  planner?: { name: string; advisory: boolean; external: boolean; destination: string };
}

/** What "Build with Autopilot" offers, the same in the app and the terminal. */
export interface AutopilotStartPreview {
  /** The plan, or its pending revision, is approved in the same step. */
  approve: boolean;
  /** Set when the project has no checks yet: the manager's, for the owner to confirm. */
  suggestedChecks?: string[];
  goal?: GoalPreview;
  defaultHours: number;
  /** The last run's image, or empty for the owner to name one. */
  defaultImage: string;
}

export function goalPreview(
  state: AppStateView,
  snapshot: NonNullable<AppStateView["snapshot"]>,
): GoalPreview | undefined {
  const plan = snapshot.pendingBoard?.plan ?? snapshot.plan;
  const milestones = plan ? goalMilestones(plan).length : 0;
  if (!milestones) return undefined;
  const models = state.probe?.interactiveModels ?? [];
  const find = (id?: string) =>
    id ? models.find((model) => model.profileId === id || model.id === id) : undefined;
  // The run's worker, as startAutoRun picks it: the project's own first.
  const worker = find(
    projectWorkerRoles(state.connection.roles, snapshot.project.policy).interactive?.profileId,
  );
  const verifier = find(state.connection.roles.verifier?.profileId);
  if (!worker && !verifier) return { milestones };
  const choice = autopilotPlannerFor(verifier, (verifier ?? worker)!);
  return {
    milestones,
    planner: {
      name: choice.model.id,
      advisory: choice.advisory,
      external: choice.external,
      destination: choice.model.dataDestination ?? "unknown",
    },
  };
}

export function autopilotStartPreview(
  state: AppStateView,
  snapshot: NonNullable<AppStateView["snapshot"]>,
): AutopilotStartPreview {
  const goal = goalPreview(state, snapshot);
  const plan = snapshot.pendingBoard?.plan ?? snapshot.plan;
  return {
    approve: !snapshot.plan?.approved || Boolean(snapshot.pendingBoard),
    ...(snapshot.project.policy.verification.commands.length
      ? {}
      : { suggestedChecks: plan?.suggestedChecks ?? [] }),
    ...(goal ? { goal } : {}),
    defaultHours: goal ? DEFAULT_AUTO_LIMITS.softHours : 6,
    defaultImage: state.autopilot?.image ?? "",
  };
}
