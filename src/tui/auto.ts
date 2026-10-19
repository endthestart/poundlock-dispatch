/**
 * Local auto mode from a shell: `poundlock-dispatch-tui auto <command>` (ADR 014).
 *
 * `start` checks everything it can before taking the folder's lock, then
 * starts the runner as a detached process that outlives this terminal. The
 * other commands read the run's files, so any terminal can attach (`watch`,
 * `status`) and leave again; `stop`, `resume` and `export` act on the run.
 * The runner itself is `auto run <run folder>`, started only by `start` and
 * `resume`.
 *
 * Results are verified, not reviewed, and nothing printed here says otherwise.
 * Exit codes: 0 done, 1 failed, 2 wrong usage.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resumeRun, stopRun } from "@core/auto/control";
import { AutoLedger } from "@core/auto/ledger";
import {
  type AutoPaths,
  exportRun,
  readRunFile,
  resolveRun,
  runnerAlive,
  runnerPid,
  runsForSource,
  statusLines,
} from "@core/auto/runs";
import { type AutoPlanFile, type AutoStartDeps, startAutoRun } from "@core/auto/start";
import {
  PLANNER_EVAL_HEADER,
  type PlannerEvalFixture,
  plannerEvalRow,
} from "@core/goal/planner-eval";
import type { FileStore } from "@core/store";
import { type AutoRunnerDeps, runAutoRunner } from "@runtime/auto-runner";
import { runPlannerEval } from "@runtime/planner-eval";
import { OUTCOME_LABELS } from "@shared/auto-run";
import type { ConnectionSettings, ProjectRecord } from "@shared/types";
import { displaySafe } from "./jobs.js";

export const AUTO_USAGE = `Usage: dispatch autopilot <command> [run] [options]

Autopilot: work an approved plan unattended, in a private clone of the
folder, with every command in a container and inference through Poundlock.
Results are verified by the project's checks, not reviewed. "dispatch auto"
is the same command, for one more release.

Commands:
  start           Check everything, then start a run in the background.
  status [run]    Show a run's progress.
  watch [run]     Follow a run; Ctrl+C leaves it running.
  stop [run]      Stop after the current case; --now stops at once (the attempt is saved).
  resume [run]    Start the runner again for a stopped or interrupted run.
  export [run]    Write the run's verified work as a patch that applies to its base.
  list            The folder's runs, newest first.
  eval-planner <fixture.json> --profile <model> [--out <file>]
                  Run one Planner call from an evaluation fixture and score it
                  (poundlock.planner-eval/1); writes the result as JSON.

A run is named by its id. Without one, the newest run of --dir is meant.

start options:
  --dir <path>                  The project folder, a Git repository's top (required).
  --image <name>                Container image with the project's toolchain (required).
                                Dispatch never pulls or builds it.
  --plan <file>                 Cases as JSON (default: the folder's approved plan).
  --profile <id>                Poundlock worker profile (default: the project's worker).
  --check <command>             A check that decides acceptance; repeatable
                                (default: the plan's checks).
  --prepare <command>           Setup run once before the base check; repeatable.
  --allow-dependency-downloads  Give setup the network, for package registries.
  --docker-context <name>       The Docker context (default colima-dispatch-auto). Its VM
                                must mount only Dispatch's auto folder; see ADR 014.
  --allow-home-in-vm            Run even though the VM can see your home folder.
  --hours <n>                   Soft wall-clock limit (default 24).
  --case-minutes <n>            Time for each case (default 90).
  --max-cases <n>               Cases started (default 40).
  --max-tokens <n>              Processed tokens; cache reads never count.
  --no-wait                     Return without waiting for the base checks.

Other options:
  --dir <path>                  The folder whose newest run is meant.
  --now                         stop: stop at once.
  --out <file>                  export: where to write the patch.

Exit codes: 0 done, 1 failed, 2 wrong usage.
`;

export class AutoUsageError extends Error {}

export type AutoCommand =
  | { command: "help" }
  | { command: "run"; runDir: string }
  | { command: "list"; dir: string }
  | { command: "status" | "watch" | "resume"; run?: string; dir?: string }
  | { command: "stop"; run?: string; dir?: string; now: boolean }
  | { command: "export"; run?: string; dir?: string; out?: string }
  | { command: "eval-planner"; fixture: string; profile: string; out?: string }
  | {
      command: "start";
      dir: string;
      image: string;
      plan?: string;
      profile?: string;
      checks: string[];
      prepare: string[];
      allowDependencyDownloads: boolean;
      dockerContext?: string;
      allowHomeInVm: boolean;
      limits: { hours?: number; caseMinutes?: number; maxCases?: number; maxTokens?: number };
      wait: boolean;
    };

function positive(name: string, value: string | undefined, integer = true): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed)))
    throw new AutoUsageError(`${name} must be a positive ${integer ? "whole " : ""}number.`);
  return parsed;
}

export function parseAutoArgs(argv: string[]): AutoCommand {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h")
    return { command: "help" };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        dir: { type: "string" },
        image: { type: "string" },
        plan: { type: "string" },
        profile: { type: "string" },
        check: { type: "string", multiple: true },
        prepare: { type: "string", multiple: true },
        "allow-dependency-downloads": { type: "boolean" },
        "docker-context": { type: "string" },
        "allow-home-in-vm": { type: "boolean" },
        hours: { type: "string" },
        "case-minutes": { type: "string" },
        "max-cases": { type: "string" },
        "max-tokens": { type: "string" },
        "no-wait": { type: "boolean" },
        now: { type: "boolean" },
        out: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new AutoUsageError(error instanceof Error ? error.message : String(error));
  }
  const values = parsed.values as Record<string, string | string[] | boolean | undefined>;
  const text = (name: string) => values[name] as string | undefined;
  const list = (name: string) => (values[name] as string[] | undefined) ?? [];
  if (values.help) return { command: "help" };
  const [run, ...extra] = parsed.positionals;
  if (extra.length) throw new AutoUsageError(`auto ${command} takes at most one run.`);
  const dir = text("dir");
  switch (command) {
    case "run":
      if (!run) throw new AutoUsageError("auto run takes the run's folder.");
      return { command: "run", runDir: resolve(run) };
    case "list":
      if (!dir) throw new AutoUsageError("auto list needs --dir <folder>.");
      return { command: "list", dir };
    case "status":
    case "watch":
    case "resume":
      return { command, run, dir };
    case "stop":
      return { command, run, dir, now: Boolean(values.now) };
    case "export":
      return { command, run, dir, out: text("out") };
    case "eval-planner": {
      const profile = text("profile");
      if (!run || !profile)
        throw new AutoUsageError("auto eval-planner takes a fixture file and --profile <model>.");
      return { command, fixture: resolve(run), profile, out: text("out") };
    }
    case "start": {
      if (run) throw new AutoUsageError("auto start takes options only.");
      if (!dir) throw new AutoUsageError("--dir is required: name the project folder.");
      const image = text("image");
      if (!image?.trim())
        throw new AutoUsageError(
          "--image is required: the container image with the project's toolchain.",
        );
      if ([...list("check"), ...list("prepare")].some((entry) => !entry.trim()))
        throw new AutoUsageError("--check and --prepare cannot be empty.");
      return {
        command: "start",
        dir,
        image,
        plan: text("plan"),
        profile: text("profile"),
        checks: list("check"),
        prepare: list("prepare"),
        allowDependencyDownloads: Boolean(values["allow-dependency-downloads"]),
        dockerContext: text("docker-context"),
        allowHomeInVm: Boolean(values["allow-home-in-vm"]),
        limits: {
          hours: positive("--hours", text("hours"), false),
          caseMinutes: positive("--case-minutes", text("case-minutes")),
          maxCases: positive("--max-cases", text("max-cases")),
          maxTokens: positive("--max-tokens", text("max-tokens")),
        },
        wait: !values["no-wait"],
      };
    }
    default:
      throw new AutoUsageError(`Unknown auto command: ${command}`);
  }
}

export interface AutoCliDeps {
  paths: AutoPaths;
  connection(): Promise<ConnectionSettings>;
  /** The Dispatch project for a folder, if this client has one. */
  project(source: string): Promise<{ project: ProjectRecord; store: FileStore } | undefined>;
  /** The script the runner is started with: this program's entry. */
  entry: string;
  io: { out(text: string): void; err(text: string): void };
  fetch?: typeof fetch;
  docker?: string;
  dockerEnv?: NodeJS.ProcessEnv;
  spawnRunner?: (runDir: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Where Ctrl+C is heard while watching; returns how to stop listening. */
  onInterrupt?: (handler: () => void) => () => void;
  runner?: Partial<AutoRunnerDeps>;
  freeBytes?: AutoStartDeps["freeBytes"];
  /** The owner's home folder, which the container VM must not mount. */
  home?: string;
}

