/**
 * The auto-mode runner (ADR 014): the detached process that works one run.
 * It is visible, never hidden: a pid file, a lock, a log, a heartbeat in
 * status.json and the append-only ledger. It keeps the Mac awake while it
 * works. SIGINT asks it to stop after the current case; SIGTERM to stop now.
 * Nothing here asks a person anything: a decision it cannot make ends the
 * run as blocked, with its work saved.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { appendFile, realpath, rm, statfs, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { basename, join } from "node:path";
import { casesFromTasks } from "@core/auto/cases";
import { AutoRunEngine } from "@core/auto/engine";
import { AutoLedger } from "@core/auto/ledger";
import {
  type AutoPaths,
  acquireProjectLock,
  acquireRunnerLock,
  assertConfinedVm,
  endRunWithoutRunner,
  mirrorRepo,
  readRunFile,
  releaseProjectLock,
  runIsolation,
  runRepo,
  secureWorktreePointer,
} from "@core/auto/runs";
import { storeBoard } from "@core/goal/board";
import { frozenDecider, goalDriver } from "@core/goal/driver";
import { goalReport } from "@core/goal/report";
import { ReferencePacket } from "@core/goal/research";
import { nowIso } from "@core/ids";
import { PoundlockClient } from "@core/poundlock";
import { FileStore } from "@core/store";
import { autoProject, createAutoWorker } from "@runtime/auto-session";
import { isInferenceUnavailable } from "@runtime/auto-worker";
import { createPlanner, PLANNER_REASONING } from "@runtime/planner";
import { createTaskCheck } from "@runtime/task-check";
import { createWebTools } from "@runtime/web-tools";
import type { AutoOutcome } from "@shared/auto-run";
import { fallbackNotice, type ModelFallback } from "@shared/spending-limit";
import type { ConnectionSettings, InteractiveModel } from "@shared/types";
import { webSearchFor } from "@shared/web-search";

/** Below this, the runner stops the run now rather than fill the disk. */
const MIN_FREE_WHILE_RUNNING = 1024 ** 3;

export interface AutoRunnerDeps {
  paths: AutoPaths;
  connection(): Promise<ConnectionSettings>;
  fetch?: typeof fetch;
  docker?: string;
  dockerEnv?: NodeJS.ProcessEnv;
  /** Keep the Mac awake with caffeinate while the runner works (macOS only). */
  keepAwake?: boolean;
  heartbeatMs?: number;
  controlPollMs?: number;
  inferenceWaitsMs?: number[];
  /** The owner's home folder, which the VM must not mount. */
  home?: string;
}

