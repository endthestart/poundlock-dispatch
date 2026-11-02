/**
 * Autopilot in the app (ADR 016, Phase 2): build an approved plan unattended
 * in the confined VM, from the project's own folder, and show the run. The run
 * belongs to its detached runner (the installed `dispatch` command), so it
 * survives the app quitting; the app only reads it and asks through its inbox.
 */
import {
  autopilotView,
  cleanupCandidates,
  dropRun,
  mergePreview,
  mergeRun,
  messageRun,
  resumeRun,
  stopRun,
} from "@core/auto/control";
import type { AutoPaths } from "@core/auto/runs";
import { exportRun } from "@core/auto/runs";
import { checkAutoStart, startAutoRun } from "@core/auto/start";
import { newId } from "@core/ids";
import type { FileStore } from "@core/store";
import type {
  AutopilotCleanupItem,
  AutopilotMergePreview,
  AutopilotStartOptions,
  AutopilotView,
} from "@shared/auto-run";
import { autopilotHoldsProject, autopilotTakesMessages } from "@shared/autopilot-card";
import type { ProjectRecord } from "@shared/types";

export interface AutopilotFacilities {
  paths: AutoPaths;
  /** Throws, saying what to do, when the runner command is missing or another version. */
  checkRunner(): Promise<void>;
  /** Start the runner for a created run, detached from the app. */
  spawnRunner(runDir: string): void;
  /** The owner's home folder, which the VM must not mount. */
  home?: string;
  docker?: string;
  dockerEnv?: NodeJS.ProcessEnv;
  /** The Docker context runs use; unset means colima's `dispatch-auto`. */
  dockerContext?: string;
}

/** The folder Autopilot builds from: the project's own, read only through a mirror. */
export function autopilotSource(project: ProjectRecord): string | undefined {
  return project.source.kind === "local_folder" ? project.source.originalPath : undefined;
}

export async function projectAutopilot(
  facilities: AutopilotFacilities,
  project: ProjectRecord,
): Promise<AutopilotView | undefined> {
  const source = autopilotSource(project);
  return source ? autopilotView(facilities.paths, source).catch(() => undefined) : undefined;
}

/** A run of this project is being worked: interactive work would race it. */
export async function autopilotBusy(
  facilities: AutopilotFacilities | undefined,
  project: ProjectRecord,
): Promise<boolean> {
  if (!facilities) return false;
  // Interactive work while a run holds the project would race it. Stop the run to work here.
  return autopilotHoldsProject((await projectAutopilot(facilities, project))?.phase);
}

/** The owner's words go to the run, not the manager (`autopilotTakesMessages`). */
export async function autopilotTakesMessage(
  facilities: AutopilotFacilities | undefined,
  project: ProjectRecord,
): Promise<boolean> {
  return (
    Boolean(facilities) && autopilotTakesMessages(await projectAutopilot(facilities!, project))
  );
}

/** Start a run. The caller has checked the runner (`checkRunner`) before changing anything. */
/** What a start would refuse without a plan, said before the plan is approved. */
export async function checkAutopilotStart(
  facilities: AutopilotFacilities,
  store: FileStore,
  project: ProjectRecord,
): Promise<void> {
  const source = autopilotSource(project);
  if (!source)
    throw new Error(
      "Autopilot builds from a folder on this Mac. Open the project from its folder.",
    );
  await checkAutoStart(source, {
    paths: facilities.paths,
    connection: () => store.getConnection(),
    project: async () => ({ project, store }),
  });
}

