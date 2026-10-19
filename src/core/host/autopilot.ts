/**
 * Autopilot in the app (ADR 016, Phase 2): build an approved plan unattended
 * in the confined VM, from the project's own folder, and show the run. The run
 * belongs to its detached runner (the installed `dispatch` command), so it
 * survives the app quitting; the app only reads it and asks through its inbox.
 */
import { autopilotView, mergePreview, mergeRun, resumeRun, stopRun } from "@core/auto/control";
import { AutoLedger } from "@core/auto/ledger";
import type { AutoPaths } from "@core/auto/runs";
import { exportRun } from "@core/auto/runs";
import { startAutoRun } from "@core/auto/start";
import { newId } from "@core/ids";
import type { FileStore } from "@core/store";
import type { AutopilotMergePreview, AutopilotStartOptions, AutopilotView } from "@shared/auto-run";
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
  const view = await projectAutopilot(facilities, project);
  // An interrupted run resumes over the board as it left it: interactive
  // work meanwhile would race it. Stop the run to work here.
  return view?.phase === "preparing" || view?.phase === "running" || view?.phase === "interrupted";
}

/** Start a run. The caller has checked the runner (`checkRunner`) before changing anything. */
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
  const started = await startAutoRun(
    {
      dir: source,
      image: options.image.trim(),
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
      : "Autopilot resumed.";
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
  await new AutoLedger(runDir).postInbox("message", text);
  const at = new Date().toISOString();
  await store.appendMessage(project.id, { id: newId("msg"), role: "user", text, createdAt: at });
  await store.appendMessage(project.id, {
    id: newId("msg"),
    role: "system",
    text: "Sent to Autopilot. Its Planner reads it at the next milestone plan or review. To change the plan now, stop Autopilot, then talk to the manager.",
    createdAt: at,
  });
}
