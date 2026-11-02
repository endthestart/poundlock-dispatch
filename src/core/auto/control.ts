/**
 * What a front end does to a run (ADR 016), shared by the terminal client and
 * the app: read its view, ask it to stop, start its runner again, drop it. A front end
 * never writes the run's ledger: it asks through the run's inbox, and only a
 * run with no runner is ended here.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AutopilotCleanupItem,
  type AutopilotMergePreview,
  type AutopilotView,
  autoProgressView,
  OUTCOME_LABELS,
} from "@shared/auto-run";
import { gitOutput } from "../git";
import { AutoLedger } from "./ledger";
import {
  type AutoPaths,
  acquireProjectLock,
  endRunWithoutRunner,
  filesThatRunHere,
  mirrorRepo,
  newestRun,
  readRunFile,
  removeRunWorktree,
  runnerAlive,
  runnerPid,
} from "./runs";

/** How long a new runner may take to write its pid before its run reads as interrupted. */
const RUNNER_START_MS = 30_000;

/** Whether a runner works the run, counting one just spawned that has not written its pid. */
async function beingWorked(runDir: string, createdAt: string, now: Date): Promise<boolean> {
  const starting =
    !(await runnerPid(runDir)) && now.getTime() - Date.parse(createdAt) < RUNNER_START_MS;
  return starting || (await runnerAlive(runDir));
}

/**
 * The same liveness the card shows: a runner spawned in the last moments, before
 * its pid is written, works the run. Read as dead, a message sent to a Preparing
 * run was answered "its runner is not running" (UX review, 30 Oct), and a stop or a
 * resume there would end the run under its new runner or start a second one.
 */
async function workedNow(runDir: string, now = new Date()): Promise<boolean> {
  // A run that has ended starts no runner of its own: only a live pid works it.
  if ((await new AutoLedger(runDir).state()).outcome) return runnerAlive(runDir);
  const run = await readRunFile(runDir).catch(() => undefined);
  return run ? beingWorked(runDir, run.createdAt, now) : runnerAlive(runDir);
}

/** The newest run of a project folder, as a front end shows it. */
export async function autopilotView(
  paths: AutoPaths,
  source: string,
  now = new Date(),
): Promise<AutopilotView | undefined> {
  const runDir = await newestRun(paths, source);
  if (!runDir) return undefined;
  const run = await readRunFile(runDir).catch(() => undefined);
  if (!run) return undefined;
  const state = await new AutoLedger(runDir).state();
  const alive = await beingWorked(runDir, run.createdAt, now);
  const status = JSON.parse(
    await readFile(join(runDir, "status.json"), "utf8").catch(() => "{}"),
  ) as { activity?: string };
  const phase: AutopilotView["phase"] = state.outcome
    ? "ended"
    : !alive
      ? "interrupted"
      : state.preflight === undefined
        ? "preparing"
        : "running";
  return {
    runId: run.runId,
    runDir,
    phase,
    ...(state.outcome
      ? {
          outcome: state.outcome,
          outcomeLabel: OUTCOME_LABELS[state.outcome],
          endReason: state.endReason,
        }
      : {}),
    ...(state.stopRequested ? { stopRequested: state.stopRequested } : {}),
    lines: autoProgressView(state, now, {
      activity: status.activity,
      runnerStopped: phase === "interrupted",
    }),
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    ...(state.endedAt ? { endedAt: state.endedAt } : {}),
    ...(state.lastEventAt ? { lastEventAt: state.lastEventAt } : {}),
    softHours: state.runId ? state.limits.softHours : run.limits.softHours,
    ...(state.plannerUsd !== undefined ? { plannerUsd: state.plannerUsd } : {}),
    ...(state.fallbacks?.length ? { fallbacks: state.fallbacks } : {}),
    ...(run.goal?.spendCapUsd !== undefined ? { plannerCapUsd: run.goal.spendCapUsd } : {}),
    ...(status.activity ? { activity: status.activity } : {}),
    ...(state.current
      ? {
          current: {
            title:
              state.cases.find((item) => item.id === state.current?.caseId)?.title ??
              state.current.caseId,
            attempt: state.current.attempt,
          },
        }
      : {}),
    // Until the runner records the run, its cases are the ones it was asked for.
    cases: state.runId
      ? state.cases.map((item) => ({
          id: item.id,
          title: item.title,
          stage: item.stage,
          ...(item.reason ? { reason: item.reason } : {}),
        }))
      : run.cases.map((item) => ({ id: item.id, title: item.title, stage: "pending" as const })),
    branch: run.branch,
    mirror: run.mirror,
    baseCommit: run.baseCommit,
    image: run.image,
    model: run.model,
    ...(run.board ? { board: true } : {}),
    ...(run.goal
      ? {
          goal: {
            planner: run.goal.planner.model,
            advisory: run.goal.advisory,
            checkpoint: run.goal.checkpoint,
          },
        }
      : {}),
    ...(state.milestones?.length ? { milestones: state.milestones } : {}),
    ...(existsSync(join(runDir, "report.md")) ? { report: join(runDir, "report.md") } : {}),
    ...(state.dropped ? { dropped: true } : {}),
    workingCopy: existsSync(run.worktree),
  };
}

