/**
 * Local auto mode from a shell: `dispatch autopilot <command>` (ADR 014).
 *
 * `start` checks everything it can before taking the folder's lock, then
 * starts the runner as a detached process that outlives this terminal. The
 * other commands read the run's files, so any terminal can attach (`watch`,
 * `status`) and leave again; `stop`, `resume` and `export` act on the run.
 * The runner itself is `autopilot run <run folder>`, started only by `start` and
 * `resume`.
 *
 * Results are verified, not reviewed, and nothing printed here says otherwise.
 * Exit codes: 0 done, 1 failed, 2 wrong usage.
 */
import { dropRun } from "@core/auto/control";
import { readRunFile, resolveRun, statusLines } from "@core/auto/runs";
import { runAutoRunner } from "@runtime/auto-runner";
import { displaySafe } from "@shared/display-safe";
import { AUTO_USAGE, type AutoCommand, AutoUsageError, parseAutoArgs } from "./auto-args.js";
import { runCardReader } from "./auto-card.js";
import {
  cleanRuns,
  evalPlanner,
  exportCommand,
  listRuns,
  messageCommand,
  resumeCommand,
  stopCommand,
  watchRun,
} from "./auto-commands.js";
import type { AutoCliDeps, AutoContext } from "./auto-context.js";
import { runDetailLines } from "./auto-details.js";
import { spawnDetachedRunner, startCommand } from "./auto-launch.js";
import { mergeCommand, reportPath } from "./auto-merge.js";

export async function runAuto(argv: string[], deps: AutoCliDeps): Promise<number> {
  const say = (text: string) => deps.io.out(`${displaySafe(text)}\n`);
  const warn = (text: string) => deps.io.err(`${displaySafe(text)}\n`);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let command: AutoCommand;
  try {
    command = parseAutoArgs(argv);
  } catch (error) {
    if (!(error instanceof AutoUsageError)) throw error;
    warn(`${error.message}\nRun "dispatch autopilot --help" for usage.`);
    return 2;
  }
  if (command.command === "help") {
    (argv.length ? deps.io.out : deps.io.err)(AUTO_USAGE);
    return argv.length ? 0 : 2;
  }
  const spawnRunner =
    deps.spawnRunner ?? ((runDir: string) => spawnDetachedRunner(deps.entry, runDir));
  // The newest run's card and its details; an older run has only its progress lines.
  const card = runCardReader(deps);
  const progress = async (runDir: string) => {
    const read = await card(runDir);
    return read ? [...read.card, "", ...runDetailLines(read.view)] : statusLines(runDir);
  };
  try {
    const context: AutoContext = { deps, say, warn, sleep, spawnRunner, progress };
    switch (command.command) {
      case "run": {
        const outcome = await runAutoRunner(command.runDir, {
          paths: deps.paths,
          connection: deps.connection,
          fetch: deps.fetch,
          docker: deps.docker,
          dockerEnv: deps.dockerEnv,
          home: deps.home,
          ...deps.runner,
        });
        return outcome && outcome !== "failed" ? 0 : 1;
      }
      case "start":
        return await startCommand(command, context);
      case "list":
        return await listRuns(command, context);
      case "status": {
        const runDir = await resolveRun(deps.paths, command);
        for (const line of await progress(runDir)) say(line);
        return 0;
      }
      case "watch":
        return await watchRun(command, context);
      case "message":
        return await messageCommand(command, context);
      case "stop":
        return await stopCommand(command, context);
      case "resume":
        return await resumeCommand(command, context);
      case "eval-planner":
        return await evalPlanner(command, context);
      case "merge": {
        const runDir = await resolveRun(deps.paths, command);
        for (const line of await mergeCommand(runDir, command.yes, { ...deps, spawnRunner }))
          say(line);
        return 0;
      }
      case "report": {
        say(reportPath(await resolveRun(deps.paths, command)));
        return 0;
      }
      case "drop": {
        const runDir = await resolveRun(deps.paths, command);
        await dropRun(deps.paths, runDir, { docker: deps.docker, env: deps.dockerEnv });
        say(
          `Dropped ${(await readRunFile(runDir)).runId}: its working copy is removed. Its verified work can still be exported or merged.`,
        );
        return 0;
      }
      case "clean":
        return await cleanRuns(command, context);
      case "export":
        return await exportCommand(command, context);
    }
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
