/**
 * Which model plans an Autopilot goal, and how far its judgement goes (ADR 016).
 * A bound Verifier is the Planner, and its verdicts gate the goal: the owner
 * chose a planning-grade model ("frontier plans, local codes"). Without one
 * the worker plans for itself and only advises (the Local tier), until a
 * local model is measured qualified to plan.
 */
import type { InteractiveModel } from "./types";

export interface AutopilotPlannerChoice {
  model: InteractiveModel;
  /** Its verdicts are recorded but do not gate a milestone. */
  advisory: boolean;
  /** It sends excerpts of the project's code beyond the operator's network. */
  external: boolean;
}

export function autopilotPlannerFor(
  verifier: InteractiveModel | undefined,
  worker: InteractiveModel,
): AutopilotPlannerChoice {
  const model = verifier ?? worker;
  return {
    model,
    advisory: !verifier,
    external: model.dataDestination !== "operator_network",
  };
}
