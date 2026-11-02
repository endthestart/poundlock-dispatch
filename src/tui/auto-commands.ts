/** The `dispatch autopilot` commands that read or act on existing runs. */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanupCandidates, dropRun, messageRun, resumeRun, stopRun } from "@core/auto/control";
import { AutoLedger } from "@core/auto/ledger";
import { exportRun, readRunFile, resolveRun, runnerPid, runsForSource } from "@core/auto/runs";
import {
  PLANNER_EVAL_HEADER,
  type PlannerEvalFixture,
  plannerEvalRow,
} from "@core/goal/planner-eval";
import { runPlannerEval } from "@runtime/planner-eval";
import { OUTCOME_LABELS } from "@shared/auto-run";
import { diskSize } from "@shared/disk-size";
import type { AutoCommand } from "./auto-args.js";
import type { AutoContext } from "./auto-context.js";

export async function listRuns(
  command: Extract<AutoCommand, { command: "list" }>,
  context: AutoContext,
): Promise<number> {
  const { deps, say } = context;
  const runs = await runsForSource(deps.paths, command.dir);
  if (!runs.length) say(`No Autopilot runs for ${resolve(command.dir)} yet.`);
  for (const { run, state, alive } of runs) {
    const verified = state.cases.filter((c) => c.stage === "accepted").length;
    const where = state.outcome
      ? OUTCOME_LABELS[state.outcome]
      : alive
        ? "running"
        : "interrupted (resume it)";
    say(`${run.runId}  ${verified}/${state.cases.length} verified, not reviewed  ${where}`);
  }
  return 0;
}

export async function watchRun(
  command: { run?: string; dir?: string },
  context: AutoContext,
): Promise<number> {
  const { deps, say, sleep, progress } = context;
  const runDir = await resolveRun(deps.paths, command);
  let detached = false;
  const stopListening = (deps.onInterrupt ?? onSigint)(() => {
    detached = true;
  });
  try {
    let shown = "";
    for (;;) {
      const lines = await progress(runDir);
      const text = lines.join("\n");
      if (text !== shown) {
        say(`${shown ? "\n" : ""}${text}`);
        shown = text;
      }
      const state = await new AutoLedger(runDir).state();
      if (state.outcome) return state.outcome === "failed" ? 1 : 0;
      if (detached) {
        say(
          `Left the run; it goes on. Come back with: dispatch autopilot watch ${(await readRunFile(runDir)).runId}`,
        );
        return 0;
      }
      await sleep(2000);
    }
  } finally {
    stopListening();
  }
}

export async function messageCommand(
  command: Extract<AutoCommand, { command: "message" }>,
  context: AutoContext,
): Promise<number> {
  const { deps, say } = context;
  const runDir = await resolveRun(deps.paths, command);
  const result = await messageRun(runDir, command.text);
  say(
    result === "already_ended"
      ? "The run is finished; nothing was sent."
      : result === "sent"
        ? "Sent. The worker on the current case hears it now; later cases and the Planner's next review read it."
        : "Saved. The runner is not running; the run takes it when it resumes.",
  );
  return result === "already_ended" ? 1 : 0;
}

export async function stopCommand(
  command: Extract<AutoCommand, { command: "stop" }>,
  context: AutoContext,
): Promise<number> {
  const { deps, say } = context;
  const runDir = await resolveRun(deps.paths, command);
  const result = await stopRun(deps.paths, runDir, command.now ? "now" : "after_case", {
    docker: deps.docker,
    env: deps.dockerEnv,
  });
  if (result === "already_ended") {
    const state = await new AutoLedger(runDir).state();
    say(`The run has already ended${state.outcome ? `: ${OUTCOME_LABELS[state.outcome]}` : ""}.`);
  } else if (result === "asked")
    say(
      command.now
        ? "Asked the runner to stop now; the attempt's work is saved."
        : "Asked the runner to stop after the current case.",
    );
  else
    say(
      "The runner was not running. The run is stopped, and its work is saved; it can be resumed.",
    );
  return 0;
}

