import { lstat, mkdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { AutoCase, AutoLimits, AutoOutcome, AutoRunState } from "@shared/auto-run";
import { freezable, isTestFile } from "../frozen-tests";
import {
  applyMutant,
  MUTANTS_PER_ATTEMPT,
  type Mutant,
  mutableFile,
  mutantsFromPatch,
  survivorsForWorker,
} from "../mutation-check";
import { keepSnapshots } from "../snapshots";
import { nextCase, oneLine, validateCases } from "./cases";
import {
  changedPaths,
  checkpointsSince,
  commitCheckpoint,
  excludeFromRun,
  type MirrorRepo,
  type RunRepo,
  resetToCheckpoint,
  saveDraft,
  untrackedTopPaths,
} from "./checkpoint-git";
import {
  environmentAdditions,
  environmentChanges,
  environmentManifest,
  loadManifest,
  saveManifest,
} from "./environment";
import type { AutoLedger } from "./ledger";
import { caseBudgetMs, checkLimits } from "./limits";
import {
  clearPendingMutation,
  restorePendingMutation,
  writePendingMutation,
} from "./pending-mutation";
import type {
  AutoPreparePort,
  AutoVerifierPort,
  AutoWorkerPort,
  CaseAttemptResult,
  VerificationResult,
} from "./ports";
import {
  type AutoScope,
  isCachePath,
  isNestedRepository,
  isSubstantive,
  meaningfulChanges,
  scopeViolations,
  under,
} from "./scope";

export interface AutoRunDeps {
  runId: string;
  ledger: AutoLedger;
  worker: AutoWorkerPort;
  verifier: AutoVerifierPort;
  /** Setup commands (for example `uv sync`), run once before the base check. */
  preparer?: AutoPreparePort;
  repo: RunRepo;
  mirror: MirrorRepo;
  runsRoot: string;
  scope?: AutoScope;
  clock?: () => Date;
  /** How often the runner looks for a stop request while an attempt runs or waits. */
  controlPollMs?: number;
  /** Waits before retrying an attempt Poundlock could not serve; one more failure ends the run. */
  inferenceWaitsMs?: number[];
  onActivity?: (text: string) => void;
  /**
   * Cases to add between cases, such as tasks that joined the board while the
   * run worked (ADR 016). Unknown ids only; each must depend on known cases.
   */
  newCases?: () => Promise<AutoCase[]>;
  /** Test files frozen before the run started (the project's accepted tests-first work). */
  frozenTests?: string[];
  /** Break each finished case's new code a little and require a check to notice (ADR 016). */
  mutationCheck?: boolean;
  /**
   * Asked whenever no case can run (ADR 016): the goal driver reviews the
   * milestone and answers with more cases, or how the run ends. Without it,
   * a run ends when its cases do.
   */
  whenIdle?: (state: AutoRunState, signal: AbortSignal) => Promise<IdleAnswer>;
  /**
   * A case failed only on frozen tests: which of them the rest of the run may
   * change, each with why (a goal's Planner decides; none means keep them all).
   */
  onFrozenBlocked?: (
    input: { title: string; failure: string; tests: string[] },
    signal: AbortSignal,
  ) => Promise<Array<{ path: string; reason: string }>>;
  /**
   * The base has nothing to check yet (a goal in an empty repository): the
   * base checks are skipped, and every case is still accepted only on them.
   */
  greenfield?: boolean;
  /** A goal: failing checks at the start go to its Planner instead of ending the run. */
  repairsBase?: boolean;
  /**
   * Workers may have setup run again for new dependencies. Only with the
   * owner's approval of downloads: the manifests are the worker's, and setup
   * has the network.
   */
  installsDependencies?: boolean;
  /**
   * Accept a task whose work is already in the code: shown the tests it names
   * first, a second "done" that changed nothing is taken. An owner setting,
   * off by default.
   */
  acceptsAlreadyMet?: boolean;
}

/** What the goal driver answers when no case can run. */
export type IdleAnswer = { cases: AutoCase[] } | { end: Ending };

export interface AutoRunSpec {
  cases: AutoCase[];
  limits: AutoLimits;
  /** The Poundlock profile, shown on the card. */
  model?: string;
  /** Where commands run, shown on the card. */
  isolation?: string;
}

/** The report-finalization window after a case's time runs out on verified work. */
export const FINALIZE_MS = 5 * 60_000;

/** About fifteen minutes of back-off before a missing Poundlock ends the run. */
export const INFERENCE_WAITS_MS = [30_000, 60_000, 120_000, 240_000, 480_000];

const INTERRUPTED =
  "Interrupted: the runner stopped during this attempt. Its changes are kept for the next attempt.";

export type Ending = { outcome: AutoOutcome; reason: string };

/** How a challenged blocker is recorded as a repair, so it is challenged once. */
const BLOCKED_CHALLENGE = "blocked, challenged: ";
/** How a finish that left the task's named files alone is recorded, so it is put back once. */
const NAMED_CHALLENGE = "named files untouched: ";
/** How a "done" that changed nothing is recorded, so it is put back once before it is taken. */
const ALREADY_MET_CHALLENGE = "done with no changes, challenged";

/**
 * The detached loop (ADR 014). One case at a time: attempt, save a draft,
 * independent checks and scope, then a checkpoint commit, a repair in the
 * same session, or abandoning after a reset to the last checkpoint. The ledger
 * records every step, so a crash resumes from the last checkpoint without
 * losing a draft, and accepted cases are never run again.
 */
export class AutoRunEngine {
  private readonly clock: () => Date;
  private stopNow = false;
  private stopAfterCase = false;
  private learnings: string[] = [];
  /** A note for the attempt that picks up after an interruption. */
  private resumeNote: { caseId: string; text: string } | undefined;
  /** Frozen tests the Planner let the rest of the run change, with why. */
  private allowedFrozen = new Map<string, string>();
  /** The run's cases: those it started with, then any that joined. */
  private cases: AutoCase[] = [];
  /** Inbox entries already taken, so each is acted on once across polls and resumes. */
  private inboxTaken: Set<string> | undefined;
  /** Frozen test files: the project's, plus what tests-first cases in this run wrote. */
  private frozen = new Set<string>();

  constructor(private readonly deps: AutoRunDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async start(spec: AutoRunSpec): Promise<AutoOutcome> {
    await this.deps.ledger.append({
      type: "run_started",
      runId: this.deps.runId,
      cases: spec.cases,
      limits: spec.limits,
      supervision: "detached",
      baseCommit: await this.deps.repo.head(),
      model: spec.model,
      isolation: spec.isolation,
    });
    await this.prepareGates([]);
    const refused = await this.preflight();
    if (refused) return this.end(await this.deps.ledger.state(), refused);
    this.cases = [...spec.cases];
    return this.loop(spec.limits);
  }

  /**
   * The frozen tests and the evidence folder. `.dispatch/` holds the worker's
   * UI snapshots; it is never part of a case's changes or a checkpoint.
   */
  private async prepareGates(entries: Awaited<ReturnType<AutoLedger["read"]>>): Promise<void> {
    // A start clears earlier runs' exclusions; a resume puts back its own.
    const fresh = !entries.length;
    const environment = fresh ? [] : (await this.deps.ledger.state()).environmentPaths;
    await excludeFromRun(this.deps.mirror, [".dispatch/", ...environment], { fresh });
    this.frozen = new Set(this.deps.frozenTests ?? []);
    // A helper frozen before only test files were (15 Oct) is free again.
    for (const { event } of entries) {
      if (event.type === "frozen")
        for (const path of event.paths) if (isTestFile(path)) this.frozen.add(path);
      if (event.type === "frozen_allowed")
        for (const item of event.allowed) this.allowedFrozen.set(item.path, item.reason);
    }
    await restorePendingMutation(this.deps.ledger.runDir);
  }

  /** Continue after a crash or a stop: an unfinished attempt is closed as interrupted, its work saved. */
  async resume(): Promise<AutoOutcome> {
    const entries = await this.deps.ledger.read();
    const started = entries.find((e) => e.event.type === "run_started")?.event;
    if (!started || started.type !== "run_started")
      throw new Error("This run has no start record.");
    await this.deps.ledger.append({ type: "run_resumed" });
    await this.deps.ledger.clearControl();
    await this.prepareGates(entries);
    let state = await this.deps.ledger.state();
    await this.reconcileCheckpoints(state);
    state = await this.deps.ledger.state();
    if (state.current) {
      const { caseId, attempt } = state.current;
      await this.saveAttemptDraft(caseId, attempt, "interrupted");
      await this.deps.ledger.append({
        type: "attempt_finished",
        caseId,
        attempt,
        finish: "none",
        error: INTERRUPTED,
      });
      this.resumeNote = {
        caseId,
        text: "Your previous attempt was interrupted when the runner stopped. Its changes are still in the working tree: check them, then finish the case.",
      };
    }
    // The base checks belong to the start: once cases have run, the worktree is
    // past the base (with an interrupted attempt's work in it), and a goal that
    // began with failing checks had them planned for. Re-running them refused a
    // resumed run.
    const worked = state.cases.some((item) => item.stage !== "pending");
    if (state.preflight !== "passed" && !worked) {
      const refused = await this.preflight();
      if (refused) return this.end(await this.deps.ledger.state(), refused);
    }
    this.cases = [...started.cases];
    for (const { event } of entries)
      if (event.type === "cases_added") this.cases.push(...event.cases);
    return this.loop(started.limits);
  }

  /** Cases that joined the board since the last look, recorded before they can run. */
  private async takeNewCases(): Promise<void> {
    if (!this.deps.newCases) return;
    const known = new Set(this.cases.map((item) => item.id));
    const fresh = (await this.deps.newCases()).filter((item) => !known.has(item.id));
    if (!fresh.length) return;
    try {
      validateCases([...this.cases, ...fresh]);
    } catch (error) {
      this.deps.onActivity?.(
        `New tasks were not added: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    await this.deps.ledger.append({ type: "cases_added", cases: fresh });
    this.cases.push(...fresh);
  }

  /** The goal driver's answer when no case can run; its new cases join the run. */
  private async idle(state: AutoRunState): Promise<IdleAnswer> {
    const stop = this.stopSignal();
    try {
      let answer: IdleAnswer;
      try {
        answer = await this.deps.whenIdle!(state, stop.signal);
      } catch (error) {
        if (this.stopNow)
          return { end: { outcome: "cancelled_after_checkpoint", reason: "stopped by the owner" } };
        const reason = error instanceof Error ? error.message : String(error);
        return { end: { outcome: "blocked_for_input", reason: `planning stopped: ${reason}` } };
      }
      if (this.stopNow)
        return { end: { outcome: "cancelled_after_checkpoint", reason: "stopped by the owner" } };
      if (!("cases" in answer)) return answer;
      const known = new Set(this.cases.map((item) => item.id));
      const fresh = answer.cases.filter((item) => !known.has(item.id));
      if (!fresh.length) return { cases: [] };
      try {
        validateCases([...this.cases, ...fresh]);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          end: { outcome: "blocked_for_input", reason: `the planned tasks cannot run: ${reason}` },
        };
      }
      await this.deps.ledger.append({ type: "cases_added", cases: fresh });
      this.cases.push(...fresh);
      return { cases: fresh };
    } finally {
      stop.dispose();
    }
  }

  /**
   * Setup, then the plan's checks at the base commit. A case never starts on a
   * base whose checks already fail, or whose checks change tracked files: the
   * first case would inherit both.
   */
  private async preflight(): Promise<Ending | undefined> {
    const stop = this.stopSignal();
    try {
      return await this.preflightSteps(stop.signal);
    } finally {
      stop.dispose();
    }
  }

  private async preflightSteps(signal: AbortSignal): Promise<Ending | undefined> {
    const { ledger, repo, verifier, preparer } = this.deps;
    const stopped: Ending = {
      outcome: "cancelled_after_checkpoint",
      reason: "stopped by the owner",
    };
    if (preparer) {
      this.deps.onActivity?.("preparing the container");
      // What setup adds is the environment, a setup cut short by a crash included.
      // Only what it adds: a worktree with an interrupted attempt or a core dump in
      // it once had a worker's new test excluded from its commit.
      const before = new Set(await untrackedTopPaths(repo));
      const prepared = await preparer.prepare(signal);
      if (this.stopNow) return stopped;
      const created = (await untrackedTopPaths(repo)).filter((path) => !before.has(path));
      await excludeFromRun(this.deps.mirror, created);
      await this.writeLog("preflight-prepare.log", prepared);
      await ledger.append({
        type: "preflight",
        phase: "prepare",
        passed: prepared.passed,
        commands: prepared.commands.map(({ command, exitCode }) => ({ command, exitCode })),
        environmentPaths: created,
      });
      if (!prepared.passed)
        return {
          outcome: "blocked_for_input",
          reason: `setup failed: ${firstFailure(prepared)} (verify/preflight-prepare.log)`,
        };
    }
    if (this.deps.greenfield) {
      await ledger.append({
        type: "preflight",
        phase: "checks",
        passed: true,
        commands: [],
        pending: true,
      });
      return undefined;
    }
    this.deps.onActivity?.("running the checks at the base commit");
    let checks = await verifier.verify(repo.worktree, signal);
    if (this.stopNow) return stopped;
    // A frozen test that failed at random at the start sent a run to plan a
    // repair of nothing: the start runs it once more, as a case does.
    const flaky = checks.passed ? [] : failingFrozenTests(checks, this.frozen);
    if (flaky.length) {
      checks = await verifier.verify(repo.worktree, signal);
      if (this.stopNow) return stopped;
      await ledger.append({ type: "checks_rerun", tests: flaky, passed: checks.passed });
    }
    await this.writeLog("preflight-checks.log", checks);
    const state = await ledger.state();
    const dirtied = meaningfulChanges(await changedPaths(repo), state.environmentPaths);
    const passed = checks.passed && dirtied.length === 0;
    await ledger.append({
      type: "preflight",
      phase: "checks",
      passed,
      commands: checks.commands.map(({ command, exitCode }) => ({ command, exitCode })),
    });
    if (!checks.passed && this.deps.repairsBase && dirtied.length === 0) {
      // A goal's Planner can plan the repair, even of a frozen test that is
      // wrong; tasks planned before would only fail against a broken base.
      const signature = failureReason({ finish: "none" }, checks, [], false, this.frozen).signature;
      await ledger.append({ type: "base_failing", signature });
      for (const item of state.cases.filter((c) => c.stage === "pending"))
        await ledger.append({
          type: "case_skipped",
          caseId: item.id,
          reason: "the checks fail at the start; the Planner replans this once they are repaired",
        });
      return undefined;
    }
    if (!checks.passed)
      return {
        outcome: "blocked_for_input",
        reason: `the plan's checks fail at the base commit: ${firstFailure(checks)} (verify/preflight-checks.log)`,
      };
    if (dirtied.length)
      return {
        outcome: "blocked_for_input",
        reason: `the checks change tracked files at the base commit: ${dirtied.slice(0, 5).join(", ")}`,
      };
    // What setup and the base checks left, so a case that alters it is caught (L32).
    if (state.environmentPaths.length)
      await saveManifest(
        this.environmentFile(),
        await environmentManifest(repo.worktree, state.environmentPaths),
      );
    return undefined;
  }

  /**
   * Setup again, mid-case, for a worker that changed the project's
   * dependencies. What setup newly made joins the run's environment, and the
   * environment's record is taken again, so the change is not a violation.
   */
  private async installDependencies(
    caseId: string,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    const { ledger, repo, preparer } = this.deps;
    if (!preparer) return { passed: false, commands: [] };
    // Setup must not take a changed environment as given: that would hide the change.
    const tampered = await this.environmentViolations((await ledger.state()).environmentPaths);
    if (tampered.length)
      return {
        passed: false,
        commands: [
          {
            command: "install_dependencies",
            exitCode: null,
            output: `Refused: these files of the prepared environment were changed, and must be put back first: ${tampered.join(", ")}.`,
          },
        ],
      };
    this.deps.onActivity?.(`${caseId}: running setup again for new dependencies`);
    const before = new Set(await untrackedTopPaths(repo));
    const prepared = await preparer.prepare(signal);
    // Folders setup made (node_modules, .venv) are the environment; a file it
    // made, such as a new lockfile, is part of the worker's change.
    const created: string[] = [];
    for (const path of await untrackedTopPaths(repo))
      if (!before.has(path) && (await isDirectory(join(repo.worktree, path)))) created.push(path);
    await excludeFromRun(this.deps.mirror, created);
    await ledger.append({
      type: "environment_prepared",
      caseId,
      passed: prepared.passed,
      commands: prepared.commands.map(({ command, exitCode }) => ({ command, exitCode })),
      environmentPaths: created,
    });
    const paths = (await ledger.state()).environmentPaths;
    if (paths.length)
      await saveManifest(this.environmentFile(), await environmentManifest(repo.worktree, paths));
    return prepared;
  }

  /**
   * Delete the environment folders and run setup again, as at the start. Only
   * when downloads are approved (setup may need the network); returns whether
   * the environment is pristine again.
   */
  private async restoreEnvironment(caseId: string, changed: string[]): Promise<boolean> {
    const { ledger, repo, preparer } = this.deps;
    if (!preparer || !this.deps.installsDependencies) return false;
    const paths = (await ledger.state()).environmentPaths;
    const worktree = resolve(repo.worktree);
    for (const path of paths) {
      const target = resolve(worktree, path);
      if (target.startsWith(`${worktree}${sep}`))
        await rm(target, { recursive: true, force: true });
    }
    this.deps.onActivity?.(`${caseId}: rebuilding the changed environment`);
    const stop = this.stopSignal();
    try {
      const prepared = await preparer.prepare(stop.signal);
      await ledger.append({
        type: "environment_restored",
        caseId,
        paths: changed.map((path) => path.replace(/ \(prepared environment\)$/, "")),
        passed: prepared.passed,
      });
      if (!prepared.passed) return false;
      await saveManifest(this.environmentFile(), await environmentManifest(repo.worktree, paths));
      return true;
    } finally {
      stop.dispose();
    }
  }

  private environmentFile(): string {
    return join(this.deps.ledger.runDir, "environment.json");
  }

  /** Environment paths a case changed, prefixed so the finding names them as such. */
  private async environmentViolations(environmentPaths: string[]): Promise<string[]> {
    const recorded = await loadManifest(this.environmentFile());
    if (!recorded || !environmentPaths.length) return [];
    const current = await environmentManifest(this.deps.repo.worktree, environmentPaths);
    return environmentChanges(recorded, current).map((path) => `${path} (prepared environment)`);
  }

  /**
   * A crash between a checkpoint commit and its ledger record leaves a commit
   * the ledger does not know. Record it from its trailers, so the case is not
   * worked again and the commit is not lost to the next reset.
   */
  private async reconcileCheckpoints(state: AutoRunState): Promise<void> {
    const from = state.checkpoints.at(-1)?.commit ?? state.baseCommit;
    if (!from) return;
    for (const found of await checkpointsSince(this.deps.repo, from)) {
      if (!found.caseId || !state.cases.some((c) => c.id === found.caseId)) continue;
      const changed = (
        await this.deps.repo.output(["diff", "--name-only", `${found.commit}^`, found.commit])
      )
        .split("\n")
        .filter(Boolean);
      await this.deps.ledger.append({
        type: "checkpoint",
        caseId: found.caseId,
        commit: found.commit,
        substantive: isSubstantive(changed, this.deps.scope ?? {}),
        reviewed: false,
      });
      if (found.finish === "done")
        await this.deps.ledger.append({ type: "case_accepted", caseId: found.caseId });
    }
    // A crash between a finished checkpoint's record and its acceptance.
    const last = state.checkpoints.at(-1);
    const owner = last && state.cases.find((c) => c.id === last.caseId);
    if (last && owner && owner.stage !== "accepted") {
      const body = await this.deps.repo.output(["log", "-1", "--format=%B", last.commit]);
      if (/^Dispatch-Auto-Finish: done$/m.test(body))
        await this.deps.ledger.append({ type: "case_accepted", caseId: owner.id });
    }
  }

  private async loop(limits: AutoLimits): Promise<AutoOutcome> {
    for (;;) {
      await this.pollControl();
      await this.takeNewCases();
      const state = await this.deps.ledger.state();
      if (this.stopNow || this.stopAfterCase) {
        return this.end(state, {
          outcome: "cancelled_after_checkpoint",
          reason: this.stopNow ? "stopped by the owner" : "stopped after the case, as asked",
        });
      }
      const next = nextCase(this.cases, state);
      // A case already under way (a resume) finishes; only the hard limit stops it.
      const inFlight =
        next && "case" in next
          ? ["running", "repairing"].includes(
              state.cases.find((c) => c.id === next.case.id)?.stage ?? "",
            )
          : false;
      const hit = checkLimits(state, limits, this.clock());
      if (hit && !(inFlight && hit.level === "soft")) {
        await this.deps.ledger.append({ type: "limit", kind: hit.kind, level: hit.level });
        return this.end(state, {
          outcome:
            state.substantiveAccepted > 0
              ? "limit_reached_with_accepted_work"
              : "limit_reached_without_accepted_work",
          reason: hit.detail,
        });
      }
      if (!next) {
        const answer = this.deps.whenIdle ? await this.idle(state) : undefined;
        if (answer && "cases" in answer && answer.cases.length) continue;
        return this.end(state, answer && "end" in answer ? answer.end : finalOutcome(state));
      }
      if ("skip" in next) {
        await this.deps.ledger.append({
          type: "case_skipped",
          caseId: next.skip.id,
          reason: next.reason,
        });
        continue;
      }
      const ending = await this.runCase(next.case, limits, state);
      if (ending) return this.end(await this.deps.ledger.state(), ending);
    }
  }

  private async runCase(
    planned: AutoCase,
    limits: AutoLimits,
    stateAtStart: AutoRunState,
  ): Promise<Ending | undefined> {
    let item = this.withAllowedFrozen(planned);
    const ledger = this.deps.ledger;
    const caseState = stateAtStart.cases.find((c) => c.id === item.id);
    if (caseState?.stage === "pending")
      await ledger.append({ type: "case_started", caseId: item.id });
    let caseStartedAt = this.clock();
    let attempt = (caseState?.attempts ?? 0) + 1;
    // Attempts continue one session per case (a resume included); a new key starts a fresh one.
    let sessionKey = caseState?.sessionKey ?? `${item.id}-session`;
    let fresh = attempt === 1;
    let findings: string | undefined =
      this.resumeNote?.caseId === item.id ? this.resumeNote.text : caseState?.lastFailure;
    this.resumeNote = undefined;
    // A review planned tests that were already in the code, and a worker spent
    // its 90 minutes writing one again: it is shown
    // the ones the case names first.
    if (this.deps.acceptsAlreadyMet && attempt === 1 && !findings) {
      const existing = await this.namedTestFiles(item);
      if (existing.length)
        findings = `${existing.join(", ")} already exist${existing.length > 1 ? "" : "s"}. Read ${existing.length > 1 ? "them" : "it"} first. If the code and its tests already do what the acceptance criteria ask, change nothing and call finish_case done, naming the tests that show it; otherwise add only what is missing.`;
    }
    let unavailable = 0;
    for (;;) {
      const state = await ledger.state();
      const budget = caseBudgetMs(state, limits, caseStartedAt, this.clock());
      // At the hard limit the run ends with the worktree as it is (drafts saved), so a resume can finish the case.
      if (this.stopNow || checkLimits(state, limits, this.clock())?.level === "hard") return;
      if (budget <= 0) {
        await this.giveUp(item.id, attempt - 1, `case allowance of ${limits.caseMinutes} min used`);
        return;
      }
      this.deps.onActivity?.(`${item.title}: attempt ${attempt}`);
      await ledger.append({ type: "attempt_started", caseId: item.id, attempt, sessionKey });
      const started = this.clock();
      const deadline = new Date(started.getTime() + budget);
      const hardEnd = state.startedAt
        ? Date.parse(state.startedAt) + limits.hardHours * 3_600_000
        : Number.POSITIVE_INFINITY;
      const waited = { ms: 0, hardEnd };
      const result = await this.runAttempt(
        item,
        attempt,
        sessionKey,
        fresh,
        findings,
        deadline,
        false,
        waited,
      );
      // Waits for a model other work held (another project's jobs, say) are not the case's time.
      caseStartedAt = new Date(caseStartedAt.getTime() + waited.ms);
      if (waited.ms > 0)
        await ledger.append({
          type: "capacity_waited",
          caseId: item.id,
          ms: Math.round(waited.ms),
        });
      await ledger.append({
        type: "attempt_finished",
        caseId: item.id,
        attempt,
        finish: result.finish,
        summary: result.summary,
        error: result.error,
        usage: result.usage,
        compactions: result.compactions,
        editGuard: result.editGuard,
        interruptedActions: result.interruptedActions,
        minutes: Math.round((this.clock().getTime() - started.getTime()) / 6000) / 10,
      });
      if (result.learnings?.length) this.learnings.push(...result.learnings);
      await keepSnapshots(
        this.deps.repo.worktree,
        join(this.deps.ledger.runDir, "attempts", `${item.id}-${attempt}`),
        started.getTime(),
      ).catch(() => []);
      await this.saveAttemptDraft(item.id, attempt, "attempt");
      if (this.stopNow) return; // the draft is saved and the worktree left as it is for resume
      if (result.inferenceUnavailable) {
        // Not the model's failure: wait and continue the same session, without a repair.
        // A busy model is Poundlock answering: another client's work holds it,
        // as when a durable job holds the machine for an hour.
        // That wait never ends the run; the hard limit bounds it.
        const waits = this.deps.inferenceWaitsMs ?? INFERENCE_WAITS_MS;
        if (!result.capacityBusy && unavailable >= waits.length)
          return {
            outcome: "blocked_for_input",
            reason: `Poundlock or the model stayed unavailable (${result.error ?? "no reply"}). The work so far is saved; resume the run when it is back.`,
          };
        const waitMs = result.capacityBusy ? waits[0] : waits[unavailable++];
        await ledger.append({
          type: "inference_wait",
          caseId: item.id,
          attempt,
          error: result.error ?? "no reply",
          seconds: Math.round(waitMs / 1000),
        });
        const waitedFrom = this.clock().getTime();
        await this.wait(waitMs);
        caseStartedAt = new Date(caseStartedAt.getTime() + (this.clock().getTime() - waitedFrom));
        if (this.stopNow || this.stopAfterCase) return;
        attempt++;
        fresh = false;
        findings =
          "Your previous attempt was cut off because Poundlock or the model could not be reached. Its changes are still in the working tree: continue the case.";
        continue;
      }
      unavailable = 0;
      if (result.finish === "blocked") {
        const said = result.blockedReason || result.summary || "the worker reported a blocker";
        // Nobody answers in an unattended run, and a local worker has called a
        // case blocked over a limit it never reached. The first
        // claim is put back to it; a second stands.
        const challenged = (await ledger.read()).some(
          ({ event }) =>
            event.type === "case_repair" &&
            event.caseId === item.id &&
            event.reason.startsWith(BLOCKED_CHALLENGE),
        );
        // A frozen test in the way is the Planner's to decide, not a claim to
        // challenge: told to finish anyway, a worker edited the frozen test it
        // had named and lost the task.
        // Frozen tests the case may already change: say so plainly. A worker read
        // "do not change files other tasks own" as overriding the permission
        // and reported its case blocked.
        const mayChange = [...this.frozen].filter(
          (path) => said.includes(path) && item.frozenTestsToChange?.includes(path),
        );
        if (mayChange.length && !challenged) {
          await ledger.append({
            type: "case_repair",
            caseId: item.id,
            reason: `${BLOCKED_CHALLENGE}frozen tests already allowed: ${mayChange.join(", ")}`,
          });
          findings = `You may change ${mayChange.join(", ")}: this case is allowed to, although other tasks wrote them and they are not among the files to touch.${item.frozenChangeReason ? ` Why: ${item.frozenChangeReason}` : ""} Change them only as the case needs, then finish it.`;
          attempt++;
          continue;
        }
        const inTheWay = this.frozenNamed(said);
        if (inTheWay.length) {
          const allowed = await this.askAboutFrozen(item, said, inTheWay);
          if (allowed.length) {
            item = this.withAllowedFrozen(item);
            await ledger.append({
              type: "case_repair",
              caseId: item.id,
              reason: `frozen tests allowed: ${allowed.map((entry) => entry.path).join(", ")}`,
            });
            findings = `The Planner allowed this case to change ${allowed.map((entry) => `${entry.path} (${entry.reason})`).join("; ")}. Change only what that reason covers, then finish the case.`;
            attempt++;
            continue;
          }
        }
        const current = (await ledger.state()).cases.find((c) => c.id === item.id);
        if (!challenged && (current?.repairs ?? 0) < limits.maxRepairsPerCase) {
          await ledger.append({
            type: "case_repair",
            caseId: item.id,
            reason: `${BLOCKED_CHALLENGE}${said.slice(0, 160)}`,
          });
          // A real defect outside the case's files is a fair blocker: told only
          // to finish, a worker wrote a test pinning the defect
          // it had found, and that test was frozen.
          findings = `You reported this case blocked: "${said}". Nobody can answer during this run, so blocked is only for what a person must provide (a credential, a decision the plan does not make, access Dispatch does not grant) or for a defect in code this case may not change. Nothing else stops you: there is no turn or context limit you have reached. Continue the case and finish it. If you are really blocked, call finish_case blocked again and say exactly what, with the evidence; never make the checks pass with a test that asserts the defect.`;
          attempt++;
          continue;
        }
        await this.resetToLastCheckpoint();
        await ledger.append({ type: "case_blocked", caseId: item.id, reason: said });
        return;
      }
      // Scratch files a worker left in node_modules or .venv go before the
      // checks run, so they can neither change what the checks load nor cost
      // the case: one could cost a run a whole task.
      const cleaned = await this.removeEnvironmentAdditions();
      if (cleaned.length) {
        await ledger.append({ type: "environment_cleaned", caseId: item.id, paths: cleaned });
        this.learnings.push(
          `Dispatch removed files added inside the prepared environment (${cleaned.join(", ")}); keep scratch files under /tmp.`,
        );
      }
      // A changed dependency is rebuilt from setup rather than costing the
      // case: a worker may patch a dependency's types in node_modules. The
      // checks then run against the pristine environment,
      // so the patch cannot help them. Without downloads the refusal stands.
      const tampered = await this.environmentViolations((await ledger.state()).environmentPaths);
      if (tampered.length && (await this.restoreEnvironment(item.id, tampered)))
        this.learnings.push(
          `Dispatch rebuilt the prepared environment because ${tampered.join(", ")} had been changed. Never edit dependencies; fix the project's own code.`,
        );
      let verification = await this.verifyOrWait(item.id, attempt);
      if ("outcome" in verification) return verification;
      // A failure only in frozen tests the case left alone is run once more: a
      // frozen test that failed at random cost tasks.
      const untouched = failingFrozenTests(verification, this.frozen);
      if (
        !verification.passed &&
        untouched.length &&
        !(await changedPaths(this.deps.repo)).some((path) => untouched.includes(path))
      ) {
        const again = await this.verifyOrWait(item.id, attempt);
        if ("outcome" in again) return again;
        await ledger.append({
          type: "checks_rerun",
          caseId: item.id,
          attempt,
          tests: untouched,
          passed: again.passed,
        });
        verification = again;
      }
      await this.writeLog(`${item.id}-${attempt}.log`, verification);
      await ledger.append({
        type: "verification",
        caseId: item.id,
        attempt,
        passed: verification.passed,
        commands: verification.commands.map(({ command, exitCode }) => ({ command, exitCode })),
      });
      const environmentPaths = (await ledger.state()).environmentPaths;
      const changed = meaningfulChanges(await changedPaths(this.deps.repo), environmentPaths);
      const violations = [
        ...scopeViolations(changed, this.deps.scope ?? {}, item.writable),
        ...(await this.environmentViolations(environmentPaths)),
        ...(await linksOutside(this.deps.repo.worktree, changed)),
        ...(item.changesFrozenTests && !item.frozenTestsToChange?.length
          ? []
          : changed
              .filter(
                (path) =>
                  this.frozen.has(path) &&
                  freezable(path) &&
                  !item.frozenTestsToChange?.includes(path),
              )
              .map((path) => `${path} (frozen test)`)),
      ];
      if (violations.length)
        await ledger.append({ type: "scope", caseId: item.id, attempt, violations });
      const clean = verification.passed && violations.length === 0;
      if (clean && changed.length && result.finish === "done") {
        const repairsUsed =
          (await ledger.state()).cases.find((c) => c.id === item.id)?.repairs ?? 0;
        // A task to wire panels "into main.tsx" was accepted on the shell's unit
        // tests without touching main.tsx, so the running app never showed them.
        // Named files left alone are put back once.
        const untouched = await this.untouchedNamedFiles(item, changed);
        if (untouched.length && repairsUsed < limits.maxRepairsPerCase) {
          await ledger.append({
            type: "case_repair",
            caseId: item.id,
            reason: `${NAMED_CHALLENGE}${untouched.join(", ")}`,
          });
          findings = `The task names ${untouched.join(", ")}, but your change does not touch ${untouched.length > 1 ? "them" : "it"}. Make the change the acceptance criteria describe there, so the running app shows it, then finish the case again. If a named file truly needs no change, say why in your summary and finish again.`;
          fresh = false;
          attempt++;
          continue;
        }
        const missed = await this.mutationGate(item, attempt);
        if (missed && repairsUsed < limits.maxRepairsPerCase) {
          await ledger.append({
            type: "case_repair",
            caseId: item.id,
            reason: "mutation check: a break no check noticed",
          });
          findings = missed;
          fresh = false;
          attempt++;
          continue;
        }
        if (await this.accept(item, attempt, verification, changed, true)) {
          const allowed = changed.filter(
            (path) => this.frozen.has(path) && item.frozenTestsToChange?.includes(path),
          );
          // The reasons for the tests this case changed, not every allowance the
          // run holds: the report quotes them.
          const named = allowed.filter((path) => planned.frozenTestsToChange?.includes(path));
          const reason = [
            named.length ? planned.frozenChangeReason : undefined,
            ...allowed
              .filter((path) => !named.includes(path) && this.allowedFrozen.has(path))
              .map((path) => `${path}: ${this.allowedFrozen.get(path)}`),
          ]
            .filter(Boolean)
            .join(" ");
          if (allowed.length)
            await ledger.append({
              type: "frozen_changed",
              caseId: item.id,
              paths: allowed,
              ...(reason ? { reason } : {}),
            });
          await this.freezeTests(item, changed);
          return;
        }
      }
      // "Done" with nothing new: the work is the verified progress checkpoint this run
      // already made for the case. Without such a checkpoint an idle "done" is not accepted.
      const checkpoints =
        (await ledger.state()).cases.find((c) => c.id === item.id)?.checkpoints ?? [];
      if (clean && !changed.length && result.finish === "done" && checkpoints.length) {
        await ledger.append({ type: "case_accepted", caseId: item.id, after: "checkpoint" });
        return;
      }
      // "Done" with nothing changed and nothing kept: the work may already be in
      // the code (another task did it). Put back once; a second such "done" is
      // taken, and the milestone's next review judges the code.
      if (this.deps.acceptsAlreadyMet && clean && !changed.length && result.finish === "done") {
        const asked = (await ledger.read()).some(
          ({ event }) =>
            event.type === "case_repair" &&
            event.caseId === item.id &&
            event.reason === ALREADY_MET_CHALLENGE,
        );
        if (asked) {
          await ledger.append({ type: "case_accepted", caseId: item.id, after: "already_met" });
          return;
        }
        const current = (await ledger.state()).cases.find((c) => c.id === item.id);
        if ((current?.repairs ?? 0) < limits.maxRepairsPerCase) {
          await ledger.append({
            type: "case_repair",
            caseId: item.id,
            reason: ALREADY_MET_CHALLENGE,
          });
          findings = `Your attempt changed no files. If the code and its tests already do what the acceptance criteria ask, call finish_case done again and name, in your summary, the tests that show it and what each checks. Otherwise make the change the case asks for.`;
          attempt++;
          continue;
        }
      }
      if (clean && changed.length) {
        // Verified progress without a finish: keep it as a checkpoint so nothing good is lost.
        await this.accept(item, attempt, verification, changed, false);
        if (this.clock() >= deadline && !this.stopNow) {
          attempt++;
          if (await this.finalize(item, attempt, sessionKey, limits)) return;
        }
      }
      const reason = failureReason(
        result,
        verification,
        violations,
        changed.length === 0,
        this.frozen,
      );
      const current = (await ledger.state()).cases.find((c) => c.id === item.id);
      const sameAgain = current?.lastFailure === reason.signature ? current.sameFailure + 1 : 1;
      if (
        (current?.repairs ?? 0) >= limits.maxRepairsPerCase ||
        sameAgain >= limits.maxSameFailure
      ) {
        await this.giveUp(item.id, attempt, reason.signature);
        await this.askAboutFrozen(
          item,
          [reason.signature, result.summary].filter(Boolean).join(" — "),
          this.frozenNamed(reason.signature, violations),
        );
        return;
      }
      await ledger.append({ type: "case_repair", caseId: item.id, reason: reason.signature });
      findings = reason.details;
      // A reply that may have been cut off mid-stream leaves a session not worth continuing.
      fresh = /ambiguous/i.test(result.error ?? "");
      if (fresh) sessionKey = `${item.id}-session-${attempt + 1}`;
      attempt++;
    }
  }

  /**
   * The case's time ran out on work that passes every check and is kept as a
   * checkpoint. Rather than abandon it for want of a finish_case call, spend
   * the finalization window (writes blocked, same session) asking the worker
   * whether the case is complete. "done" with nothing changed accepts the
   * checkpoint that was just verified.
   */
  private async finalize(
    item: AutoCase,
    attempt: number,
    sessionKey: string,
    limits: AutoLimits,
  ): Promise<boolean> {
    const ledger = this.deps.ledger;
    if (checkLimits(await ledger.state(), limits, this.clock())?.level === "hard") return false;
    await ledger.append({ type: "attempt_started", caseId: item.id, attempt, sessionKey });
    const started = this.clock();
    const result = await this.runAttempt(
      item,
      attempt,
      sessionKey,
      false,
      undefined,
      new Date(started.getTime() + FINALIZE_MS),
      true,
    );
    await ledger.append({
      type: "attempt_finished",
      caseId: item.id,
      attempt,
      finish: result.finish,
      summary: result.summary,
      error: result.error,
      usage: result.usage,
      compactions: result.compactions,
      editGuard: result.editGuard,
      minutes: Math.round((this.clock().getTime() - started.getTime()) / 6000) / 10,
    });
    const state = await ledger.state();
    const changed = meaningfulChanges(await changedPaths(this.deps.repo), state.environmentPaths);
    if (result.finish !== "done" || changed.length) return false;
    await ledger.append({ type: "case_accepted", caseId: item.id, after: "finalization" });
    return true;
  }

  private async runAttempt(
    item: AutoCase,
    attempt: number,
    sessionKey: string,
    fresh: boolean,
    findings: string | undefined,
    deadline: Date,
    finalize = false,
    waited?: { ms: number; hardEnd: number },
  ): Promise<CaseAttemptResult> {
    const controller = new AbortController();
    const caseEndsAt = deadline.getTime();
    let endsAt = caseEndsAt;
    let waitingFrom: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      if (endsAt === Number.POSITIVE_INFINITY) return;
      timer = setTimeout(
        () => controller.abort(new Error("case allowance or hard limit reached")),
        Math.max(0, endsAt - this.clock().getTime()),
      );
    };
    arm();
    const poll = setInterval(() => {
      void this.pollControl()
        .then(() => {
          if (this.stopNow) controller.abort(new Error("stopped by the owner"));
        })
        .catch(() => undefined);
    }, this.deps.controlPollMs ?? 5000);
    try {
      return await this.deps.worker.runCase({
        case: item,
        attempt,
        sessionKey,
        fresh,
        repairFindings: findings,
        learnings: this.learnings.slice(-5),
        worktree: this.deps.repo.worktree,
        deadline,
        signal: controller.signal,
        finalize,
        ...(waited
          ? {
              onCapacityWait: (waiting: boolean) => {
                const now = this.clock().getTime();
                if (waiting) {
                  waitingFrom ??= now;
                  // Only the hard limit runs while the model is busy.
                  endsAt = waited.hardEnd;
                } else if (waitingFrom !== undefined) {
                  const ms = now - waitingFrom;
                  waitingFrom = undefined;
                  waited.ms += ms;
                  endsAt = Math.min(caseEndsAt + waited.ms, waited.hardEnd);
                }
                arm();
              },
            }
          : {}),
        ...(this.deps.preparer && this.deps.installsDependencies
          ? {
              installDependencies: (signal: AbortSignal) =>
                this.installDependencies(item.id, signal),
            }
          : {}),
      });
    } catch (error) {
      return { finish: "none", error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
    }
  }

  private async accept(
    item: AutoCase,
    attempt: number,
    verification: VerificationResult,
    changed: string[],
    finished: boolean,
  ): Promise<boolean> {
    const passed = verification.commands.filter((c) => c.exitCode === 0).length;
    const message = [
      `auto: ${item.id}${finished ? "" : " (progress)"} ${oneLine(item.title)}`.slice(0, 100),
      "",
      "Verified, not reviewed: the project's checks passed in the run's container.",
      "",
      `Dispatch-Auto-Run: ${this.deps.runId}`,
      `Dispatch-Auto-Case: ${item.id}`,
      `Dispatch-Auto-Attempt: ${attempt}`,
      `Dispatch-Auto-Finish: ${finished ? "done" : "progress"}`,
      `Dispatch-Auto-Checks: ${passed}/${verification.commands.length} passed`,
      "Dispatch-Auto-Review: none",
    ].join("\n");
    const environment = (await this.deps.ledger.state()).environmentPaths;
    const commit = await commitCheckpoint(
      this.deps.repo,
      message,
      (path) => isCachePath(path) || under(path, environment),
    );
    if (!commit) return false;
    await this.deps.ledger.append({
      type: "checkpoint",
      caseId: item.id,
      commit,
      substantive: isSubstantive(changed, this.deps.scope ?? {}),
      reviewed: false,
    });
    if (finished) await this.deps.ledger.append({ type: "case_accepted", caseId: item.id });
    return true;
  }

  /** A tests-first case's accepted test files join the frozen set for later cases. */
  private async freezeTests(item: AutoCase, changed: string[]): Promise<void> {
    if (!item.writesTests) return;
    // Build output named like a test (dist/…/app.test.js) is rebuilt, not frozen.
    const paths = changed
      .filter((path) => isTestFile(path) && freezable(path))
      .filter((path) => !this.frozen.has(path));
    if (!paths.length) return;
    for (const path of paths) this.frozen.add(path);
    await this.deps.ledger.append({ type: "frozen", caseId: item.id, paths });
  }

  /**
   * Break the case's new code in up to two small ways and rerun the checks,
   * once per case. Returns the repair findings when a break went unnoticed.
   * Each change is journalled first, so a crash cannot leave it in the work.
   */
  private async mutationGate(item: AutoCase, attempt: number): Promise<string | undefined> {
    // A task that freezes its tests builds code too (the Planner plans no
    // tests-only tasks), and mutants come only from code, never test files.
    // Skipping writesTests tasks would leave a run with no mutation checks.
    if (!this.deps.mutationCheck) return undefined;
    const ledger = this.deps.ledger;
    const done = (await ledger.read()).some(
      ({ event }) => event.type === "mutation" && event.caseId === item.id,
    );
    if (done) return undefined;
    const patch = await this.casePatch();
    const tried: Array<{
      path: string;
      line: number;
      change: string;
      caught: boolean;
      mutant: Mutant;
    }> = [];
    for (const mutant of mutantsFromPatch(patch)) {
      if (tried.length >= MUTANTS_PER_ATTEMPT) break;
      const path = await mutableFile(this.deps.repo.worktree, mutant.path);
      if (!path) continue;
      const original = await readFile(path, "utf8").catch(() => undefined);
      const broken = original === undefined ? undefined : applyMutant(original, mutant);
      if (original === undefined || broken === undefined) continue;
      this.deps.onActivity?.(
        `${item.title}: mutation check, ${mutant.path}:${mutant.line} ${mutant.change}`,
      );
      await writePendingMutation(ledger.runDir, path, original);
      await writeFile(path, broken);
      let caught = true;
      try {
        const stop = this.stopSignal();
        try {
          caught = !(await this.deps.verifier.verify(this.deps.repo.worktree, stop.signal)).passed;
        } finally {
          stop.dispose();
        }
      } finally {
        await writeFile(path, original);
        await clearPendingMutation(ledger.runDir);
      }
      tried.push({ path: mutant.path, line: mutant.line, change: mutant.change, caught, mutant });
    }
    await ledger.append({
      type: "mutation",
      caseId: item.id,
      attempt,
      mutants: tried.map(({ path, line, change, caught }) => ({ path, line, change, caught })),
    });
    const survivors = tried.filter((t) => !t.caught).map((t) => t.mutant);
    return survivors.length
      ? survivorsForWorker(survivors, tried.length, this.frozen.size > 0)
      : undefined;
  }

  /** The case's changes since the last checkpoint as a patch, new files included. */
  private async casePatch(): Promise<string> {
    const repo = this.deps.repo;
    const tracked = await repo.output(["diff", "--no-color", "HEAD"]).catch(() => "");
    const untracked = (
      await repo.output(["ls-files", "--others", "--exclude-standard"]).catch(() => "")
    )
      .split("\n")
      .filter(Boolean);
    const added: string[] = [];
    for (const path of untracked) {
      // Only the worker's own files: a link it left may point anywhere.
      const file = await mutableFile(repo.worktree, path);
      const text = file ? await readFile(file, "utf8").catch(() => undefined) : undefined;
      if (text === undefined || text.length > 200_000 || text.includes("\u0000")) continue;
      const lines = text.replace(/\n$/, "").split("\n");
      added.push(
        `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}`,
      );
    }
    return [tracked, ...added].filter(Boolean).join("\n");
  }

  /** Test files the task's title or criteria name that are already in the project. */
  private async namedTestFiles(item: AutoCase): Promise<string[]> {
    const tracked = (await this.deps.repo.output(["ls-files"]).catch(() => ""))
      .split("\n")
      .filter(Boolean);
    return namedFiles(`${item.title}\n${item.acceptanceCriteria}`, tracked, { tests: true });
  }

  /**
   * Files the task's title or acceptance criteria name that this case may change
   * and has not touched, in this attempt or a checkpoint of it. Asked once a case.
   * The objective is left out: it names files to use as often as files to change.
   */
  private async untouchedNamedFiles(item: AutoCase, changed: string[]): Promise<string[]> {
    const ledger = this.deps.ledger;
    const asked = (await ledger.read()).some(
      ({ event }) =>
        event.type === "case_repair" &&
        event.caseId === item.id &&
        event.reason.startsWith(NAMED_CHALLENGE),
    );
    if (asked) return [];
    const tracked = (await this.deps.repo.output(["ls-files"]).catch(() => ""))
      .split("\n")
      .filter(Boolean);
    const named = namedFiles(`${item.title}\n${item.acceptanceCriteria}`, tracked).filter(
      (path) => !scopeViolations([path], this.deps.scope ?? {}, item.writable).length,
    );
    if (!named.length) return [];
    const touched = new Set(changed);
    const checkpoints =
      (await ledger.state()).cases.find((c) => c.id === item.id)?.checkpoints ?? [];
    for (const commit of checkpoints)
      for (const path of (
        await this.deps.repo.output(["show", "--name-only", "--format=", commit]).catch(() => "")
      ).split("\n"))
        if (path) touched.add(path);
    return named.filter((path) => !touched.has(path));
  }

  /**
   * The frozen tests a failure or a worker's words name: a failing frozen test,
   * a frozen test the case changed, or one a blocked claim points at. Only those
   * still frozen for this run.
   */
  private frozenNamed(text: string, violations: string[] = []): string[] {
    const named = new Set<string>();
    const listed = /\[frozen test failing: ([^\]]+)\]/.exec(text)?.[1];
    for (const path of listed?.split(",") ?? []) named.add(path.trim());
    for (const violation of violations)
      if (violation.endsWith(" (frozen test)"))
        named.add(violation.slice(0, -" (frozen test)".length));
    for (const path of this.frozen) if (text.includes(path)) named.add(path);
    return [...named].filter((path) => this.frozen.has(path) && !this.allowedFrozen.has(path));
  }

  /** Frozen tests in a case's way: the Planner may let the rest of the run change them. */
  private async askAboutFrozen(
    item: AutoCase,
    failure: string,
    tests: string[],
  ): Promise<Array<{ path: string; reason: string }>> {
    if (!tests.length || !this.deps.onFrozenBlocked) return [];
    const stop = this.stopSignal();
    try {
      const allowed = (
        await this.deps.onFrozenBlocked(
          { title: item.title, failure: failure.slice(0, 1500), tests },
          stop.signal,
        )
      )
        .filter((entry) => tests.includes(entry.path) && entry.reason.trim())
        .map((entry) => ({ path: entry.path, reason: entry.reason.trim() }));
      if (!allowed.length) return [];
      for (const entry of allowed) this.allowedFrozen.set(entry.path, entry.reason);
      await this.deps.ledger.append({ type: "frozen_allowed", caseId: item.id, allowed });
      return allowed;
    } catch (error) {
      this.deps.onActivity?.(
        `No decision on frozen tests: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    } finally {
      stop.dispose();
    }
  }

  /** A case as it runs: with the frozen tests the Planner let the run change. */
  private withAllowedFrozen(item: AutoCase): AutoCase {
    const extra = [...this.allowedFrozen].filter(
      ([path]) => !item.frozenTestsToChange?.includes(path),
    );
    if (!extra.length) return item;
    return {
      ...item,
      frozenTestsToChange: [...(item.frozenTestsToChange ?? []), ...extra.map(([path]) => path)],
      frozenChangeReason: [
        item.frozenChangeReason,
        ...extra.map(([path, why]) => `${path}: ${why}`),
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  private async giveUp(caseId: string, attempt: number, reason: string): Promise<void> {
    if (attempt > 0) await this.saveAttemptDraft(caseId, attempt, "abandoned");
    await this.resetToLastCheckpoint();
    await this.deps.ledger.append({ type: "case_abandoned", caseId, reason });
  }

  private async saveAttemptDraft(caseId: string, attempt: number, label: string): Promise<void> {
    const dir = join(this.deps.ledger.runDir, "drafts");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `${caseId}-${attempt}-${label}`.replace(/[^A-Za-z0-9._-]/g, "_");
    const draft = await saveDraft(
      this.deps.repo,
      `refs/auto/${this.deps.runId}/drafts/${name}`,
      join(dir, `${name}.patch`),
      name,
    );
    if (draft) {
      await this.deps.ledger.append({
        type: "draft_saved",
        caseId,
        attempt,
        ref: draft.ref,
        patchSha256: draft.patchSha256,
      });
    }
  }

  private async resetToLastCheckpoint(): Promise<void> {
    await resetToCheckpoint(this.deps.repo, "HEAD", {
      mirrorDir: this.deps.mirror.dir,
      runsRoot: this.deps.runsRoot,
    });
    await this.removeEnvironmentAdditions();
  }

  /**
   * Git leaves ignored folders such as node_modules alone, so what a given-up
   * case added there outlived it and every later case was refused for it.
   * Files setup installed and a case changed are not
   * restored here; the environment check still refuses those.
   */
  private async removeEnvironmentAdditions(): Promise<string[]> {
    const paths = (await this.deps.ledger.state()).environmentPaths;
    const recorded = await loadManifest(this.environmentFile());
    if (!recorded || !paths.length) return [];
    const worktree = this.deps.repo.worktree;
    const added = environmentAdditions(recorded, await environmentManifest(worktree, paths));
    for (const path of added) {
      const target = resolve(worktree, path);
      if (target.startsWith(`${resolve(worktree)}${sep}`))
        await rm(target, { recursive: true, force: true });
    }
    return added;
  }

  /**
   * The checks, waiting out a container runtime that is down (the VM stopped)
   * rather than counting that against the worker. If it stays down the run
   * ends ready to resume, with the attempt's work saved.
   */
  private async verifyOrWait(
    caseId: string,
    attempt: number,
  ): Promise<VerificationResult | Ending> {
    const waits = this.deps.inferenceWaitsMs ?? INFERENCE_WAITS_MS;
    const stopped: Ending = {
      outcome: "cancelled_after_checkpoint",
      reason: "stopped by the owner",
    };
    for (let n = 0; ; n++) {
      const stop = this.stopSignal();
      try {
        const result = await this.deps.verifier.verify(this.deps.repo.worktree, stop.signal);
        // Checks cut short by a stop decide nothing; the case resumes where it was.
        return this.stopNow ? stopped : result;
      } catch (error) {
        if (this.stopNow) return stopped;
        const message = error instanceof Error ? error.message : String(error);
        if (n >= waits.length)
          return {
            outcome: "blocked_for_input",
            reason: `The container runtime stayed unavailable (${message}). The work so far is saved; resume the run when it is back.`,
          };
        await this.deps.ledger.append({
          type: "inference_wait",
          caseId,
          attempt,
          error: message,
          seconds: Math.round(waits[n] / 1000),
          on: "container",
        });
        await this.wait(waits[n]);
        if (this.stopNow || this.stopAfterCase) return stopped;
      } finally {
        stop.dispose();
      }
    }
  }

  private async writeLog(name: string, verification: VerificationResult): Promise<void> {
    const dir = join(this.deps.ledger.runDir, "verify");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir, name.replace(/[^A-Za-z0-9._-]/g, "_")),
      verification.commands
        .map((c) => `$ ${c.command}\n[exit ${c.exitCode}]\n${c.output}\n`)
        .join("\n"),
      { mode: 0o600 },
    );
  }

  /** Sleep, looking for a stop request as often as during an attempt. */
  private async wait(ms: number): Promise<void> {
    const until = this.clock().getTime() + ms;
    const step = this.deps.controlPollMs ?? 5000;
    while (this.clock().getTime() < until && !this.stopNow && !this.stopAfterCase) {
      await new Promise((done) =>
        setTimeout(done, Math.min(step, Math.max(0, until - this.clock().getTime()))),
      );
      await this.pollControl();
    }
  }

  /** A signal that aborts on a stop-now request, for checks and setup, which run outside an attempt. */
  private stopSignal(): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const poll = setInterval(() => {
      void this.pollControl()
        .then(() => {
          if (this.stopNow) controller.abort(new Error("stopped by the owner"));
        })
        .catch(() => undefined);
    }, this.deps.controlPollMs ?? 5000);
    return { signal: controller.signal, dispose: () => clearInterval(poll) };
  }

  private async pollControl(): Promise<void> {
    await this.pollInbox();
    const control = await this.deps.ledger.readControl();
    if (!control) return;
    if (control.command === "stop_now" && !this.stopNow) {
      this.stopNow = true;
      await this.deps.ledger.append({ type: "stop_requested", mode: "now" });
    } else if (control.command === "stop" && !this.stopAfterCase) {
      this.stopAfterCase = true;
      await this.deps.ledger.append({ type: "stop_requested", mode: "after_case" });
    }
  }

  /** The inbox: Pause stops after the case, Stop now stops at once, a message is recorded. */
  private async pollInbox(): Promise<void> {
    const ledger = this.deps.ledger;
    if (!this.inboxTaken)
      this.inboxTaken = new Set(
        (await ledger.read()).flatMap(({ event }) => (event.type === "inbox" ? [event.id] : [])),
      );
    for (const entry of await ledger.readInbox()) {
      if (this.inboxTaken.has(entry.id)) continue;
      this.inboxTaken.add(entry.id);
      await ledger.append({
        type: "inbox",
        id: entry.id,
        cmd: entry.cmd,
        ...(entry.text ? { text: entry.text } : {}),
      });
      if (entry.cmd === "stop_now" && !this.stopNow) {
        this.stopNow = true;
        await ledger.append({ type: "stop_requested", mode: "now" });
      } else if (entry.cmd === "pause" && !this.stopAfterCase && !this.stopNow) {
        this.stopAfterCase = true;
        await ledger.append({ type: "stop_requested", mode: "after_case" });
      }
    }
  }

  private async end(state: AutoRunState, ending: Ending): Promise<AutoOutcome> {
    if (!state.outcome)
      await this.deps.ledger.append({
        type: "run_ended",
        outcome: ending.outcome,
        reason: ending.reason,
      });
    await this.deps.ledger.clearControl();
    return ending.outcome;
  }
}

/**
 * Changed paths that are links leading out of the worktree: committed, they
 * would point the owner's folder at files the project does not own.
 */
async function linksOutside(worktree: string, changed: string[]): Promise<string[]> {
  const root = await realpath(worktree);
  const found: string[] = [];
  for (const path of changed) {
    const full = join(worktree, path);
    if (!(await lstat(full).catch(() => undefined))?.isSymbolicLink()) continue;
    const target = resolve(dirname(full), await readlink(full));
    if (target !== root && !target.startsWith(`${root}${sep}`))
      found.push(`${path} (a link out of the project)`);
  }
  return found;
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

/** How a run ends when no case is left that can run. */
function finalOutcome(state: AutoRunState): Ending {
  const accepted = state.cases.every((c) => c.stage === "accepted");
  if (accepted) return { outcome: "objective_met", reason: "every case verified" };
  const abandoned = state.cases.filter((c) => c.stage === "abandoned").map((c) => c.id);
  const reason = `no case left that can run${abandoned.length ? ` (abandoned: ${abandoned.join(", ")})` : ""}`;
  if (state.cases.some((c) => c.stage === "blocked"))
    return { outcome: "blocked_for_input", reason };
  // A case abandoned at its repair limit leaves its dependents unable to run;
  // with accepted work behind it, that is a limit reached, not a failed run.
  if (state.cases.some((c) => c.stage === "accepted"))
    return { outcome: "limit_reached_with_accepted_work", reason };
  return { outcome: "failed", reason };
}

function firstFailure(result: VerificationResult): string {
  const failed = result.commands.find((c) => c.exitCode !== 0);
  return failed
    ? `\`${failed.command}\` exited ${failed.exitCode ?? "without a code"}`
    : "no check ran";
}

/**
 * The line of a failed check's output that names the failure. A passing
 * test's stderr, or its name, can say "fails", so the signature must not
 * name a passing test when others failed.
 */
export function failingLine(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("stderr |"));
  return (
    lines.find((l) => /^(FAIL|×|✗)\s|AssertionError|^Error:|error TS\d+/.test(l)) ??
    lines.find((l) => /error|fail|assert/i.test(l)) ??
    ""
  );
}

/**
 * The project files a task's text names (`main.tsx`, `src/server/app.ts`): a
 * name that matches exactly one tracked file. Test files are left out, as
 * criteria often name a test as an example, unless `tests` asks for only them.
 */
export function namedFiles(
  text: string,
  tracked: readonly string[],
  { tests = false }: { tests?: boolean } = {},
): string[] {
  const tokens = new Set(
    text.match(
      /[\w@./-]*\w\.(?:tsx?|jsx?|mjs|cjs|rs|py|go|swift|kt|java|rb|css|scss|html|vue|svelte|toml|ya?ml|sql|sh)\b/g,
    ) ?? [],
  );
  const found = new Set<string>();
  for (const token of tokens) {
    const name = token.replace(/^\.\//, "");
    const matches = tracked.filter((path) =>
      name.includes("/") ? path === name || path.endsWith(`/${name}`) : basename(path) === name,
    );
    if (matches.length === 1 && isTestFile(matches[0]) === tests) found.add(matches[0]);
  }
  return [...found];
}

/** The frozen test files a failed check's FAIL lines name. */
export function failingFrozenTests(
  verification: VerificationResult,
  frozen: ReadonlySet<string>,
): string[] {
  const failed = verification.commands.filter((c) => c.exitCode !== 0 || c.error);
  return [...frozen].filter((path) =>
    failed.some((c) =>
      c.output.split("\n").some((l) => /^\s*(FAIL|×|✗)\s/.test(l) && l.includes(path)),
    ),
  );
}

export function failureReason(
  result: CaseAttemptResult,
  verification: VerificationResult,
  violations: string[],
  noChanges: boolean,
  frozen: ReadonlySet<string> = new Set(),
): { signature: string; details: string } {
  // A command can fail with exit 0: a test run that ran no tests verified nothing.
  const failed = verification.commands.filter((c) => c.exitCode !== 0 || c.error);
  if (violations.length) {
    const nested = violations.filter(isNestedRepository);
    return {
      signature: `scope: ${violations[0]}`,
      details: [
        nested.length
          ? `These folders are Git repositories inside the project, which Dispatch never commits: ${nested.join(", ")}. Remove their .git folders or the folders.`
          : "",
        violations.length > nested.length
          ? `These paths are outside what the case may change: ${violations.filter((v) => !isNestedRepository(v)).join(", ")}. Undo those changes.`
          : "",
        violations.some((v) => v.endsWith(" (frozen test)"))
          ? "Tests accepted earlier are frozen: put new tests in a new test file."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }
  if (failed.length) {
    const first = failed[0];
    const line = first.error ?? failingLine(first.output);
    // A failing test the case may not change: the Planner can only allow it
    // or plan around it if the reason says so.
    const failingFrozen = failingFrozenTests(verification, frozen);
    return {
      signature: `check: ${first.command} :: ${line.slice(0, 120)}${failingFrozen.length ? ` [frozen test failing: ${failingFrozen.slice(0, 3).join(", ")}]` : ""}`,
      details: failed
        .map((c) =>
          c.exitCode === 0 && c.error
            ? `Command \`${c.command}\` exited 0, but: ${c.error}`
            : `Command \`${c.command}\` exited ${c.exitCode}:\n${c.output.slice(-3000)}`,
        )
        .join("\n\n"),
    };
  }
  if (result.error)
    return { signature: `error: ${result.error.slice(0, 120)}`, details: result.error };
  if (noChanges)
    return {
      signature: "no changes",
      details: "The attempt changed no files. Make the change the case asks for.",
    };
  return {
    signature: "not finished",
    details:
      "Every check passes and the progress is saved, but the case was not declared finished. Complete the case and call finish_case.",
  };
}
