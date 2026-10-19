import { mkdir, realpath, rm, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AutoCase,
  type AutoLimits,
  DEFAULT_AUTO_LIMITS,
  hardHoursFor,
  reduceAutoEvents,
  unfinishedLine,
} from "@shared/auto-run";
import { autopilotPlannerFor } from "@shared/autopilot-tier";
import { requireInteractiveLimits } from "@shared/roles";
import type { ConnectionSettings, InteractiveModel, ProjectRecord } from "@shared/types";
import { webSearchFor } from "@shared/web-search";
import { frozenTestsIn } from "../frozen-tests";
import { runGit } from "../git";
import { PoundlockClient } from "../poundlock";
import { projectWorkerRoles, resolveVerifierProfile } from "../role-routing";
import type { FileStore } from "../store";
import { casesFromTasks, validateCases } from "./cases";
import { createRunWorktree, ensureMirror, MirrorRepo } from "./checkpoint-git";
import { AutoLedger } from "./ledger";
import {
  AUTO_DOCKER_CONTEXT,
  type AutoBoard,
  type AutoGoal,
  type AutoPaths,
  type AutoRunFile,
  acquireProjectLock,
  assertConfinedVm,
  newRunId,
  projectKey,
  releaseProjectLock,
  runIsolation,
  runsForSource,
  writeRunFile,
} from "./runs";
import type { AutoScope } from "./scope";

/** A frontier Planner's spend cap when the owner sets none: about 70 milestone plans (Phase 0). */
export const DEFAULT_PLANNER_SPEND_CAP_USD = 5;

/** Most tasks a goal may run: about 18 per milestone over several milestones (Phase 0). */
export const GOAL_MAX_CASES = 400;

/** Auto mode needs a long context: one case per session, and compaction lost work at 64K. */
export const MIN_CONTEXT_TOKENS = 128_000;
/** Room for the mirror, drafts, logs and what the checks write, before the mirror's own size. */
export const MIN_FREE_BYTES = 5 * 1024 ** 3;

/** A plan file for `auto start --plan`: the cases, and optionally checks, setup and scope. */
export interface AutoPlanFile {
  cases: AutoCase[];
  checks?: string[];
  prepare?: string[];
  scope?: AutoScope;
  profile?: string;
  /** Test files to keep fixed from the start. */
  frozenTests?: string[];
  /** Run the mutation check on each case. Off unless asked for; a board run follows the project. */
  mutationCheck?: boolean;
  /** Set for a plan taken from the project's board, never read from a plan file. */
  board?: AutoBoard;
  /** Board tasks earlier runs gave up, which this run leaves to its Planner. */
  leftOut?: string[];
  /** The last run's unfinished tasks and why, for this run's first review. */
  carriedOver?: string[];
  /** The board's plan has milestones: the Planner works the goal. */
  milestones?: boolean;
}

export interface AutoStartRequest {
  /** The project folder: a Git repository's top level. */
  dir: string;
  plan?: AutoPlanFile;
  profile?: string;
  image: string;
  /** The Docker context; colima's `dispatch-auto` profile when unset. */
  dockerContext?: string;
  /** Run even though the VM can see the owner's home folder. */
  allowHomeInVm?: boolean;
  checks?: string[];
  prepare?: string[];
  allowDependencyDownloads?: boolean;
  acceptAlreadyMet?: boolean;
  limits?: { hours?: number; caseMinutes?: number; maxCases?: number; maxTokens?: number };
  /** Where the run may write, over the plan's own scope. */
  scope?: AutoScope;
  /** For a plan with milestones (ADR 016). */
  goal?: {
    checkpoint?: "notify" | "wait";
    allowPlannerDestination?: string;
    plannerSpendCapUsd?: number;
  };
}

