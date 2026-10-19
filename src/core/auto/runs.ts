import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type AutoCase,
  type AutoLimits,
  type AutoOutcome,
  type AutoRunState,
  autoProgressView,
  OUTCOME_LABELS,
} from "@shared/auto-run";
import { writeJsonAtomic } from "../atomic-write";
import { oneLine } from "./cases";
import {
  type ExportedPatch,
  exportPatch,
  MirrorRepo,
  RunRepo,
  restoreWorktreePointer,
  saveDraft,
  worktreePointerIntact,
} from "./checkpoint-git";
import { type AutoIsolation, dockerIsolation } from "./isolation";
import { AutoLedger } from "./ledger";
import { type AutoScope, runsOnHost } from "./scope";
import { vmFirewallCommand } from "./vm-firewall";

/**
 * A local auto run on disk (ADR 014). Everything lives under Dispatch's data
 * folder, never in the project:
 *
 *   auto/mirrors/<project>.git     a bare mirror of each project
 *   auto/locks/<project>.lock      held while a run of that project is unfinished
 *   auto/runs/<run>/run.json       what was asked for (no token)
 *   auto/runs/<run>/events.jsonl   the ledger, the source of truth
 *   auto/runs/<run>/status.json    a heartbeat and the derived state
 *   auto/runs/<run>/runner.pid     the runner holding the run
 *   auto/runs/<run>/runner.log     what the runner did
 *   auto/runs/<run>/work           the run's worktree, on branch auto/<run>
 */
export interface AutoRunFile {
  version: 1;
  runId: string;
  createdAt: string;
  /** The project folder, a Git repository's top level. Only ever read. */
  source: string;
  projectKey: string;
  baseCommit: string;
  branch: string;
  mirror: string;
  runsRoot: string;
  worktree: string;
  /** The worktree's Git directory, read when it was created; never taken from the worktree again. */
  gitDir: string;
  cases: AutoCase[];
  limits: AutoLimits;
  scope: AutoScope;
  checks: string[];
  prepare: string[];
  allowDependencyDownloads: boolean;
  /** Accept a task whose work is already in the code (an owner setting, off by default). */
  acceptAlreadyMet?: boolean;
  /** The Poundlock profile: its name, stable id and the route that was approved. */
  model: string;
  profileId?: string;
  routingRevision?: string;
  image: string;
  /** The image's ID when the run started; its containers are made from exactly this. */
  imageId?: string;
  /** The Docker context the run's containers use; a VM that mounts only the auto folder. */
  dockerContext?: string;
  /** The owner chose to run on a VM that can see their home folder (M11). */
  allowHomeInVm?: boolean;
  container: string;
  /** The Dispatch project whose board the run works: tasks added there join the run. */
  board?: AutoBoard;
  /** Test files frozen before the run (the plan's accepted tests-first work). */
  frozenTests?: string[];
  /** Break each case's new code a little and require a check to notice (ADR 016). */
  mutationCheck?: boolean;
  /** A spec with milestones: the Planner plans and reviews each one (ADR 016). */
  goal?: AutoGoal;
  /** A goal begun in a repository with nothing to check yet: the base checks are skipped. */
  greenfield?: boolean;
  /** Board tasks earlier runs gave up: never joined as new cases; the Planner replans them. */
  leftOut?: string[];
  /** The previous run's unfinished tasks and why, shown to this run's first review. */
  carriedOver?: string[];
}

export interface AutoGoal {
  /** After a verified milestone: go on (notify), or stop until resumed (wait). */
  checkpoint: "notify" | "wait";
  /** The Planner, the route approved for it, and where it sends the project's code. */
  planner: { model: string; profileId?: string; routingRevision?: string; destination: string };
  /** The Local tier: its verdicts advise but do not gate. */
  advisory: boolean;
  /** The most the Planner may cost over the goal, by the catalog's estimate. */
  spendCapUsd?: number;
  /** The project turned web search on: the Planner searches through this instance. */
  webSearch?: import("@shared/web-search").WebSearchSettings;
}

/** Where a board run reads its project's tasks: the store's root folder and the project. */
export interface AutoBoard {
  storeRoot: string;
  projectId: string;
}

/** The Docker context of colima's `dispatch-auto` profile, which auto mode uses unless told otherwise. */
export const AUTO_DOCKER_CONTEXT = "colima-dispatch-auto";