export async function runAutoRunner(
  runDir: string,
  deps: AutoRunnerDeps,
): Promise<AutoOutcome | undefined> {
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";
  const run = await readRunFile(runDir);
  const log = (text: string) =>
    appendFile(join(runDir, "runner.log"), `${nowIso()} ${text}\n`).catch(() => undefined);
  const release = await acquireRunnerLock(runDir);
  const ledger = new AutoLedger(runDir);
  const isolationOptions = { docker: deps.docker, env: deps.dockerEnv };
  let activity = "starting";
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let caffeinate: ChildProcess | undefined;
  // The first signal asks the engine to stop (SIGINT after the case, SIGTERM now);
  // a second one exits at once, which the ledger and drafts are built to survive.
  let signals = 0;
  const onSignal = (command: "stop" | "stop_now") => () => {
    if (++signals > 1) process.exit(130);
    void ledger.writeControl(command, `signal-${Date.now()}`).catch(() => undefined);
  };
  const onSigint = onSignal("stop");
  const onSigterm = onSignal("stop_now");
  let diskWarned = false;
  try {
    const before = await ledger.state();
    if (before.outcome === "objective_met") {
      await log("already finished: every task verified");
      return before.outcome;
    }
    await acquireProjectLock(deps.paths, run.projectKey, run.runId);
    await log(before.runId ? "resuming" : "starting");
    heartbeat = setInterval(() => {
      void ledger.writeStatus({ pid: process.pid, activity }).catch(() => undefined);
      // The worktree is on this computer's disk: a runaway writer in the container must not fill it.
      void statfs(runDir)
        .then(async (disk) => {
          if (diskWarned || disk.bavail * disk.bsize >= MIN_FREE_WHILE_RUNNING) return;
          diskWarned = true;
          await log("stopping now: the disk is nearly full");
          await ledger.writeControl(
            "stop_now",
            `disk-${Date.now()}`,
            "the disk is nearly full: free space on this Mac, then resume the run",
          );
        })
        .catch(() => undefined);
    }, deps.heartbeatMs ?? 5000);
    await ledger.writeStatus({ pid: process.pid, activity });
    if (process.platform === "darwin" && deps.keepAwake !== false)
      caffeinate = spawn("caffeinate", ["-i", "-w", String(process.pid)], {
        stdio: "ignore",
      }).on("error", () => undefined);
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    const connection = await deps.connection();
    if (!connection.url || !connection.token)
      throw new Error("No Poundlock connection is saved on this machine.");
    const client = new PoundlockClient(connection.url, connection.token, deps.fetch);
    const model = (await client.listInteractiveModels()).find(
      (m) => (run.profileId && m.profileId === run.profileId) || m.id === run.model,
    );
    if (!model) throw new Error(`Poundlock no longer offers ${run.model}.`);
    if (
      run.routingRevision &&
      model.routingRevision &&
      model.routingRevision !== run.routingRevision
    )
      throw new Error(
        `The route of ${run.model} changed in Poundlock since the run started. Review it, then start a new run.`,
      );
    const capabilities = await client.capabilities().catch(() => undefined);
    // The goal's Planner, on the route the owner approved at start (ADR 016).
    let plannerModel: InteractiveModel | undefined;
    if (run.goal) {
      const wanted = run.goal.planner;
      plannerModel = (await client.listInteractiveModels()).find(
        (m) => (wanted.profileId && m.profileId === wanted.profileId) || m.id === wanted.model,
      );
      if (!plannerModel)
        throw new Error(`Poundlock no longer offers the Planner, ${wanted.model}.`);
      if (
        wanted.routingRevision &&
        plannerModel.routingRevision &&
        plannerModel.routingRevision !== wanted.routingRevision
      )
        throw new Error(
          `The Planner's route (${wanted.model}) changed in Poundlock since the run started. Review it, then start a new run.`,
        );
      if ((plannerModel.dataDestination ?? "unknown") !== wanted.destination)
        throw new Error(
          `The Planner, ${wanted.model}, now sends code to ${plannerModel.dataDestination ?? "an unknown destination"}, not ${wanted.destination} as agreed. Start a new run.`,
        );
    }
    // The owner's local fallback for a cloud role refused for a spending limit;
    // a switch made before a resume holds for the rest of the run.
    const fallback = await localFallback(connection, await client.listInteractiveModels(), log);
    const resumedOn = (role: ModelFallback["role"]) =>
      fallback && before.fallbacks?.some((item) => item.role === role) ? fallback : undefined;
    const onFallback = async (event: ModelFallback) => {
      await ledger.append({ type: "model_fallback", ...event });
      activity = fallbackNotice(event);
      await log(activity);
    };
    const workerOn = resumedOn("worker");
    const plannerOn = resumedOn("planner");
    const isolation = runIsolation(run, isolationOptions);
    activity = "starting the container";
    await isolation.check();
    // Checked on every start: the VM may have been reconfigured since the run began.
    const vmWarning = await assertConfinedVm(run, isolation, {
      home: await realpath(deps.home ?? homedir()),
      autoRoot: await realpath(deps.paths.root),
    });
    if (vmWarning) await log(vmWarning);
    await isolation.start();
    // A killed runner can leave its last command running, and a lost Git lock;
    // clear both before any draft is saved. This runner holds the run alone.
    await isolation.killAll();
    await rm(join(run.gitDir, "index.lock"), { force: true });

    const taskCheck = run.goal
      ? createTaskCheck({
          controllerUrl: connection.url,
          token: connection.token,
          model: workerOn ?? model,
        })
      : undefined;
    const worker = createAutoWorker({
      project: autoProject({
        runId: run.runId,
        worktree: run.worktree,
        baseCommit: run.baseCommit,
        createdAt: run.createdAt,
        checks: run.checks,
        protectedPaths: run.scope.protectedPaths ?? [],
      }),
      model: workerOn ?? model,
      lastApprovedRoutingRevision: workerOn?.routingRevision ?? run.routingRevision,
      ...(fallback ? { fallback, onFallback } : {}),
      controllerUrl: connection.url,
      token: connection.token,
      capabilities,
      isolation,
      runDir,
      checks: run.checks,
      prepare: run.prepare,
      allowDependencyDownloads: run.allowDependencyDownloads,
      writable: run.scope.writable,
      commandMs: run.limits.commandMinutes * 60_000,
      stallMs: run.limits.stallMinutes * 60_000,
      onActivity: (text) => {
        activity = text;
      },
    });
    // Tasks the owner or the manager adds to the board join the run between cases.
    const board = run.board ? new FileStore(run.board.storeRoot) : undefined;
    const boardProject = run.board?.projectId ?? "";
    const driverOptions =
      run.goal && board && plannerModel
        ? {
            planner: createPlanner({
              controllerUrl: connection.url,
              token: connection.token,
              model: plannerOn ?? plannerModel,
              reasoning: PLANNER_REASONING,
              capabilities,
              lastApprovedRoutingRevision:
                plannerOn?.routingRevision ?? run.goal.planner.routingRevision,
              ...(fallback ? { fallback, onFallback } : {}),
              worktree: run.worktree,
              project: autoProject({
                runId: run.runId,
                worktree: run.worktree,
                baseCommit: run.baseCommit,
                createdAt: run.createdAt,
                checks: run.checks,
                protectedPaths: run.scope.protectedPaths ?? [],
              }),
              dir: join(runDir, "planner"),
              ...(run.goal.webSearch
                ? {
                    web: createWebTools({
                      settings: run.goal.webSearch,
                      // Never searched for: the folder's name, this machine, its user.
                      privateTerms: [basename(run.source), hostname(), userInfo().username],
                      // The project's switch is asked again before each call.
                      enabled: async () =>
                        webSearchFor(
                          (await deps.connection()).webSearch,
                          (await board.getProject(boardProject))?.policy,
                        ) !== undefined,
                      onCall: (record) =>
                        void ledger.append({ type: "web_call", ...record }).catch(() => undefined),
                    }),
                  }
                : {}),
              onActivity: (text) => {
                activity = text;
                void log(text);
              },
            }),
            board: storeBoard(board, boardProject),
            ledger,
            checks: run.checks,
            workerMinutes: run.limits.caseMinutes,
            ...(run.carriedOver?.length ? { carriedOver: run.carriedOver } : {}),
            checkpoint: run.goal.checkpoint,
            advisory: run.goal.advisory,
            spendCapUsd: run.goal.spendCapUsd,
            // What a gating Planner reads on the web is kept for the workers (roadmap item 2).
            ...(run.goal.webSearch && !run.goal.advisory
              ? { packet: new ReferencePacket(join(runDir, "references.json")) }
              : {}),
            isUnavailable: (error: unknown) =>
              isInferenceUnavailable(error instanceof Error ? error.message : String(error)),
            onActivity: (text: string) => {
              activity = text;
              void log(text);
            },
          }
        : undefined;
    const whenIdle = driverOptions ? goalDriver(driverOptions) : undefined;
    const onFrozenBlocked =
      driverOptions && !driverOptions.advisory ? frozenDecider(driverOptions) : undefined;
    const engine = new AutoRunEngine({
      runId: run.runId,
      ledger,
      worker,
      verifier: worker,
      preparer: run.prepare.length ? worker : undefined,
      repo: runRepo(run),
      mirror: mirrorRepo(run),
      runsRoot: run.runsRoot,
      scope: run.scope,
      frozenTests: run.frozenTests,
      mutationCheck: run.mutationCheck,
      ...(taskCheck ? { taskCheck } : {}),
      ...(board
        ? {
            newCases: async () =>
              casesFromTasks(await board.getTasks(boardProject), new Set(run.leftOut ?? [])),
          }
        : {}),
      ...(whenIdle ? { whenIdle } : {}),
      ...(onFrozenBlocked ? { onFrozenBlocked } : {}),
      ...(run.greenfield ? { greenfield: true } : {}),
      ...(run.goal ? { repairsBase: true } : {}),
      ...(run.allowDependencyDownloads ? { installsDependencies: true } : {}),
      ...(run.acceptAlreadyMet ? { acceptsAlreadyMet: true } : {}),
      controlPollMs: deps.controlPollMs,
      inferenceWaitsMs: deps.inferenceWaitsMs,
      onActivity: (text) => {
        activity = text;
        void log(text);
      },
    });
    const outcome = before.runId
      ? await engine.resume()
      : await engine.start({
          cases: run.cases,
          limits: run.limits,
          model: model.id,
          isolation: isolation.description,
        });
    await log(`ended: ${outcome}`);
    await writeFile(
      join(runDir, "report.md"),
      goalReport(
        run,
        await ledger.state(),
        board && run.board ? await board.getPlan(run.board.projectId) : undefined,
        await new ReferencePacket(join(runDir, "references.json")).all(),
      ),
      { mode: 0o600 },
    ).catch((error) => log(`could not write the report: ${String(error)}`));
    return outcome;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await log(`runner error: ${error instanceof Error ? error.stack : reason}`);
    // A run the runner could not work ends as blocked, its lock released, ready to resume.
    await endRunWithoutRunner(
      runDir,
      deps.paths,
      { outcome: "blocked_for_input", reason },
      isolationOptions,
    ).catch((cleanup) => log(`could not end the run: ${String(cleanup)}`));
    return undefined;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    activity = "stopped";
    const state = await ledger.writeStatus({ pid: process.pid, activity }).catch(() => undefined);
    if (state?.outcome) {
      await runIsolation(run, isolationOptions)
        .remove()
        .catch(() => undefined);
      const pointer = await secureWorktreePointer(run).catch(
        (error) => `could not check the worktree's .git: ${String(error)}`,
      );
      if (pointer) await log(pointer);
      await releaseProjectLock(deps.paths, run.projectKey, run.runId);
    }
    caffeinate?.kill();
    await release();
  }
}

/** The owner's local fallback, if Poundlock still offers it on their own network. */
async function localFallback(
  connection: ConnectionSettings,
  models: InteractiveModel[],
  log: (text: string) => Promise<unknown>,
): Promise<InteractiveModel | undefined> {
  const binding = connection.roles.fallback;
  if (!binding) return undefined;
  const model = models.find((item) => (item.profileId ?? item.id) === binding.profileId);
  if (!model) {
    await log(
      `Poundlock no longer offers the local fallback ${binding.profileName}: a spending refusal stops this run.`,
    );
    return undefined;
  }
  if (model.dataDestination !== "operator_network") {
    await log(
      `The local fallback ${model.id} no longer runs on your own network: a spending refusal stops this run.`,
    );
    return undefined;
  }
  return model;
}