export async function resumeCommand(
  command: { run?: string; dir?: string },
  context: AutoContext,
): Promise<number> {
  const { deps, say, warn, spawnRunner } = context;
  const runDir = await resolveRun(deps.paths, command);
  const result = await resumeRun(deps.paths, runDir, spawnRunner);
  if (result === "running") {
    warn(`The run is already running (pid ${await runnerPid(runDir)}).`);
    return 1;
  }
  if (result === "finished") {
    say("Every case of this run is verified; there is nothing to resume.");
    return 0;
  }
  if (result === "dropped") {
    warn("This run was dropped, so it cannot be resumed. Export or merge its verified work.");
    return 1;
  }
  const run = await readRunFile(runDir);
  say(`Resuming ${run.runId}. Follow it with: dispatch autopilot watch ${run.runId}`);
  return 0;
}

export async function evalPlanner(
  command: Extract<AutoCommand, { command: "eval-planner" }>,
  context: AutoContext,
): Promise<number> {
  const { deps, say } = context;
  const fixture = JSON.parse(await readFile(command.fixture, "utf8")) as PlannerEvalFixture;
  // Fixtures can come from other people: the names become a folder this
  // command empties, so they must be plain names.
  const plain = /^[\w.-]+$/;
  for (const [what, value] of [
    ["fixture name", fixture.name],
    ["profile", command.profile],
  ] as const)
    if (typeof value !== "string" || !plain.test(value) || value.includes(".."))
      throw new Error(`The ${what} must be letters, digits, dots, dashes or underscores.`);
  if (!command.out && !command.fixture.endsWith(".json"))
    throw new Error("Name the result file with --out, or give a fixture ending in .json.");
  const result = await runPlannerEval(fixture, {
    connection: await deps.connection(),
    model: command.profile,
    dir: join(deps.paths.root, "planner-eval", `${fixture.name}-${command.profile}`),
    fetch: deps.fetch,
    onActivity: (text) => say(text),
  });
  const out = command.out ?? command.fixture.replace(/\.json$/, `.${command.profile}.json`);
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  say(PLANNER_EVAL_HEADER);
  say(plannerEvalRow(result));
  say(`Wrote ${out}.`);
  return result.scores.usable ? 0 : 1;
}

export async function cleanRuns(
  command: Extract<AutoCommand, { command: "clean" }>,
  context: AutoContext,
): Promise<number> {
  const { deps, say } = context;
  const items = await cleanupCandidates(deps.paths);
  if (!items.length) {
    say("No ended run has a working copy left.");
    return 0;
  }
  for (const item of items)
    say(
      `${item.bytes === undefined ? "size unknown" : diskSize(item.bytes)}  ${item.runId}  ${item.ended}  ${item.source}`,
    );
  if (!command.all) {
    say(
      "Drop one with: dispatch autopilot drop <run>. Drop every one listed with: dispatch autopilot clean --all",
    );
    return 0;
  }
  for (const item of items)
    await dropRun(deps.paths, deps.paths.runDir(item.runId), {
      docker: deps.docker,
      env: deps.dockerEnv,
    });
  say(`Dropped ${items.length} ${items.length === 1 ? "run" : "runs"} and their working copies.`);
  return 0;
}

export async function exportCommand(
  command: Extract<AutoCommand, { command: "export" }>,
  context: AutoContext,
): Promise<number> {
  const { deps, say, warn } = context;
  const runDir = await resolveRun(deps.paths, command);
  const exported = await exportRun(runDir, command.out);
  const run = await readRunFile(runDir);
  for (const warning of exported.warnings) warn(warning);
  say(`Wrote ${exported.file}: ${exported.files.length} files, verified, not reviewed.`);
  if (exported.runsHere.length)
    warn(
      `Files that run on your machine once applied, review these first: ${exported.runsHere.join(", ")}`,
    );
  say(
    `It applies to ${run.baseCommit.slice(0, 12)}. Review it, then: git apply --index ${exported.file}`,
  );
  say(`Or fetch the branch: git fetch ${run.mirror} ${run.branch}:${run.branch}`);
  say(
    exported.removedWorktree
      ? "The run is finished, so its worktree was removed; the patch and the branch hold its work."
      : `Do not run Git or open an editor in ${run.worktree}: the model wrote it. Use the patch or the branch.`,
  );
  return 0;
}

function onSigint(handler: () => void): () => void {
  process.on("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}
