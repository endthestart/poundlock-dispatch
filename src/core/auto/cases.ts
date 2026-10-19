import type { AutoCase, AutoRunState } from "@shared/auto-run";
import type { TaskRecord } from "@shared/types";

/** Tasks the interactive run already finished or dropped are not cases again. */
const DONE_TASKS = new Set(["applied", "cancelled"]);

/**
 * Freeze an approved plan's tasks as cases, in plan order, keeping their
 * dependencies. What the manager already knows (its context note, the files
 * to touch and the code to reuse) rides in the objective, as it does for an
 * interactive worker. A dependency on a task that is already done is met.
 */
export function casesFromTasks(
  tasks: TaskRecord[],
  /** Tasks left out: a goal's previous run gave them up, and its Planner replans that work. */
  leaveOut: ReadonlySet<string> = new Set(),
): AutoCase[] {
  const open = tasks.filter((task) => !DONE_TASKS.has(task.status) && !leaveOut.has(task.id));
  const ids = new Set(open.map((task) => task.id));
  return open.map((task) => ({
    id: task.id,
    title: task.title,
    objective: [
      task.workerPrompt || task.objective,
      task.contextNote ? `Context from the manager: ${task.contextNote}` : "",
      task.filesToTouch?.length ? `Files to touch: ${task.filesToTouch.join(", ")}` : "",
      task.reuse?.length ? `Reuse: ${task.reuse.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    acceptanceCriteria: task.acceptanceCriteria,
    dependsOn: task.dependsOn.filter((id) => ids.has(id)),
    ...(task.writesTests ? { writesTests: true } : {}),
    ...(task.changesFrozenTests ? { changesFrozenTests: true } : {}),
    ...(task.frozenTestsToChange?.length
      ? {
          frozenTestsToChange: [...task.frozenTestsToChange],
          ...(task.frozenChangeReason ? { frozenChangeReason: task.frozenChangeReason } : {}),
        }
      : {}),
    ...(task.requirementIds?.length ? { requirementIds: [...task.requirementIds] } : {}),
    ...(task.milestoneId ? { milestoneId: task.milestoneId } : {}),
  }));
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A case's text on one line, for a commit subject or a patch header. */
export function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** A plan's cases, checked: at least one, safe unique ids, dependencies that exist and never loop. */
export function validateCases(cases: AutoCase[]): void {
  if (!cases.length) throw new Error("The plan has no cases to run.");
  const ids = new Set<string>();
  for (const item of cases) {
    if (
      typeof item.title !== "string" ||
      typeof item.objective !== "string" ||
      !item.title.trim() ||
      !item.objective.trim()
    )
      throw new Error("Every case needs an id, a title and an objective.");
    // Ids name folders, draft refs and commit trailers.
    if (typeof item.id !== "string" || !SAFE_ID.test(item.id) || item.id.includes(".."))
      throw new Error(
        `Case id ${JSON.stringify(item.id)} must be letters, digits, '.', '_' or '-' (at most 64).`,
      );
    if (!Array.isArray(item.dependsOn) || item.dependsOn.some((dep) => typeof dep !== "string"))
      throw new Error(`Case ${item.id} needs dependsOn as a list of case ids.`);
    if (ids.has(item.id)) throw new Error(`Two cases share the id ${item.id}.`);
    ids.add(item.id);
  }
  for (const item of cases)
    for (const dep of item.dependsOn)
      if (!ids.has(dep)) throw new Error(`Case ${item.id} depends on ${dep}, which is not a case.`);
  const byId = new Map(cases.map((item) => [item.id, item]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string) => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`The cases' dependencies loop through ${id}.`);
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    done.add(id);
  };
  for (const item of cases) visit(item.id);
}

export type NextCase = { case: AutoCase } | { skip: AutoCase; reason: string } | null;

/** The first pending case whose dependencies are all accepted; dependents of a failed case are skipped. */
export function nextCase(cases: AutoCase[], state: AutoRunState): NextCase {
  const stage = new Map(state.cases.map((c) => [c.id, c.stage]));
  for (const item of cases) {
    const current = stage.get(item.id);
    // A case left running or repairing (a crash, a stop) is resumed before anything else starts.
    if (current === "running" || current === "repairing") return { case: item };
    if (current && current !== "pending") continue;
    const failed = item.dependsOn.find((dep) =>
      ["blocked", "abandoned", "skipped"].includes(stage.get(dep) ?? ""),
    );
    if (failed) return { skip: item, reason: `depends on ${failed}, which did not finish` };
    if (item.dependsOn.every((dep) => stage.get(dep) === "accepted")) return { case: item };
  }
  return null;
}
