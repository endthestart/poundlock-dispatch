import type { Milestone, Requirement } from "./types.js";

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

/** The milestone a requirement belongs to, if any. */
export function milestoneOf(milestones: Milestone[], requirementId: string): string | undefined {
  const id = requirementId.trim().toUpperCase();
  return milestones.find((item) =>
    item.requirementIds.some((raw) => raw.trim().toUpperCase() === id),
  )?.id;
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