/** How the owner makes the VM auto mode wants: its own colima profile, mounting only the auto folder. */
export function dedicatedVmCommand(autoRoot: string): string {
  // The folder is under "Application Support" on macOS, so it is quoted.
  const quoted = `'${autoRoot.replaceAll("'", "'\\''")}'`;
  const mount = `'${`${autoRoot}:w`.replaceAll("'", "'\\''")}'`;
  return `mkdir -p ${quoted} && colima start --profile dispatch-auto --cpu 4 --memory 8 --mount ${mount} && ${vmFirewallCommand()}`;
}

/**
 * Refuse a VM that can see the owner's home folder beyond the auto folder: a
 * single container escape would reach all of it, for as long as an unattended
 * run lasts. With the owner's explicit override, return the warning instead.
 */
export async function assertConfinedVm(
  run: AutoRunFile,
  isolation: AutoIsolation,
  where: { home: string; autoRoot: string },
): Promise<string | undefined> {
  const exposed = await isolation.exposure(where.home, where.autoRoot);
  if (!exposed.length) return undefined;
  const shown = exposed
    .slice(0, 3)
    .map((path) => `~${path.slice(where.home.length)}`)
    .join(", ");
  const context = run.dockerContext ? `the VM of Docker context ${run.dockerContext}` : "the VM";
  const problem = `Containers on ${context} can reach your home folder (${shown}${
    exposed.length > 3 ? ", …" : ""
  }), so one container escape would reach it for the whole run.`;
  if (run.allowHomeInVm) return `Warning: ${problem} Running anyway, as --allow-home-in-vm asked.`;
  throw new Error(
    `${problem} Auto mode needs a VM that mounts only ${where.autoRoot}. Make one with: ${dedicatedVmCommand(
      where.autoRoot,
    )}, put the toolchain image in it, and use --docker-context ${AUTO_DOCKER_CONTEXT} (the default). To run on this VM anyway, pass --allow-home-in-vm.`,
  );
}

export class AutoPaths {
  readonly root: string;
  readonly mirrors: string;
  readonly runs: string;
  readonly locks: string;

  constructor(dataRoot: string) {
    this.root = join(dataRoot, "auto");
    this.mirrors = join(this.root, "mirrors");
    this.runs = join(this.root, "runs");
    this.locks = join(this.root, "locks");
  }

  runDir(runId: string): string {
    return join(this.runs, runId);
  }

  mirrorFor(key: string): string {
    return join(this.mirrors, `${key}.git`);
  }

  lockFor(key: string): string {
    return join(this.locks, `${key}.lock`);
  }
}

export function projectKey(source: string): string {
  return createHash("sha256").update(resolve(source)).digest("hex").slice(0, 16);
}

/** A run id that sorts by time and reads well in a branch or container name. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `auto-${stamp}-${randomBytes(2).toString("hex")}`;
}

export async function readRunFile(runDir: string): Promise<AutoRunFile> {
  return JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as AutoRunFile;
}

export async function writeRunFile(runDir: string, run: AutoRunFile): Promise<void> {
  await writeJsonAtomic(join(runDir, "run.json"), run);
}

export const runRepo = (run: AutoRunFile) => new RunRepo(run.worktree, run.gitDir);
export const mirrorRepo = (run: AutoRunFile) => new MirrorRepo(run.mirror);

/** The run's container, from what the run asked for. */
export function runIsolation(
  run: AutoRunFile,
  options: { docker?: string; env?: NodeJS.ProcessEnv } = {},
): AutoIsolation {
  return dockerIsolation({
    docker: options.docker,
    env: options.env,
    context: run.dockerContext,
    image: run.image,
    imageId: run.imageId,
    name: run.container,
    worktree: run.worktree,
    readOnly: [run.mirror],
  });
}

/** A process's command line: from /proc where there is one (Linux), else from ps (macOS). */
async function commandOf(pid: number): Promise<string | undefined> {
  const proc = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => undefined);
  if (proc !== undefined) return proc.split("\0").join(" ").trim();
  return new Promise((done) =>
    execFile("ps", ["-o", "command=", "-p", String(pid)], (error, stdout) =>
      done(error ? undefined : stdout.trim()),
    ),
  );
}

