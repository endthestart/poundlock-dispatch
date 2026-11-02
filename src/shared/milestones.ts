import type { Milestone, PlanRecord, Requirement } from "./types.js";

/**
 * What is wrong with a plan's milestones (ADR 016), as sentences the manager
 * can act on; empty when they hold together. Each requirement belongs to at
 * most one milestone, and each task names a milestone that exists.
 */
export function milestoneProblems(
  milestones: Milestone[],
  requirements: Requirement[],
  tasks: Array<{ title: string; milestoneId?: string }>,
): string[] {
  const problems: string[] = [];
  const ids = milestones.map((item) => item.id.trim().toUpperCase());
  const malformed = ids.filter((id) => !/^M\d+$/.test(id));
  if (malformed.length) problems.push(`Milestone ids are M1, M2, …; not ${malformed.join(", ")}.`);
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (repeated.length) problems.push(`Two milestones share ${[...new Set(repeated)].join(", ")}.`);
  const empty = milestones.filter((item) => !item.requirementIds.length).map((item) => item.id);
  if (empty.length)
    problems.push(
      `${empty.join(", ")} deliver${empty.length === 1 ? "s" : ""} no requirement; give each milestone the ones it delivers.`,
    );
  const known = new Set(requirements.map((item) => item.id.trim().toUpperCase()));
  const owner = new Map<string, string>();
  for (const milestone of milestones)
    for (const raw of milestone.requirementIds) {
      const id = raw.trim().toUpperCase();
      if (!known.has(id)) problems.push(`${milestone.id} names ${id}, which is not in the ledger.`);
      else if (owner.has(id))
        problems.push(`${id} is in both ${owner.get(id)} and ${milestone.id}; give it one.`);
      else owner.set(id, milestone.id);
    }
  const placed = new Set(ids);
  const orphans = tasks.filter(
    (task) => !task.milestoneId || !placed.has(task.milestoneId.trim().toUpperCase()),
  );
  if (orphans.length)
    problems.push(
      `Each task names its milestone in milestoneId; ${orphans.map((task) => `“${task.title}”`).join(", ")} name none that exists.`,
    );
  return problems;
}

/**
 * The milestones Autopilot works. A plan with requirements and none runs as
 * one holding every requirement not waived, so that its Planner reviews the
 * work: without it no verdict ran, and one run's checks all passed with its
 * alignment inverted. That milestone is worked out each time and never
 * saved, so the plan stays the manager's and later requirements join it.
 */
export function goalMilestones(
  plan: Pick<PlanRecord, "summary" | "requirements" | "milestones">,
): Milestone[] {
  if (plan.milestones?.length) return plan.milestones;
  const open = (plan.requirements ?? []).filter((item) => item.status !== "waived");
  if (!open.length) return [];
  return [
    {
      id: "M1",
      title: "The whole plan",
      goal: plan.summary,
      requirementIds: open.map((item) => item.id),
    },
  ];
}

/** A task belongs to a milestone it names; in a plan without milestones, to the whole plan's. */
export function inGoalMilestone(
  task: { milestoneId?: string },
  milestoneId: string,
  plan: Pick<PlanRecord, "milestones">,
): boolean {
  return plan.milestones?.length ? task.milestoneId === milestoneId : true;
}

/**
 * Tasks under their milestones, in the plan's order; tasks without one come
 * last. A plan with no milestones is one untitled group.
 */
export function milestoneGroups<T extends { milestoneId?: string }>(
  tasks: T[],
  milestones: Milestone[],
): Array<{ id: string; title?: string; tasks: T[] }> {
  if (!milestones.length) return [{ id: "all", tasks }];
  const known = new Set(milestones.map((milestone) => milestone.id));
  const groups = milestones
    .map((milestone) => ({
      id: milestone.id,
      title: `${milestone.id} · ${milestone.title}`,
      tasks: tasks.filter((task) => task.milestoneId === milestone.id),
    }))
    .filter((group) => group.tasks.length);
  const rest = tasks.filter((task) => !task.milestoneId || !known.has(task.milestoneId));
  return rest.length ? [...groups, { id: "other", title: "Other tasks", tasks: rest }] : groups;
}