/** Start `auto run <runDir>` as a detached process that outlives this one, logging to the run. */
export function spawnDetachedRunner(entry: string, runDir: string): void {
  const log = openSync(join(runDir, "runner.log"), "a", 0o600);
  const child = spawn(process.execPath, [entry, "auto", "run", runDir], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  closeSync(log);
}

async function readPlan(file: string): Promise<AutoPlanFile> {
  let plan: AutoPlanFile;
  try {
    plan = JSON.parse(await readFile(file, "utf8")) as AutoPlanFile;
  } catch (error) {
    throw new Error(
      `${file} is not a readable plan: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!Array.isArray(plan.cases)) throw new Error(`${file} has no "cases" list.`);
  for (const key of ["checks", "prepare"] as const)
    if (
      plan[key] !== undefined &&
      (!Array.isArray(plan[key]) || plan[key].some((c) => typeof c !== "string"))
    )
      throw new Error(`${file}: "${key}" must be a list of commands.`);
  return {
    ...plan,
    cases: plan.cases.map((item) => ({
      ...item,
      acceptanceCriteria: item.acceptanceCriteria ?? "",
      dependsOn: item.dependsOn ?? [],
    })),
  };
}

export async function runAuto(argv: string[], deps: AutoCliDeps): Promise<number> {
  const say = (text: string) => deps.io.out(`${displaySafe(text)}\n`);
  const warn = (text: string) => deps.io.err(`${displaySafe(text)}\n`);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let command: AutoCommand;
  try {
    command = parseAutoArgs(argv);
  } catch (error) {
    if (!(error instanceof AutoUsageError)) throw error;
    warn(`${error.message}\nRun "auto --help" for usage.`);
    return 2;
  }
  if (command.command === "help") {
    (argv.length ? deps.io.out : deps.io.err)(AUTO_USAGE);
    return argv.length ? 0 : 2;
  }
  const spawnRunner =
    deps.spawnRunner ?? ((runDir: string) => spawnDetachedRunner(deps.entry, runDir));
  try {
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
      case "start": {
        const { runDir, run, model, warnings } = await startAutoRun(
          {
            dir: command.dir,
            plan: command.plan ? await readPlan(command.plan) : undefined,
            profile: command.profile,
            image: command.image,
            dockerContext: command.dockerContext,
            allowHomeInVm: command.allowHomeInVm,
            checks: command.checks,
            prepare: command.prepare,
            allowDependencyDownloads: command.allowDependencyDownloads,
            limits: command.limits,
          },
          {
            paths: deps.paths,
            connection: deps.connection,
            project: deps.project,
            spawnRunner,
            fetch: deps.fetch,
            docker: deps.docker,
            dockerEnv: deps.dockerEnv,
            freeBytes: deps.freeBytes,
            home: deps.home,
          },
        );
        for (const warning of warnings) warn(warning);
        say(
          `Started ${run.runId}. It runs in the background: closing this terminal does not stop it.`,
        );
        say(`  Model: ${model.id} through Poundlock`);
        say(
          `  Commands: in a container (${run.image}), no network, Docker context ${run.dockerContext}`,
        );
        say(
          `  Cases: ${run.cases.length} · checks: ${run.checks.map((c) => `\`${c}\``).join(", ")}`,
        );
        say(
          `  Limits: ${hours(run.limits.softHours)} (hard ${hours(run.limits.hardHours)}), ${run.limits.caseMinutes} min per case, ${run.limits.maxCases} cases`,
        );
        say(`  Results are verified by the checks, not reviewed. Run folder: ${runDir}`);
        if (!run.scope.protectedPaths?.length)
          say(
            "  Note: no protected paths. The worker may change the tests and settings the checks use; name them in the plan's scope to keep them fixed.",
          );
        if (!command.wait) return 0;
        say("Preparing the container and running the checks at the base commit…");
        const since = Date.now();
        for (;;) {
          const state = await new AutoLedger(runDir).state();
          if (state.preflight === "passed") {
            say(`The base checks pass; cases are running. Follow it with: auto watch ${run.runId}`);
            return 0;
          }
          if (state.outcome) {
            warn(`${OUTCOME_LABELS[state.outcome]}: ${state.endReason ?? ""}`);
            warn(`See ${join(runDir, "runner.log")} and ${join(runDir, "verify")}.`);
            return 1;
          }
          const pid = await runnerPid(runDir);
          if ((pid && !(await runnerAlive(runDir))) || (!pid && Date.now() - since > 30_000)) {
            warn(
              `The runner stopped before the checks finished. See ${join(runDir, "runner.log")}.`,
            );
            return 1;
          }
          await sleep(1000);
        }
      }
      case "list": {
        const runs = await runsForSource(deps.paths, command.dir);
        if (!runs.length) say(`No auto runs for ${resolve(command.dir)} yet.`);
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
      case "status": {
        const runDir = await resolveRun(deps.paths, command);
        for (const line of await statusLines(runDir)) say(line);
        return 0;
      }
      case "watch": {
        const runDir = await resolveRun(deps.paths, command);
        let detached = false;
        const stopListening = (deps.onInterrupt ?? onSigint)(() => {
          detached = true;
        });
        try {
          let shown = "";
          for (;;) {
            const lines = await statusLines(runDir);
            const text = lines.join("\n");
            if (text !== shown) {
              say(`${shown ? "\n" : ""}${text}`);
              shown = text;
            }
            const state = await new AutoLedger(runDir).state();
            if (state.outcome) return state.outcome === "failed" ? 1 : 0;
            if (detached) {
              say(
                `Left the run; it goes on. Come back with: auto watch ${(await readRunFile(runDir)).runId}`,
              );
              return 0;
            }
            await sleep(2000);
          }
        } finally {
          stopListening();
        }
      }
      case "stop": {
        const runDir = await resolveRun(deps.paths, command);
        const result = await stopRun(deps.paths, runDir, command.now ? "now" : "after_case", {
          docker: deps.docker,
          env: deps.dockerEnv,
        });
        if (result === "already_ended") {
          const state = await new AutoLedger(runDir).state();
          say(
            `The run has already ended${state.outcome ? `: ${OUTCOME_LABELS[state.outcome]}` : ""}.`,
          );
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
      case "resume": {
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
        const run = await readRunFile(runDir);
        say(`Resuming ${run.runId}. Follow it with: auto watch ${run.runId}`);
        return 0;
      }
      case "eval-planner": {
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
      case "export": {
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
    }
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Words of a typed command, with "double" or 'single' quotes keeping spaces. */
export function splitCommandLine(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new AutoUsageError("A quote is not closed.");
  if (started) words.push(current);
  return words;
}

function onSigint(handler: () => void): () => void {
  process.on("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}

/** Hours as a person writes them: "2 h", "2 h 35 min". */
export function hours(value: number): string {
  const minutes = Math.round(value * 60);
  const whole = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!whole) return `${rest} min`;
  return rest ? `${whole} h ${rest} min` : `${whole} h`;
}