export async function runnerPid(runDir: string): Promise<number | undefined> {
  const pid = Number((await readFile(join(runDir, "runner.pid"), "utf8").catch(() => "")).trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Whether this run's runner is alive: its pid exists and is still that runner, not a reused pid. */
export async function runnerAlive(runDir: string): Promise<boolean> {
  const pid = await runnerPid(runDir);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const command = await commandOf(pid);
  return command === undefined || command.includes(runDir);
}

/** Hold the run for this process. A second runner is refused while the first is alive. */
export async function acquireRunnerLock(runDir: string): Promise<() => Promise<void>> {
  const file = join(runDir, "runner.pid");
  if (existsSync(file)) {
    if (await runnerAlive(runDir))
      throw new Error(`Another runner (pid ${await runnerPid(runDir)}) holds this run.`);
    await rm(file, { force: true });
  }
  // Linked in whole, so a second runner never reads an empty pid file and takes over.
  const pending = `${file}.${process.pid}`;
  await writeFile(pending, String(process.pid), { mode: 0o600 });
  try {
    await link(pending, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(`Another runner (pid ${await runnerPid(runDir)}) holds this run.`);
    throw error;
  } finally {
    await rm(pending, { force: true });
  }
  return async () => {
    if ((await runnerPid(runDir)) === process.pid) await rm(file, { force: true });
  };
}

/** A start that has taken the lock but not yet written its run file, for this long at most. */
const STARTING_MS = 10 * 60_000;

async function runEnded(paths: AutoPaths, runId: string, lockFile: string): Promise<boolean> {
  const runDir = paths.runDir(runId);
  if (!existsSync(join(runDir, "run.json"))) {
    // Still being created by another start, unless that start died long ago.
    const taken = await stat(lockFile).catch(() => undefined);
    return !taken || Date.now() - taken.mtimeMs > STARTING_MS;
  }
  return Boolean((await new AutoLedger(runDir).state()).outcome);
}

/**
 * One unfinished run per project. The lock names the run holding it; a lock
 * whose run has ended, or never got going, is stale and taken over.
 */
export async function acquireProjectLock(
  paths: AutoPaths,
  key: string,
  runId: string,
): Promise<void> {
  await mkdir(paths.locks, { recursive: true, mode: 0o700 });
  const file = paths.lockFor(key);
  // The lock appears already holding its run id (a hard link of a finished file),
  // so no other start can ever read it empty.
  const pending = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFile(pending, runId, { mode: 0o600 });
  try {
    for (let tries = 0; tries < 2; tries++) {
      try {
        await link(pending, file);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const holder = (await readFile(file, "utf8").catch(() => "")).trim();
        if (holder === runId) return;
        if (holder && !(await runEnded(paths, holder, file)))
          throw new Error(
            `Run ${holder} of this folder is unfinished. Resume it or stop it before starting another (auto status ${holder}).`,
          );
        await rm(file, { force: true });
      }
    }
  } finally {
    await rm(pending, { force: true });
  }
  throw new Error("Could not take the folder's auto-mode lock.");
}

export async function releaseProjectLock(paths: AutoPaths, key: string, runId: string) {
  const file = paths.lockFor(key);
  if ((await readFile(file, "utf8").catch(() => "")).trim() === runId)
    await rm(file, { force: true });
}

export interface RunSummary {
  runDir: string;
  run: AutoRunFile;
  state: AutoRunState;
  alive: boolean;
}

export async function summarize(runDir: string): Promise<RunSummary> {
  return {
    runDir,
    run: await readRunFile(runDir),
    state: await new AutoLedger(runDir).state(),
    alive: await runnerAlive(runDir),
  };
}

/** The runs of one project folder, newest first. */
/** A project folder's run folders, newest first by when each was created. */
async function runDirsFor(paths: AutoPaths, source: string): Promise<string[]> {
  const key = projectKey(await realpath(source).catch(() => source));
  const names = await readdir(paths.runs).catch(() => [] as string[]);
  const mine: Array<{ runDir: string; createdAt: string; runId: string }> = [];
  for (const name of names) {
    const run = await readRunFile(paths.runDir(name)).catch(() => undefined);
    if (run?.projectKey === key)
      mine.push({ runDir: paths.runDir(name), createdAt: run.createdAt, runId: run.runId });
  }
  return mine
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId))
    .map((entry) => entry.runDir);
}

/** The runs of one project folder, newest first. */
export async function runsForSource(paths: AutoPaths, source: string): Promise<RunSummary[]> {
  return Promise.all((await runDirsFor(paths, source)).map(summarize));
}

/** The newest run of a project folder, without reading every run's ledger. */
export async function newestRun(paths: AutoPaths, source: string): Promise<string | undefined> {
  return (await runDirsFor(paths, source))[0];
}

/** A run named by its id or folder, or else the newest run of a project folder. */
export async function resolveRun(
  paths: AutoPaths,
  ref: { run?: string; dir?: string },
): Promise<string> {
  if (ref.run) {
    const byId = paths.runDir(ref.run);
    for (const candidate of [byId, resolve(ref.run)])
      if (existsSync(join(candidate, "run.json"))) return candidate;
    throw new Error(`There is no auto run ${ref.run}.`);
  }
  if (!ref.dir) throw new Error("Name a run, or the project folder with --dir.");
  const newest = (await runsForSource(paths, ref.dir))[0];
  if (!newest) throw new Error(`There is no auto run for ${resolve(ref.dir)} yet.`);
  return newest.runDir;
}

/** The progress card, with the runner's own activity and whether it is still running. */
export async function statusLines(runDir: string, now = new Date()): Promise<string[]> {
  const status = JSON.parse(
    await readFile(join(runDir, "status.json"), "utf8").catch(() => "{}"),
  ) as { activity?: string };
  const state = await new AutoLedger(runDir).state();
  const alive = await runnerAlive(runDir);
  return autoProgressView(state, now, {
    activity: status.activity,
    runnerStopped: !state.outcome && !alive,
  });
}

/**
 * End a run with no runner working it: the owner stopped it after its runner
 * was killed, or a runner could not get going (no container runtime, the
 * route changed). The interrupted attempt is saved as a draft first. The run
 * can still be resumed later.
 */
export async function endRunWithoutRunner(
  runDir: string,
  paths: AutoPaths,
  ending: { outcome: AutoOutcome; reason: string },
  options: { docker?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const run = await readRunFile(runDir);
  const ledger = new AutoLedger(runDir);
  const state = await ledger.state();
  if (!state.runId)
    await ledger.append({
      type: "run_started",
      runId: run.runId,
      cases: run.cases,
      limits: run.limits,
      supervision: "detached",
      baseCommit: run.baseCommit,
      model: run.model,
    });
  if (!state.outcome) {
    if (state.current) {
      const { caseId, attempt } = state.current;
      const name = `${caseId}-${attempt}-interrupted`.replace(/[^A-Za-z0-9._-]/g, "_");
      await mkdir(join(runDir, "drafts"), { recursive: true, mode: 0o700 });
      // The run must end even if the draft cannot be made; the worktree keeps the files.
      const draft = await saveDraft(
        runRepo(run),
        `refs/auto/${run.runId}/drafts/${name}`,
        join(runDir, "drafts", `${name}.patch`),
        name,
      ).catch(() => null);
      if (draft)
        await ledger.append({
          type: "draft_saved",
          caseId,
          attempt,
          ref: draft.ref,
          patchSha256: draft.patchSha256,
        });
      await ledger.append({
        type: "attempt_finished",
        caseId,
        attempt,
        finish: "none",
        error: "Interrupted: no runner was working the run.",
      });
    }
    await ledger.append({ type: "run_ended", outcome: ending.outcome, reason: ending.reason });
  }
  await runIsolation(run, options).remove();
  await secureWorktreePointer(run);
  await releaseProjectLock(paths, run.projectKey, run.runId);
}

/**
 * Check the worktree's `.git` pointer once nothing runs in the container any
 * more, and put it back if it changed. Returns a warning for the owner then.
 */
export async function secureWorktreePointer(run: AutoRunFile): Promise<string | undefined> {
  if (!run.gitDir || !existsSync(run.worktree)) return undefined;
  if (await worktreePointerIntact(run.worktree, run.gitDir)) return undefined;
  await restoreWorktreePointer(run.worktree, run.gitDir);
  return `${join(run.worktree, ".git")} had been changed, and Dispatch put it back. Do not run Git in ${run.worktree}: use the exported patch or the branch.`;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The exported files that run on the owner's machine once applied: hook,
 * editor and agent settings, and any package.json whose scripts changed.
 */
export async function filesThatRunHere(
  mirror: MirrorRepo,
  base: string,
  head: string,
): Promise<string[]> {
  const changed = (await mirror.output(["diff", "--name-only", base, head]))
    .split("\n")
    .filter(Boolean);
  const scripts = async (rev: string, path: string) => {
    const shown = await mirror.run(["show", `${rev}:${path}`]);
    if (shown.code !== 0) return "{}";
    try {
      return JSON.stringify((JSON.parse(shown.stdout) as { scripts?: unknown }).scripts ?? {});
    } catch {
      return "unreadable";
    }
  };
  const found: string[] = [];
  for (const path of changed) {
    if (runsOnHost(path)) found.push(path);
    else if (
      (path === "package.json" || path.endsWith("/package.json")) &&
      (await scripts(base, path)) !== (await scripts(head, path))
    )
      found.push(`${path} (scripts)`);
  }
  return found;
}

/** What the export's header says about each case: never that anything was reviewed. */
export function exportHeader(
  run: AutoRunFile,
  state: AutoRunState,
  head: string,
  runsHere: string[] = [],
): string[] {
  const line = (label: string, ids: string[]) =>
    ids.length ? [`${label}: ${ids.join(", ")}`] : [];
  const stage = (wanted: string[]) =>
    state.cases.filter((c) => wanted.includes(c.stage)).map((c) => `${c.id} ${oneLine(c.title)}`);
  const progress = state.cases
    .filter((c) => c.stage !== "accepted" && c.checkpoints.length)
    .map((c) => c.id);
  return [
    `Dispatch auto run ${run.runId}: verified, not reviewed.`,
    "Each case passed the project's checks in the run's container. Nobody has reviewed this code.",
    "",
    `Base: ${run.baseCommit}`,
    `Head: ${head} (branch ${run.branch})`,
    `Run: ${state.outcome ? OUTCOME_LABELS[state.outcome] : "still running"}`,
    ...line("Verified cases", stage(["accepted"])),
    ...line("Verified progress on unfinished cases", progress),
    ...line(
      "Not done",
      stage(["pending", "running", "repairing", "blocked", "abandoned", "skipped"]),
    ),
    ...line("Files that run on your machine once applied (review these first)", runsHere),
    "",
    "Review it, then apply it to the base: git apply --index <this file>",
    `Or fetch the branch: git fetch ${run.mirror} ${run.branch}:${run.branch}`,
  ];
}

export interface ExportedRun extends ExportedPatch {
  /** Things the owner must hear: a `.git` pointer that had to be put back. */
  warnings: string[];
  /** Exported files that run on the owner's machine once applied. */
  runsHere: string[];
  /** The run's worktree was removed: the run is finished and its work is in the patch and the branch. */
  removedWorktree: boolean;
}

/**
 * The run's verified work, base to last checkpoint, as a patch checked to
 * apply to the base. The worktree's `.git` pointer is checked first. Once the
 * run can never resume (every case verified), its worktree goes: the model
 * wrote everything in it, and host Git or an editor opened there would read it.
 */
export async function exportRun(runDir: string, out?: string): Promise<ExportedRun> {
  const run = await readRunFile(runDir);
  const state = await new AutoLedger(runDir).state();
  const head = state.checkpoints.at(-1)?.commit;
  if (!head) throw new Error("The run has no verified change to export yet.");
  const file = resolve(out ?? join(runDir, "export", `${run.runId}.patch`));
  if (existsSync(file) && (await stat(file)).isDirectory())
    throw new Error(`${file} is a folder; name the patch file.`);
  const parent = await realpath(dirname(file)).catch(() => dirname(file));
  const worktree = await realpath(run.worktree).catch(() => run.worktree);
  if (inside(worktree, parent))
    throw new Error(
      `${file} is inside the run's worktree, which the model can write. Write the patch elsewhere.`,
    );
  const warning = await secureWorktreePointer(run);
  const runsHere = await filesThatRunHere(mirrorRepo(run), run.baseCommit, head);
  const exported = await exportPatch(
    mirrorRepo(run),
    run.baseCommit,
    head,
    file,
    exportHeader(run, state, head, runsHere),
  );
  const finished = state.outcome === "objective_met" && !(await runnerAlive(runDir));
  if (finished && existsSync(run.worktree)) {
    await rm(run.worktree, { recursive: true, force: true });
    await mirrorRepo(run).run(["worktree", "prune"]);
  }
  return {
    ...exported,
    warnings: warning ? [warning] : [],
    runsHere,
    removedWorktree: finished,
  };
}