export type StopResult = "already_ended" | "asked" | "stopped";

/**
 * Stop a run: after the current case, or now (the attempt is saved). A run
 * whose runner is gone is ended here, its work kept, and can be resumed.
 */
export async function stopRun(
  paths: AutoPaths,
  runDir: string,
  mode: "after_case" | "now",
  isolation: { docker?: string; env?: NodeJS.ProcessEnv } = {},
  now = new Date(),
): Promise<StopResult> {
  const ledger = new AutoLedger(runDir);
  if ((await ledger.state()).outcome) return "already_ended";
  if (await workedNow(runDir, now)) {
    await ledger.postInbox(mode === "now" ? "stop_now" : "pause");
    return "asked";
  }
  await endRunWithoutRunner(
    runDir,
    paths,
    { outcome: "cancelled_after_checkpoint", reason: "stopped while the runner was not running" },
    isolation,
  );
  return "stopped";
}

export type MessageResult = "already_ended" | "sent" | "waiting";

/**
 * Tell a run something (ADR 016): the worker on the current case hears it
 * before its next model call, and every later case and the Planner's next
 * milestone plan or review read it. A stopped run takes it when resumed.
 */
export async function messageRun(
  runDir: string,
  text: string,
  now = new Date(),
): Promise<MessageResult> {
  const ledger = new AutoLedger(runDir);
  // As resumeRun has it: only a run that met its objective or was dropped is over.
  // A run stopped for the owner's input is where guidance matters most.
  const state = await ledger.state();
  if (state.dropped || state.outcome === "objective_met") return "already_ended";
  await ledger.postInbox("message", text);
  return (await workedNow(runDir, now)) ? "sent" : "waiting";
}

export type ResumeResult = "running" | "finished" | "dropped" | "resumed";

/** Start the runner again for a stopped or interrupted run. */
export async function resumeRun(
  paths: AutoPaths,
  runDir: string,
  spawnRunner: (runDir: string) => void,
): Promise<ResumeResult> {
  if (await workedNow(runDir)) return "running";
  const state = await new AutoLedger(runDir).state();
  if (state.dropped) return "dropped";
  if (state.outcome === "objective_met") return "finished";
  const run = await readRunFile(runDir);
  await acquireProjectLock(paths, run.projectKey, run.runId);
  spawnRunner(runDir);
  return "resumed";
}

/**
 * What merging an ended run into its folder brings, after checking it can:
 * the runner is gone, and the folder is clean and still at the run's base, so
 * the merge is a fast-forward that rewrites nothing of the owner's.
 */
