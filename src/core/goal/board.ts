/**
 * The project's board as Autopilot writes it (ADR 016): the run holds the
 * project while it works, so it is the board's one writer. Planned tasks get
 * the same worker brief a manager's plan would, and the Planner's verdicts go
 * on the requirement ledger.
 */

import { newId } from "@core/ids";
import { compilePlanProposal } from "@core/plan-compiler";
import type { FileStore } from "@core/store";
import type { Milestone, TaskRecord } from "@shared/types";
import type { GoalBoard } from "./driver";
import type { PlannedTask, RequirementVerdict } from "./planner-prompts";

export function storeBoard(
  store: FileStore,
  projectId: string,
  now: () => Date = () => new Date(),
): GoalBoard {
  return {
    plan: () => store.getPlan(projectId),
    tasks: () => store.getTasks(projectId),

    async addTasks(
      given: PlannedTask[],
      milestone: Milestone,
      options: { frozenChanges?: boolean } = {},
    ): Promise<TaskRecord[]> {
      // Titles name dependencies: the checks trimmed them, so the board does too.
      const planned = given.map((task) => ({
        ...task,
        title: task.title.trim(),
        dependsOn: task.dependsOn?.map((title) => title.trim()),
      }));
      const project = await store.getProject(projectId);
      const plan = await store.getPlan(projectId);
      if (!project || !plan) throw new Error("The project or its plan is gone.");
      const existing = await store.getTasks(projectId);
      // Titles name tasks on the board; a planned one that repeats an old title gets its milestone.
      const taken = new Set(existing.map((task) => task.title));
      const renamed = new Map(
        planned.map((task) => [
          task.title,
          taken.has(task.title) ? `${task.title} (${milestone.id})` : task.title,
        ]),
      );
      const compiled = compilePlanProposal(
        {
          summary: plan.summary,
          acceptanceCriteria: plan.acceptanceCriteria,
          requirements: plan.requirements,
          milestones: plan.milestones,
          architecture: plan.architecture,
          scopeOut: plan.scopeOut,
          tasks: planned.map((task) => ({
            title: renamed.get(task.title) ?? task.title,
            objective: task.objective,
            workerPrompt: task.objective,
            acceptanceCriteria: task.acceptanceCriteria,
            difficulty: "medium",
            taskKind: "closed_implementation",
            route: "interactive",
            requirementIds: task.requirementIds,
            milestoneId: milestone.id,
            ...(task.filesToTouch?.length ? { filesToTouch: task.filesToTouch } : {}),
            ...(task.writesTests ? { writesTests: true } : {}),
            dependsOn: (task.dependsOn ?? []).map((title) => renamed.get(title) ?? title),
          })),
        },
        project,
        await store.getPermissions(),
      );
      const records: TaskRecord[] = compiled.tasks.map(({ requestedDependencies: _, ...task }) => ({
        ...task,
        route: "interactive",
        id: newId("task"),
        dependsOn: [],
        status: "ready",
        repairCount: 0,
        attempts: [],
      }));
      // Frozen tests a task may change, only where the Planner's verdicts count.
      if (options.frozenChanges) {
        const byTitle = new Map(
          planned.map((task) => [renamed.get(task.title) ?? task.title, task]),
        );
        for (const record of records) {
          const plannedTask = byTitle.get(record.title);
          if (!plannedTask?.changesFrozenTests?.length) continue;
          record.frozenTestsToChange = [...plannedTask.changesFrozenTests];
          if (plannedTask.frozenChangeReason)
            record.frozenChangeReason = plannedTask.frozenChangeReason.trim();
        }
      }
      const ids = new Map(records.map((task) => [task.title, task.id]));
      compiled.tasks.forEach((task, index) => {
        records[index].dependsOn = (task.requestedDependencies ?? []).flatMap((title) => {
          const id = ids.get(title);
          return id ? [id] : [];
        });
        if (records[index].dependsOn.length) records[index].status = "blocked";
      });
      await store.saveTasks(projectId, [...existing, ...records]);
      return records;
    },

    async recordVerdicts(verdicts: RequirementVerdict[], advisory: boolean): Promise<void> {
      if (!verdicts.length) return;
      const plan = await store.getPlan(projectId);
      if (!plan?.requirements?.length) return;
      const at = now().toISOString();
      const byId = new Map(verdicts.map((item) => [item.requirementId.trim().toUpperCase(), item]));
      plan.requirements = plan.requirements.map((requirement) => {
        const verdict = byId.get(requirement.id.trim().toUpperCase());
        return verdict
          ? {
              ...requirement,
              verdict: {
                result: verdict.result,
                note: verdict.note,
                at,
                ...(advisory ? { advisory: true } : {}),
              },
            }
          : requirement;
      });
      await store.savePlan(projectId, plan);
    },
  };
}
