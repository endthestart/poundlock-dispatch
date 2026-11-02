/** The `dispatch autopilot` command line: its usage text, what each command asks for, and typed commands split into words. */

import { resolve } from "node:path";
import { parseArgs } from "node:util";

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
  message [run] --text <words>
                  Tell a run something: the worker on the current case hears it now,
                  and later cases and the Planner's next review read it.
  resume [run]    Start the runner again for a stopped or interrupted run.
  export [run]    Write the run's verified work as a patch that applies to its base.
  merge [run]     Say what merging the run's verified work into the folder brings;
                  --yes fast-forwards the folder to it.
  report [run]    Where an ended run's report is.
  drop [run]      Drop an ended run: its working copy goes for good, and it cannot
                  be resumed. Its verified work can still be exported or merged.
  clean           List ended runs whose working copies can go, biggest first;
                  --all drops every one listed.
  list            The folder's runs, newest first.
  eval-planner <fixture.json> --profile <model> [--out <file>]
                  Run one Planner call from an evaluation fixture and score it
                  (poundlock.planner-eval/1); writes the result as JSON.

A run is named by its id. Without one, the newest run of --dir is meant, or of
the folder the command is typed in.

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
  --docker-context <name>       The Docker context (default $POUNDLOCK_DISPATCH_DOCKER_CONTEXT,
                                else colima-dispatch-auto). Its VM
                                must mount only Dispatch's auto folder; see ADR 014.
  --allow-home-in-vm            Run even though the VM can see your home folder.
  --allow-planner <destination> Let a Planner outside your network read code excerpts
                                (the destination its error names).
  --planner-cap <usd>           That Planner's spend cap for the run (default $5).
  --checkpoint <notify|wait>    For a plan with milestones: keep going after each one
                                (notify, the default) or stop until you resume (wait).
  --accept-already-met          Accept a task whose work is already in the code
                                (experimental: the milestone's next review judges it).
  --hours <n>                   Soft wall-clock limit (default 24).
  --case-minutes <n>            Time for each case (default 90).
  --max-cases <n>               Cases started (default 40).
  --max-tokens <n>              Processed tokens; cache reads never count.
  --no-wait                     Return without waiting for the base checks.

Other options:
  --dir <path>                  The folder whose newest run is meant.
  --now                         stop: stop at once.
  --out <file>                  export: where to write the patch.
  --all                         clean: drop every run listed.
  --yes                         merge: fast-forward the folder.

Exit codes: 0 done, 1 failed, 2 wrong usage.
`;

export class AutoUsageError extends Error {}

export type AutoCommand =
  | { command: "help" }
  | { command: "run"; runDir: string }
  | { command: "list"; dir: string }
  | { command: "status" | "watch" | "resume"; run?: string; dir?: string }
  | { command: "stop"; run?: string; dir?: string; now: boolean }
  | { command: "message"; run?: string; dir?: string; text: string }
  | { command: "export"; run?: string; dir?: string; out?: string }
  | { command: "drop" | "report"; run?: string; dir?: string }
  | { command: "merge"; run?: string; dir?: string; yes: boolean }
  | { command: "clean"; all: boolean }
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
      allowPlanner?: string;
      plannerCapUsd?: number;
      checkpoint?: "notify" | "wait";
      acceptAlreadyMet: boolean;
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
        "allow-planner": { type: "string" },
        "planner-cap": { type: "string" },
        checkpoint: { type: "string" },
        "accept-already-met": { type: "boolean" },
        hours: { type: "string" },
        "case-minutes": { type: "string" },
        "max-cases": { type: "string" },
        "max-tokens": { type: "string" },
        "no-wait": { type: "boolean" },
        now: { type: "boolean" },
        out: { type: "string" },
        all: { type: "boolean" },
        text: { type: "string" },
        yes: { type: "boolean" },
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
  if (extra.length) throw new AutoUsageError(`autopilot ${command} takes at most one run.`);
  // Without a run or --dir, the folder this is typed in, as bare `dispatch`
  // opens it. Starting a run still names its folder.
  const dir = text("dir") ?? (run || command === "start" ? undefined : process.cwd());
  switch (command) {
    case "run":
      if (!run) throw new AutoUsageError("autopilot run takes the run's folder.");
      return { command: "run", runDir: resolve(run) };
    case "list":
      return { command: "list", dir: dir ?? process.cwd() };
    case "status":
    case "watch":
    case "resume":
      return { command, run, dir };
    case "stop":
      return { command, run, dir, now: Boolean(values.now) };
    case "message": {
      const words = text("text")?.trim();
      if (!words) throw new AutoUsageError("autopilot message needs --text <words>.");
      return { command, run, dir, text: words };
    }
    case "export":
      return { command, run, dir, out: text("out") };
    case "drop":
    case "report":
      return { command, run, dir };
    case "merge":
      return { command, run, dir, yes: Boolean(values.yes) };
    case "clean":
      if (run)
        throw new AutoUsageError("autopilot clean takes no run: use autopilot drop <run> for one.");
      return { command, all: Boolean(values.all) };
    case "eval-planner": {
      const profile = text("profile");
      if (!run || !profile)
        throw new AutoUsageError(
          "autopilot eval-planner takes a fixture file and --profile <model>.",
        );
      return { command, fixture: resolve(run), profile, out: text("out") };
    }
    case "start": {
      if (run) throw new AutoUsageError("autopilot start takes options only.");
      if (!dir) throw new AutoUsageError("--dir is required: name the project folder.");
      const image = text("image");
      if (!image?.trim())
        throw new AutoUsageError(
          "--image is required: the container image with the project's toolchain.",
        );
      if ([...list("check"), ...list("prepare")].some((entry) => !entry.trim()))
        throw new AutoUsageError("--check and --prepare cannot be empty.");
      const checkpoint = text("checkpoint");
      if (checkpoint !== undefined && checkpoint !== "notify" && checkpoint !== "wait")
        throw new AutoUsageError("--checkpoint is notify or wait.");
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
        allowPlanner: text("allow-planner"),
        plannerCapUsd: positive("--planner-cap", text("planner-cap"), false),
        ...(checkpoint ? { checkpoint } : {}),
        acceptAlreadyMet: Boolean(values["accept-already-met"]),
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
      throw new AutoUsageError(`Unknown Autopilot command: ${command}`);
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