export async function mergePreview(runDir: string): Promise<AutopilotMergePreview> {
  const run = await readRunFile(runDir);
  const state = await new AutoLedger(runDir).state();
  if (!state.outcome || (await runnerAlive(runDir)))
    throw new Error("Stop the Autopilot run before merging its work.");
  const head = state.checkpoints.at(-1)?.commit;
  if (!head) throw new Error("The run has no verified work to merge.");
  if (await gitOutput(run.source, ["status", "--porcelain", "--untracked-files=no"]))
    throw new Error("The folder has uncommitted changes. Commit or stash them, then merge.");
  const current = await gitOutput(run.source, ["rev-parse", "HEAD"]);
  if (current === head) throw new Error("The run's work is already merged into the folder.");
  const mirror = mirrorRepo(run);
  // At the base, or at an earlier commit of this run (merged at a checkpoint):
  // either way the merge only adds the run's commits on top.
  const onTheRun =
    current === run.baseCommit ||
    (await mirror.run(["merge-base", "--is-ancestor", current, head])).code === 0;
  if (!onTheRun)
    throw new Error(
      `The folder moved on since the run started (it is at ${current.slice(0, 7)}, the run started at ${run.baseCommit.slice(0, 7)}). Export the patch and apply it yourself.`,
    );
  return {
    head,
    commits: Number(await mirror.output(["rev-list", "--count", `${current}..${head}`])),
    files: (await mirror.output(["diff", "--name-only", current, head])).split("\n").filter(Boolean)
      .length,
    runsHere: await filesThatRunHere(mirror, current, head),
    caseIds: state.cases.filter((item) => item.stage === "accepted").map((item) => item.id),
  };
}

/** Fast-forward the folder to the run's last verified commit. Only ever on the owner's word. */
export async function mergeRun(runDir: string): Promise<AutopilotMergePreview> {
  const preview = await mergePreview(runDir);
  const run = await readRunFile(runDir);
  await gitOutput(run.source, [
    "fetch",
    "--no-tags",
    "--quiet",
    run.mirror,
    `refs/heads/${run.branch}`,
  ]);
  // The owner's hooks would run on the worker's files (a post-merge hook
  // running a script the run changed), and an ignored file of theirs at a path
  // the run added would be overwritten without a word.
  await gitOutput(run.source, [
    "-c",
    "core.hooksPath=/dev/null",
    "merge",
    "--ff-only",
    "--no-overwrite-ignore",
    "--quiet",
    preview.head,
  ]);
  // A finished run is never resumed: once its work is in the folder, its worktree goes.
  if ((await new AutoLedger(runDir).state()).outcome === "objective_met")
    await removeRunWorktree(run);
  return preview;
}

/**
 * Drop a run nothing is working: end it if it had not ended, record that the
 * owner dropped it, and remove its worktree for good. Its verified work stays
 * on the mirror's branch, so it can still be merged or exported.
 */
export async function dropRun(
  paths: AutoPaths,
  runDir: string,
  isolation: { docker?: string; env?: NodeJS.ProcessEnv } = {},
  now = new Date(),
): Promise<void> {
  const run = await readRunFile(runDir);
  if (await beingWorked(runDir, run.createdAt, now))
    throw new Error("Stop the Autopilot run before dropping it.");
  const ledger = new AutoLedger(runDir);
  const state = await ledger.state();
  if (!state.outcome)
    await endRunWithoutRunner(
      runDir,
      paths,
      { outcome: "cancelled_after_checkpoint", reason: "Dropped by the owner." },
      isolation,
    );
  if (!state.dropped) await ledger.append({ type: "run_dropped" });
  await removeRunWorktree(run);
}

/** Every run with a worktree and no runner, biggest first: what a cleanup can remove. */
export async function cleanupCandidates(
  paths: AutoPaths,
  now = new Date(),
): Promise<AutopilotCleanupItem[]> {
  const items: AutopilotCleanupItem[] = [];
  for (const name of await readdir(paths.runs).catch(() => [] as string[])) {
    const runDir = paths.runDir(name);
    const run = await readRunFile(runDir).catch(() => undefined);
    if (!run?.worktree || !existsSync(run.worktree)) continue;
    if (await beingWorked(runDir, run.createdAt, now)) continue;
    const state = await new AutoLedger(runDir).state();
    items.push({
      runId: run.runId,
      source: run.source,
      createdAt: run.createdAt,
      ended: state.outcome ? OUTCOME_LABELS[state.outcome] : "interrupted",
      bytes: await diskUse(run.worktree),
    });
  }
  return items.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
}

/** A folder's size on disk, from du: a dependency tree has too many files to walk here. */
function diskUse(path: string): Promise<number | undefined> {
  return new Promise((done) =>
    execFile("du", ["-sk", path], { env: { PATH: "/usr/bin:/bin" } }, (error, stdout) => {
      const kilobytes = Number.parseInt(stdout, 10);
      done(error || !Number.isFinite(kilobytes) ? undefined : kilobytes * 1024);
    }),
  );
}