export interface AutoStartDeps {
  paths: AutoPaths;
  /** The saved connection (controller, token, roles). */
  connection(): Promise<ConnectionSettings>;
  /** The Dispatch project for this folder, if the terminal client has opened it. */
  project(source: string): Promise<{ project: ProjectRecord; store: FileStore } | undefined>;
  /** Start the detached runner for a created run. */
  spawnRunner(runDir: string): void;
  fetch?: typeof fetch;
  docker?: string;
  dockerEnv?: NodeJS.ProcessEnv;
  freeBytes?: (path: string) => Promise<number>;
  now?: () => Date;
  /** The owner's home folder, which the VM must not mount. */
  home?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

async function freeBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/**
 * What the folder's earlier runs left: the tasks any of them gave up, found
 * blocked or skipped (a task applied since is not a case anyway), the tests they froze,
 * which stay frozen once their work is merged into the folder, and the tasks
 * they accepted whose commits the folder already has.
 */
async function previousRuns(
  paths: AutoPaths,
  source: string,
): Promise<{ gaveUp: Set<string>; frozen: string[]; carriedOver: string[]; merged: Set<string> }> {
  const gaveUp = new Set<string>();
  const frozen = new Set<string>();
  const merged = new Set<string>();
  // The report says to fast-forward the folder to the run's branch, and an owner who
  // does that by hand never presses Merge, so the board would offer the accepted
  // tasks again.
  const history = new Set((await git(source, ["rev-list", "HEAD"]).catch(() => "")).split("\n"));
  // Why the newest run that worked tasks left some unfinished: its next run's
  // first review needs that, such as which frozen tests a fix kept breaking.
  let carriedOver: string[] | undefined;
  for (const run of await runsForSource(paths, source)) {
    const entries = await new AutoLedger(run.runDir).read().catch(() => []);
    const cases = reduceAutoEvents(entries).cases;
    if (!carriedOver && cases.some((item) => item.stage !== "pending"))
      carriedOver = cases
        .filter((item) => item.stage === "abandoned" || item.stage === "blocked")
        .map((item) => unfinishedLine(item.title, item));
    for (const item of cases) {
      if (item.stage === "abandoned" || item.stage === "blocked" || item.stage === "skipped")
        gaveUp.add(item.id);
      const last = item.checkpoints.at(-1);
      if (item.stage === "accepted" && last && history.has(last)) merged.add(item.id);
    }
    for (const { event } of entries)
      if (event.type === "frozen") for (const path of event.paths) frozen.add(path);
  }
  return { gaveUp, frozen: [...frozen], carriedOver: carriedOver ?? [], merged };
}

/** Accepted tasks whose commits the folder has are applied, as Merge would record. */
async function markMerged(
  found: { project: ProjectRecord; store: FileStore } | undefined,
  merged: ReadonlySet<string>,
): Promise<void> {
  if (!found || !merged.size) return;
  const tasks = await found.store.getTasks(found.project.id);
  const applied = tasks.filter(
    (task) => merged.has(task.id) && task.status !== "applied" && task.status !== "cancelled",
  );
  if (!applied.length) return;
  for (const task of applied) task.status = "applied";
  await found.store.saveTasks(found.project.id, tasks);
}

/** The approved plan of the folder's Dispatch project, frozen as cases. */
export async function planFromProject(
  found: { project: ProjectRecord; store: FileStore } | undefined,
  previous: { gaveUp: ReadonlySet<string>; frozen: string[]; carriedOver?: string[] } = {
    gaveUp: new Set(),
    frozen: [],
  },
): Promise<AutoPlanFile> {
  if (!found)
    throw new Error(
      "This folder has no Dispatch project yet. Plan with the manager and approve the plan, or pass --plan <file>.",
    );
  const plan = await found.store.getPlan(found.project.id);
  if (!plan?.approved)
    throw new Error("This folder has no approved plan. Approve one first, or pass --plan <file>.");
  const frozenTests = [
    ...new Set([...frozenTestsIn(plan.frozenTests).map((test) => test.path), ...previous.frozen]),
  ];
  // A goal's Planner replans what the last run gave up, with what it accepted in view:
  // re-running those tasks first would repeat superseded work.
  const leaveOut = plan.milestones?.length ? previous.gaveUp : new Set<string>();
  return {
    ...(leaveOut.size ? { leftOut: [...leaveOut] } : {}),
    ...(plan.milestones?.length && previous.carriedOver?.length
      ? { carriedOver: previous.carriedOver }
      : {}),
    cases: casesFromTasks(await found.store.getTasks(found.project.id), leaveOut),
    checks: plan.verificationCommands,
    ...(frozenTests.length ? { frozenTests } : {}),
    mutationCheck: found.project.policy.mutationCheck !== false,
    board: { storeRoot: found.store.layout.root, projectId: found.project.id },
    ...(plan.milestones?.length ? { milestones: true } : {}),
  };
}

/** Files a project can start from before there is anything to build or check. */
const STARTER_FILE =
  /^(readme|license|copying|changelog|notice)(\.[a-z]+)?$|^\.git(ignore|attributes)$|\.md$|^docs\//i;

/** A repository holding only a README, a licence, notes and the like. */
export async function isGreenfield(source: string): Promise<boolean> {
  const files = (await git(source, ["ls-tree", "-r", "--name-only", "HEAD"]))
    .split("\n")
    .filter(Boolean);
  return files.every((file) => STARTER_FILE.test(file));
}

/** The limits a request asks for, with the hard limit derived from the soft one. */
export function limitsFor(request: AutoStartRequest["limits"] = {}): AutoLimits {
  const softHours = request.hours ?? DEFAULT_AUTO_LIMITS.softHours;
  const caseMinutes = request.caseMinutes ?? DEFAULT_AUTO_LIMITS.caseMinutes;
  return {
    ...DEFAULT_AUTO_LIMITS,
    softHours,
    caseMinutes,
    hardHours: hardHoursFor(softHours, caseMinutes),
    maxCases: request.maxCases ?? DEFAULT_AUTO_LIMITS.maxCases,
    ...(request.maxTokens ? { maxProcessedTokens: request.maxTokens } : {}),
  };
}

function findProfile(models: InteractiveModel[], name: string): InteractiveModel | undefined {
  return models.find(
    (model) => model.id === name || model.profileId === name || model.aliases?.includes(name),
  );
}

/**
 * Everything auto mode checks before it takes the folder's lock, and then
 * the run itself: its mirror, worktree and run file. The slow part of the
 * preflight (setup and the plan's checks at the base commit) belongs to the
 * runner, which records it in the ledger before any case starts.
 */
export async function startAutoRun(
  request: AutoStartRequest,
  deps: AutoStartDeps,
): Promise<{ runDir: string; run: AutoRunFile; model: InteractiveModel; warnings: string[] }> {
  const folder = await realpath(request.dir).catch(() => {
    throw new Error(`${request.dir} is not a folder.`);
  });
  const top = await git(folder, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new Error(`${folder} is not a Git repository. Auto mode works on commits.`);
  });
  const source = await realpath(top);
  if (source !== folder)
    throw new Error(`Auto mode runs a whole repository: use its top folder, ${source}.`);
  if (await git(source, ["status", "--porcelain", "--untracked-files=no"]))
    throw new Error(
      "The folder has uncommitted changes to tracked files. Commit or stash them: the run starts from HEAD.",
    );
  const baseCommit = await git(source, ["rev-parse", "HEAD"]);

