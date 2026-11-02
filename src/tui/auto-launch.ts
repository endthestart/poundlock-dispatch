/** `dispatch autopilot start`: check the plan, start the runner detached, and wait for the base checks if asked. */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AutoLedger } from "@core/auto/ledger";
import { runnerAlive, runnerPid } from "@core/auto/runs";
import { type AutoPlanFile, startAutoRun } from "@core/auto/start";
import { autoDockerContext } from "@core/data-root";
import { OUTCOME_LABELS } from "@shared/auto-run";
import type { AutoCommand } from "./auto-args.js";
import type { AutoContext } from "./auto-context.js";

/** Start `autopilot run <runDir>` as a detached process that outlives this one, logging to the run. */
export function spawnDetachedRunner(entry: string, runDir: string): void {
  const log = openSync(join(runDir, "runner.log"), "a", 0o600);
  const child = spawn(process.execPath, [entry, "autopilot", "run", runDir], {
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

export async function startCommand(
  command: Extract<AutoCommand, { command: "start" }>,
  context: AutoContext,
): Promise<number> {
  const { deps, say, warn, sleep, spawnRunner } = context;
  const { runDir, run, model, warnings } = await startAutoRun(
    {
      dir: command.dir,
      plan: command.plan ? await readPlan(command.plan) : undefined,
      profile: command.profile,
      image: command.image,
      dockerContext: command.dockerContext ?? autoDockerContext(),
      allowHomeInVm: command.allowHomeInVm,
      checks: command.checks,
      prepare: command.prepare,
      allowDependencyDownloads: command.allowDependencyDownloads,
      ...(command.acceptAlreadyMet ? { acceptAlreadyMet: true } : {}),
      limits: command.limits,
      goal: {
        ...(command.checkpoint ? { checkpoint: command.checkpoint } : {}),
        ...(command.allowPlanner ? { allowPlannerDestination: command.allowPlanner } : {}),
        ...(command.plannerCapUsd !== undefined
          ? { plannerSpendCapUsd: command.plannerCapUsd }
          : {}),
      },
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
  say(`Started ${run.runId}. It runs in the background: closing this terminal does not stop it.`);
  say(`  Model: ${model.id} through Poundlock`);
  say(`  Commands: in a container (${run.image}), no network, Docker context ${run.dockerContext}`);
  say(`  Cases: ${run.cases.length} · checks: ${run.checks.map((c) => `\`${c}\``).join(", ")}`);
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
      say(
        `The base checks pass; cases are running. Follow it with: dispatch autopilot watch ${run.runId}`,
      );
      return 0;
    }
    if (state.outcome) {
      warn(`${OUTCOME_LABELS[state.outcome]}: ${state.endReason ?? ""}`);
      warn(`See ${join(runDir, "runner.log")} and ${join(runDir, "verify")}.`);
      return 1;
    }
    const pid = await runnerPid(runDir);
    if ((pid && !(await runnerAlive(runDir))) || (!pid && Date.now() - since > 30_000)) {
      warn(`The runner stopped before the checks finished. See ${join(runDir, "runner.log")}.`);
      return 1;
    }
    await sleep(1000);
  }
}

/** Hours as a person writes them: "2 h", "2 h 35 min". */
export function hours(value: number): string {
  const minutes = Math.round(value * 60);
  const whole = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!whole) return `${rest} min`;
  return rest ? `${whole} h ${rest} min` : `${whole} h`;
}