export async function startAutopilot(
  facilities: AutopilotFacilities,
  store: FileStore,
  project: ProjectRecord,
  options: AutopilotStartOptions,
): Promise<{ runId: string; warnings: string[] }> {
  const source = autopilotSource(project);
  if (!source)
    throw new Error(
      "Autopilot builds from a folder on this Mac. Open the project from its folder.",
    );
  if (!options.image?.trim())
    throw new Error("Choose the toolchain image Autopilot runs checks in.");
  const checks = (options.checks ?? []).map((item) => item.trim()).filter(Boolean);
  const started = await startAutoRun(
    {
      dir: source,
      image: options.image.trim(),
      ...(checks.length ? { checks } : {}),
      allowDependencyDownloads: options.allowDependencyDownloads ?? false,
      ...(options.acceptAlreadyMet ? { acceptAlreadyMet: true } : {}),
      ...(options.prepare?.length ? { prepare: options.prepare } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      goal: {
        checkpoint: options.checkpoint ?? "notify",
        ...(options.allowPlannerDestination
          ? { allowPlannerDestination: options.allowPlannerDestination }
          : {}),
        ...(options.plannerSpendCapUsd !== undefined
          ? { plannerSpendCapUsd: options.plannerSpendCapUsd }
          : {}),
      },
      limits: { ...(options.hours ? { hours: options.hours } : {}) },
      ...(facilities.dockerContext ? { dockerContext: facilities.dockerContext } : {}),
    },
    {
      paths: facilities.paths,
      connection: () => store.getConnection(),
      project: async () => ({ project, store }),
      spawnRunner: facilities.spawnRunner,
      docker: facilities.docker,
      dockerEnv: facilities.dockerEnv,
      home: facilities.home,
    },
  );
  // Confirmed by the owner at start: from now on they are the project's checks.
  // Read again: the start took seconds, and a manager turn may have saved the project meanwhile.
  const latest = checks.length ? await store.getProject(project.id) : undefined;
  if (latest) {
    latest.policy.verification.commands = checks;
    await store.saveProject(latest);
  }
  return { runId: started.run.runId, warnings: started.warnings };
}

async function newestRunDir(facilities: AutopilotFacilities, project: ProjectRecord) {
  const view = await projectAutopilot(facilities, project);
  if (!view) throw new Error("This project has no Autopilot run.");
  return view.runDir;
}

export async function stopAutopilot(
  facilities: AutopilotFacilities,
  project: ProjectRecord,
  mode: "after_case" | "now",
): Promise<string> {
  const result = await stopRun(facilities.paths, await newestRunDir(facilities, project), mode, {
    docker: facilities.docker,
    env: facilities.dockerEnv,
  });
  return result === "already_ended"
    ? "The Autopilot run has already ended."
    : result === "asked"
      ? mode === "now"
        ? "Autopilot is stopping now; the attempt's work is saved."
        : "Autopilot will stop after the current task."
      : "Autopilot's runner was not running. The run is stopped, its work saved; it can be resumed.";
}

export async function resumeAutopilot(
  facilities: AutopilotFacilities,
  project: ProjectRecord,
): Promise<string> {
  await facilities.checkRunner();
  const result = await resumeRun(
    facilities.paths,
    await newestRunDir(facilities, project),
    facilities.spawnRunner,
  );
  return result === "running"
    ? "Autopilot is already running."
    : result === "finished"
      ? "Every task of this run is verified; there is nothing to resume."
      : result === "dropped"
        ? "This run was dropped, so it cannot be resumed. Its verified work can still be merged or exported."
        : "Autopilot resumed.";
}

/** Drop the project's newest run: its worktree goes for good, its verified work stays. */
export async function dropAutopilot(
  facilities: AutopilotFacilities,
  project: ProjectRecord,
): Promise<void> {
  await dropRun(facilities.paths, await newestRunDir(facilities, project), {
    docker: facilities.docker,
    env: facilities.dockerEnv,
  });
}

/** Ended runs, across every project, whose worktrees a cleanup can remove. */
export function autopilotCleanupList(
  facilities: AutopilotFacilities,
): Promise<AutopilotCleanupItem[]> {
  return cleanupCandidates(facilities.paths);
}

/** Drop the runs the owner picked from the cleanup list; returns how many went. */
export async function cleanupAutopilot(
  facilities: AutopilotFacilities,
  runIds: string[],
): Promise<number> {
  const listed = new Set((await cleanupCandidates(facilities.paths)).map((item) => item.runId));
  const picked = runIds.filter((runId) => listed.has(runId));
  for (const runId of picked)
    await dropRun(facilities.paths, facilities.paths.runDir(runId), {
      docker: facilities.docker,
      env: facilities.dockerEnv,
    });
  return picked.length;
}

/** The run's verified work as a patch that applies to its base commit. */
export async function exportAutopilot(
  facilities: AutopilotFacilities,
  project: ProjectRecord,
  out: string,
): Promise<{ file: string; files: number; runsHere: string[]; warnings: string[] }> {
  const exported = await exportRun(await newestRunDir(facilities, project), out);
  return {
    file: exported.file,
    files: exported.files.length,
    runsHere: exported.runsHere,
    warnings: exported.warnings,
  };
}

export async function previewAutopilotMerge(
  facilities: AutopilotFacilities,
  project: ProjectRecord,
): Promise<AutopilotMergePreview> {
  return mergePreview(await newestRunDir(facilities, project));
}

/**
 * Fast-forward the folder to the run's verified work, then mark the board's
 * tasks the run verified as done: their work is now in the folder.
 */
export async function mergeAutopilot(
  facilities: AutopilotFacilities,
  store: FileStore,
  project: ProjectRecord,
): Promise<AutopilotMergePreview> {
  const view = await projectAutopilot(facilities, project);
  if (!view) throw new Error("This project has no Autopilot run.");
  const merged = await mergeRun(view.runDir);
  if (view.board) {
    const verified = new Set(merged.caseIds);
    const tasks = await store.getTasks(project.id);
    for (const task of tasks)
      if (verified.has(task.id) && task.status !== "applied" && task.status !== "cancelled")
        task.status = "applied";
    await store.saveTasks(project.id, tasks);
  }
  return merged;
}

/**
 * A message the owner sends while Autopilot builds: it goes to the run's
 * inbox, and the Planner reads it at its next milestone plan or review. It
 * never starts a manager turn, which would change the board under the run.
 */
export async function messageAutopilot(
  facilities: AutopilotFacilities,
  store: FileStore,
  project: ProjectRecord,
  text: string,
): Promise<void> {
  const runDir = await newestRunDir(facilities, project);
  const result = await messageRun(runDir, text);
  if (result === "already_ended")
    throw new Error("The Autopilot run has just ended. Send your message again for the manager.");
  const at = new Date().toISOString();
  await store.appendMessage(project.id, { id: newId("msg"), role: "user", text, createdAt: at });
  await store.appendMessage(project.id, {
    id: newId("msg"),
    role: "system",
    text:
      result === "sent"
        ? "Sent to Autopilot. The worker on the current task hears it now, and later tasks and the Planner's next milestone plan or review read it. To change the plan now, stop Autopilot, then talk to the manager."
        : "Saved for Autopilot. Its runner is not running; the run reads it when you resume. To change the plan now, stop Autopilot, then talk to the manager.",
    createdAt: at,
  });
}