  const found = await deps.project(source);
  // A plan file never names a board: only the project's own plan joins its tasks.
  let plan: AutoPlanFile;
  if (request.plan) plan = { ...request.plan, board: undefined };
  else {
    const previous = await previousRuns(deps.paths, source);
    await markMerged(found, previous.merged);
    plan = await planFromProject(found, previous);
  }
  // A goal may start with nothing to run: its Planner reviews the milestone first.
  if (plan.cases.length || !(plan.board && plan.milestones)) validateCases(plan.cases);
  const checks = request.checks?.length
    ? request.checks
    : plan.checks?.length
      ? plan.checks
      : (found?.project.policy.verification.commands ?? []);
  if (!checks.length)
    throw new Error("Auto mode needs the plan's checks: acceptance depends on them. Pass --check.");
  const scope: AutoScope = {
    ...plan.scope,
    ...request.scope,
    protectedPaths: [
      ...(plan.scope?.protectedPaths ?? []),
      ...(request.scope?.protectedPaths ?? []),
      ...(found?.project.policy.verification.protectedPaths ?? []),
    ],
  };

  const connection = await deps.connection();
  if (!connection.url || !connection.token)
    throw new Error("No Poundlock connection is saved. Run /connect in the terminal client first.");
  const client = new PoundlockClient(connection.url, connection.token, deps.fetch);
  const models = await client.listInteractiveModels();
  const wanted =
    request.profile ??
    plan.profile ??
    (found
      ? projectWorkerRoles(connection.roles, found.project.policy).interactive?.profileId
      : connection.roles.interactive?.profileId);
  if (!wanted) throw new Error("Choose the worker profile with --profile.");
  const model = findProfile(models, wanted);
  if (!model)
    throw new Error(
      `Poundlock does not offer ${wanted}. It offers: ${models.map((m) => m.id).join(", ") || "nothing"}.`,
    );
  const { contextTokens } = requireInteractiveLimits(model);
  if (contextTokens < MIN_CONTEXT_TOKENS)
    throw new Error(
      `${model.id} has a ${contextTokens}-token context; auto mode needs at least ${MIN_CONTEXT_TOKENS}.`,
    );
  if (model.dataDestination !== "operator_network")
    throw new Error(
      `${model.id} does not run on the operator's network (${model.dataDestination ?? "unknown"}). An unattended run sends project source to its model, so auto mode uses only operator-network profiles.`,
    );
  const allowed = found?.project.policy.allowedWorkerProfileIds ?? [];
  if (
    allowed.length &&
    !allowed.includes(model.profileId ?? model.id) &&
    !allowed.includes(model.id)
  )
    throw new Error(`${model.id} is not one of this project's allowed worker profiles.`);
  if (model.status === "disabled")
    throw new Error(`${model.id} is disabled in Poundlock: ${model.disabled?.reason ?? ""}`.trim());
  // A goal's Planner: the Verifier when bound, else the worker, advising only.
  let goal: AutoGoal | undefined;
  if (plan.board && plan.milestones) {
    const webSearch = webSearchFor(connection.webSearch, found?.project.policy);
    const planner = autopilotPlannerFor(resolveVerifierProfile(models, connection.roles), model);
    const destination = planner.model.dataDestination ?? "unknown";
    if (planner.external && !planner.model.pricing)
      throw new Error(
        `The Planner, ${planner.model.id}, has no price in Poundlock's catalog, so its spend cannot be capped. Refresh the catalog in Poundlock, or choose a Verifier with a price.`,
      );
    if (planner.external && request.goal?.allowPlannerDestination !== destination)
      throw new Error(
        `The Planner, ${planner.model.id}, would send excerpts of this project's code to ${destination}. Agree to that when you start Autopilot, or choose a Verifier on the operator's network.`,
      );
    goal = {
      checkpoint: request.goal?.checkpoint ?? "notify",
      planner: {
        model: planner.model.id,
        profileId: planner.model.profileId,
        routingRevision: planner.model.routingRevision,
        destination,
      },
      advisory: planner.advisory,
      // A Planner that bills gets a cap: the owner's, or a small default.
      ...(planner.external
        ? { spendCapUsd: request.goal?.plannerSpendCapUsd ?? DEFAULT_PLANNER_SPEND_CAP_USD }
        : {}),
      // Web search only where the owner set up an instance and the project turned it on.
      ...(webSearch ? { webSearch } : {}),
    };
  }
  const capabilities = await client.capabilities().catch(() => undefined);
  if (capabilities?.features.includes("access_preflight"))
    await client.preflight({
      model: model.id,
      operation: "inference",
      profileId: model.profileId ?? model.id,
      destination: model.dataDestination,
    });

