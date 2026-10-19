/**
 * What a front end does to a run (ADR 016), shared by the terminal client and
 * the app: read its view, ask it to stop, start its runner again. A front end
 * never writes the run's ledger: it asks through the run's inbox, and only a
 * run with no runner is ended here.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AutopilotMergePreview,
  type AutopilotView,
  autoProgressView,
  OUTCOME_LABELS,
} from "@shared/auto-run";
import { runGit } from "../git";
import { AutoLedger } from "./ledger";
import {
  type AutoPaths,
  acquireProjectLock,
  endRunWithoutRunner,
  filesThatRunHere,
  mirrorRepo,
  newestRun,
  readRunFile,
  runnerAlive,
  runnerPid,
} from "./runs";

/** How long a new runner may take to write its pid before its run reads as interrupted. */
const RUNNER_START_MS = 30_000;

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
  // A runner just spawned has not written its pid yet: that is not an interruption.
  const starting =
    !(await runnerPid(runDir)) && now.getTime() - Date.parse(run.createdAt) < RUNNER_START_MS;
  const alive = starting || (await runnerAlive(runDir));
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
): Promise<StopResult> {
  const ledger = new AutoLedger(runDir);
  if ((await ledger.state()).outcome) return "already_ended";
  if (await runnerAlive(runDir)) {
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

export type ResumeResult = "running" | "finished" | "resumed";

/** Start the runner again for a stopped or interrupted run. */
export async function resumeRun(
  paths: AutoPaths,
  runDir: string,
  spawnRunner: (runDir: string) => void,
): Promise<ResumeResult> {
  if (await runnerAlive(runDir)) return "running";
  if ((await new AutoLedger(runDir).state()).outcome === "objective_met") return "finished";
  const run = await readRunFile(runDir);
  await acquireProjectLock(paths, run.projectKey, run.runId);
  spawnRunner(runDir);
  return "resumed";
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
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
  if (await git(run.source, ["status", "--porcelain", "--untracked-files=no"]))
    throw new Error("The folder has uncommitted changes. Commit or stash them, then merge.");
  const current = await git(run.source, ["rev-parse", "HEAD"]);
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
  await git(run.source, ["fetch", "--no-tags", "--quiet", run.mirror, `refs/heads/${run.branch}`]);
  // The owner's hooks would run on the worker's files (a post-merge hook
  // running a script the run changed), and an ignored file of theirs at a path
  // the run added would be overwritten without a word.
  await git(run.source, [
    "-c",
    "core.hooksPath=/dev/null",
    "merge",
    "--ff-only",
    "--no-overwrite-ignore",
    "--quiet",
    preview.head,
  ]);
  return preview;
}
