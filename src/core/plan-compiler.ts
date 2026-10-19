import type { PermissionSettings } from "@shared/permissions";
import { effectiveToolTrust } from "@shared/permissions";
import type {
  Milestone,
  PlanRecord,
  ProjectRecord,
  Requirement,
  TaskKind,
  TaskRecord,
} from "@shared/types";
import type { EnvironmentNeed } from "./environment.js";
import { compileTaskHints } from "./task-hints.js";

/**
 * Bumped for `filesToTouch` and `reuse` (D2): optional fields, so a proposal
 * that omits them compiles exactly as it did under version 4 (which was
 * bumped for `taskKind` the same way).
 */
export const PLAN_COMPILER_VERSION = 5;

export interface PlanProposalTask {
  title: string;
  objective: string;
  workerPrompt: string;
  acceptanceCriteria: string;
  dependsOn?: string[];
  difficulty: "small" | "medium" | "large";
  /** Absent reproduces today's routing exactly — see `TaskKind` in `@shared/types`. */
  taskKind?: TaskKind;
  route?: "interactive" | "snippet";
  contextNote?: string;
  /** Project-relative paths or globs this task should change. Only what the manager knows. */
  filesToTouch?: string[];
  writesTests?: boolean;
  changesFrozenTests?: boolean;
  /** Existing code to use, each entry naming it and its path. Only what the manager knows. */
  reuse?: string[];
  /** Ledger requirements this task serves. */
  requirementIds?: string[];
  milestoneId?: string;
}

export interface PlanProposal {
  summary: string;
  acceptanceCriteria: string[];
  tasks: PlanProposalTask[];
  environmentNeed?: EnvironmentNeed;
  allowDependencyDownloads?: boolean;
  /** The merged requirement ledger, for the briefs of the tasks that cite it. */
  requirements?: Requirement[];
  milestones?: Milestone[];
  architecture?: string;
  scopeOut?: string[];
}

interface CompiledPlan {
  plan: Omit<PlanRecord, "revision" | "approved" | "createdAt">;
  tasks: Array<
    Omit<TaskRecord, "id" | "dependsOn" | "status" | "repairCount" | "attempts"> & {
      requestedDependencies: string[] | undefined;
    }
  >;
}

/**
 * Convert manager-owned planning decisions into the operational contract that
 * Dispatch enforces. The manager never grants paths, commands, or working
 * directories through its tool arguments. Requested environment capability and
 * download authority are recorded so Approve for me can show them before start.
 */
export function compilePlanProposal(
  proposal: PlanProposal,
  project: ProjectRecord,
  permissions: PermissionSettings,
): CompiledPlan {
  const trust = effectiveToolTrust(project.policy.toolTrust, permissions);
  const checks = [...project.policy.verification.commands];
  const environmentNeed: EnvironmentNeed =
    proposal.environmentNeed === "python" ? "python" : "none";
  const allowDependencyDownloads = Boolean(proposal.allowDependencyDownloads);
  const scope = "Included files in the attached project folder";
  const authority = [
    scope,
    checks.length
      ? `${checks.length} saved project verification command${checks.length === 1 ? "" : "s"}`
      : "Project-native verification will be discovered after setup",
    environmentNeed === "python"
      ? "Dispatch will prepare a Python project environment before the first local task: an existing compatible .venv is reused; otherwise .venv is created with uv, or with the installed Python's venv module when uv is not installed and the project does not require it. Declared Python versions and uv.lock are honored, and no Python runtime is downloaded"
      : "No named project environment capability was requested",
    allowDependencyDownloads
      ? "This plan installs project dependencies, through package registries only, while the project's Internet switch is on"
      : "This plan does not need package downloads",
    trust === "ask"
      ? "Ask mode still requires your approval before shell commands, downloads, and lifecycle scripts. Ordinary in-project file edits do not"
      : "Routine project-local development follows the project's saved permissions and this plan's authority",
    "Ignored, secret, protected, external, and system-level actions remain separately controlled",
  ].join(". ");

  const hints = proposal.tasks.map(compileTaskHints);
  // The owner's requirements a task serves, with the scenarios that show them,
  // so the worker builds what a user does rather than what a criterion names.
  const served = (ids: string[] | undefined) => {
    const wanted = new Set((ids ?? []).map((id) => id.trim().toUpperCase()));
    const items = (proposal.requirements ?? []).filter((item) =>
      wanted.has(item.id.trim().toUpperCase()),
    );
    return items.length
      ? [
          `Owner requirements this task serves:\n${items
            .map(
              (item) =>
                `- ${item.id}: ${item.text}${item.scenarios.length ? `\n  Shown by: ${item.scenarios.join("; ")}` : ""}`,
            )
            .join("\n")}`,
        ]
      : [];
  };
  const others = (title: string) =>
    proposal.tasks.map((item) => item.title).filter((item) => item !== title);
  return {
    plan: {
      compilerVersion: PLAN_COMPILER_VERSION,
      verificationCommands: checks,
      allowDependencyDownloads,
      environmentNeed,
      summary: proposal.summary,
      acceptanceCriteria: proposal.acceptanceCriteria,
      authority,
      ...(proposal.milestones?.length ? { milestones: proposal.milestones } : {}),
      ...(proposal.architecture?.trim() ? { architecture: proposal.architecture.trim() } : {}),
      ...(proposal.scopeOut?.length ? { scopeOut: proposal.scopeOut } : {}),
    },
    tasks: proposal.tasks.map((task, index) => ({
      title: task.title,
      objective: task.objective,
      workerPrompt: [
        `Project context (for orientation only; other tasks own the rest):\n${proposal.summary}`,
        `Project acceptance criteria (met by all tasks together, not by this one):\n- ${proposal.acceptanceCriteria.join("\n- ")}`,
        ...(proposal.architecture?.trim()
          ? [`Architecture (follow it):\n${proposal.architecture.trim()}`]
          : []),
        ...served(task.requirementIds),
        `This task — do only this. Do not create or change files that other tasks own:\n${task.workerPrompt}`,
        ...(others(task.title).length
          ? [`Other tasks (not yours):\n- ${others(task.title).join("\n- ")}`]
          : []),
      ].join("\n\n"),
      acceptanceCriteria: task.acceptanceCriteria,
      difficulty: task.difficulty,
      taskKind: task.taskKind,
      route: task.route,
      contextNote: task.contextNote ?? "",
      ...(task.writesTests ? { writesTests: true } : {}),
      ...(task.changesFrozenTests ? { changesFrozenTests: true } : {}),
      ...(task.requirementIds?.length ? { requirementIds: task.requirementIds } : {}),
      ...(task.milestoneId ? { milestoneId: task.milestoneId.trim().toUpperCase() } : {}),
      ...hints[index],
      scope: "project",
      requestedDependencies: task.dependsOn,
    })),
  };
}