  const runId = newRunId(deps.now?.());
  const key = projectKey(source);
  const runDir = deps.paths.runDir(runId);
  const run: AutoRunFile = {
    version: 1,
    runId,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    source,
    projectKey: key,
    baseCommit,
    branch: `auto/${runId}`,
    mirror: deps.paths.mirrorFor(key),
    runsRoot: deps.paths.runs,
    worktree: join(runDir, "work"),
    gitDir: "",
    cases: plan.cases,
    // A goal plans its tasks as it goes: a milestone of about 18, several milestones.
    limits: goal
      ? { ...limitsFor(request.limits), maxCases: request.limits?.maxCases ?? GOAL_MAX_CASES }
      : limitsFor(request.limits),
    scope,
    checks,
    prepare: request.prepare?.length ? request.prepare : (plan.prepare ?? []),
    allowDependencyDownloads: request.allowDependencyDownloads ?? false,
    ...(request.acceptAlreadyMet ? { acceptAlreadyMet: true } : {}),
    model: model.id,
    profileId: model.profileId,
    routingRevision: model.routingRevision,
    image: request.image,
    dockerContext: request.dockerContext ?? AUTO_DOCKER_CONTEXT,
    ...(request.allowHomeInVm ? { allowHomeInVm: true } : {}),
    container: `dispatch-${runId}`,
    ...(plan.board ? { board: plan.board } : {}),
    ...(plan.frozenTests?.length ? { frozenTests: plan.frozenTests } : {}),
    ...(plan.mutationCheck ? { mutationCheck: true } : {}),
    ...(goal ? { goal } : {}),
    ...(goal && (await isGreenfield(source)) ? { greenfield: true } : {}),
    ...(plan.leftOut?.length ? { leftOut: plan.leftOut } : {}),
    ...(plan.carriedOver?.length ? { carriedOver: plan.carriedOver } : {}),
  };

  const { imageId } = await runIsolation(run, { docker: deps.docker, env: deps.dockerEnv }).check();
  run.imageId = imageId;
  const isolation = runIsolation(run, { docker: deps.docker, env: deps.dockerEnv });
  await mkdir(deps.paths.runs, { recursive: true, mode: 0o700 });
  const vmWarning = await assertConfinedVm(run, isolation, {
    home: await realpath(deps.home ?? homedir()),
    autoRoot: await realpath(deps.paths.root),
  });
  const size = Number(
    /size-pack: (\d+)/.exec(await git(source, ["count-objects", "-v"]))?.[1] ?? 0,
  );
  const needed = MIN_FREE_BYTES + size * 1024 * 2;
  const free = await (deps.freeBytes ?? freeBytes)(deps.paths.root);
  if (free < needed)
    throw new Error(`Auto mode needs ${gb(needed)} free for this run; there is ${gb(free)}.`);

  await acquireProjectLock(deps.paths, key, runId);
  try {
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    // Written at once, so the lock's run is known while the mirror is made.
    await writeRunFile(runDir, run);
    await ensureMirror(source, run.mirror, baseCommit);
    // Real paths: the container mounts them as they are.
    run.mirror = await realpath(run.mirror);
    const repo = await createRunWorktree(
      new MirrorRepo(run.mirror),
      run.worktree,
      run.branch,
      baseCommit,
    );
    run.worktree = await realpath(repo.worktree);
    run.gitDir = repo.gitDir;
    await writeRunFile(runDir, run);
  } catch (error) {
    await new MirrorRepo(run.mirror)
      .run(["worktree", "remove", "--force", run.worktree])
      .catch(() => undefined);
    await rm(runDir, { recursive: true, force: true });
    await releaseProjectLock(deps.paths, key, runId);
    throw error;
  }
  deps.spawnRunner(runDir);
  return { runDir, run, model, warnings: vmWarning ? [vmWarning] : [] };
}
