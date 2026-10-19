import { boardChanges, isPlaceholderText } from "@shared/board-changes";
import {
  CAPABILITY_EVIDENCE_CAVEAT,
  capabilityEvidenceSentence,
  capabilityStatus,
  TASK_KIND_CAPABILITY,
} from "@shared/capabilities";
import {
  type CompactionEvent,
  type CompactOutcome,
  type ContextUsage,
  compactionNoticeText,
  MAX_COMPACT_INSTRUCTIONS,
} from "@shared/compaction";
import { composerSendBlocked } from "@shared/composer-guard";
import { inferenceApprovalText, routeConsequence } from "@shared/inference-approval";
import { milestoneProblems } from "@shared/milestones";
import { projectReach } from "@shared/network";
import { resolveReasoning } from "@shared/reasoning";
import {
  coverageNote,
  disputedRequirements,
  ledgerBlock,
  ledgerLine,
  mergeRequirements,
  openIssues,
  openRequirements,
  type ProposedRequirement,
  parseVerdicts,
  requirementCoverage,
  settleRequirements,
  unverifiedRequirements,
} from "@shared/requirements";
import {
  catalogProfileForDestination,
  effectiveDestination,
  interactiveUnavailableReason,
  managerChoice,
  sameRuntimeSlot,
  savedRoleAuthorizesDestination,
} from "@shared/roles";
import { normalizeAccessRoot, readRootsFor, writeRootsFor } from "./access-roots";
import { lockBlockedMessage } from "./folder-lock.js";
import {
  expectsRedTests,
  freezeAccepted,
  frozenBriefNote,
  frozenDrift,
  frozenNamedIn,
  frozenRefusal,
  frozenTestsIn,
  keepFrozenCopies,
  restoreFrozenTests,
} from "./frozen-tests";
import { compilePlanProposal } from "./plan-compiler";
import {
  classifyInfrastructureError,
  INFRASTRUCTURE_ERROR,
  shouldDeferInfrastructureRecovery,
} from "./recovery";
import { shouldPauseOnDispatchSession } from "./session-pause";
import { oversizeReason, taskSizeNotes } from "./task-size";
import {
  checksPassed,
  managerReadableRoot,
  projectWorkingRoot,
  verificationFailed,
} from "./workflow-support";

export { canDispatchStatus, createProjectFromFiles } from "./workflow-support";

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { ToolJournal } from "@core/tool-journal";
import { escalationSettings, nextEscalation, rungOfTask } from "@shared/escalation";
import { autoApprovalNotice, effectiveToolTrust, type ToolTrustMode } from "@shared/permissions";
import {
  fixRoundsPerTask,
  isTurnBudgetStop,
  MAX_RECOVERIES_PER_TASK,
  managerTurnsForPlan,
  TURN_BUDGET_STOP,
} from "@shared/policy-limits";
import { isLiveAttempt, runStopBlocksResume } from "@shared/project-status";
import { buildStuckTaskBrief } from "@shared/stuck-task";
import type {
  AttemptRecord,
  CapabilityName,
  ChatMessage,
  NeedsInputKind,
  PauseCause,
  PlanRecord,
  ProjectRecord,
  QuestionOption,
  Requirement,
  TaskKind,
  TaskRecord,
} from "@shared/types";
import {
  FOLDER_CHOICE,
  MAX_QUESTION_OPTIONS,
  PI_VERSION,
  QUESTION_OPTION_PREFIX,
  resolveTaskRoute,
} from "@shared/types";
import type { ApprovalBroker } from "./approval-broker";
import { writeJsonAtomic } from "./atomic-write.js";
import { INTERACTIVE_ATTEMPT_LIMIT_ERROR, isAttemptTimeLimit } from "./attempt-limit.js";
import {
  escalationPolicyKey,
  externalEscalationsUsed,
  OPERATIONAL_FAILURE,
  validEscalationGrant,
} from "./escalation";
import {
  classifyAttemptFailure,
  classifyLoopOutcome,
  isInterruptAttempt,
} from "./failure-class.js";
import { safeReadFile } from "./file-access";
import { trustedRuntimeDirectories } from "./host-tools.js";
import { newId, nowIso, sha256Text } from "./ids.js";
import {
  classifyBoardWrite,
  mergeSectionItems,
  retainTaskIdentity,
  taskIdentity,
  tasksSectionState,
  upsertSectionItems,
} from "./inspector-board.js";
import type { WorkerPort } from "./interactive-worker";
import {
  applyMutant,
  MUTANTS_PER_ATTEMPT,
  type Mutant,
  mutableFile,
  mutantsFromPatch,
  survivorsRefusal,
} from "./mutation-check.js";
import { projectFiles } from "./paths.js";
import { type PoundlockApi, PoundlockError } from "./poundlock.js";
import { normalizeProjectBrief, PROJECT_BRIEF_MAX_CHARS } from "./project-brief.js";
import { environmentRecord, PythonUvAdapter, selectProjectEnvironment } from "./python-uv.js";
import { buildManagerReviewPrompt, checksLine, limitManagerReviewTurn } from "./review-context.js";
import {
  lastApprovedWorkerRevision,
  projectWorkerRoles,
  RouteRevisionChangedError,
  resolveInteractiveWorkerProfile,
  resolveVerifierProfile,
} from "./role-routing.js";
import { listLiveProjectFiles } from "./snapshot.js";
import { FileStore } from "./store.js";
import {
  canManagerReviewWithoutCheck,
  changedFilesForReview,
  isDocumentationOnlyChange,
} from "./task-evidence.js";
import { wrapUntrusted } from "./untrusted.js";
import { assertWorkflowCanDispatch, newWorkflowIdentity } from "./workflow-identity.js";

export interface ManagerTurnResult {
  /** Everything the manager said this turn, including text before a tool call. */
  text: string;
  /** The reasoning setting the turn ran with. */
  reasoning?: import("@shared/types").ReasoningChoice;
  toolTrace: Array<{ name: string; summary: string; error?: boolean }>;
  capacityBlocked?: boolean;
  infrastructureError?: string;
}

export interface ManagerPort {
  reset?(projectId: string): Promise<void>;
  abort?(projectId: string): Promise<void>;
  runTurn(ctx: ManagerTurnContext): Promise<ManagerTurnResult>;
  /**
   * Compacts the project's conversation now, between turns. Absent for a
   * manager that keeps no conversation of its own.
   */
  compact?(ctx: ManagerCompactContext): Promise<CompactOutcome>;
}

export interface ManagerTurnContext {
  /** The owner's own message started this turn or is part of it. */
  fromOwner?: boolean;
  signal?: AbortSignal;
  project: ProjectRecord;
  workspace: string;
  prompt: string;
  host: ManagerToolHost;
  onActivity?: (text: string) => void;
  /**
   * The manager's reply as it arrives, cumulative, or `undefined` when the
   * turn is over and the draft should be dropped. Distinct from `onActivity`:
   * that names what Dispatch is doing, this is what the model is saying.
   */
  onDraft?: (text: string | undefined) => void;
  onCapacityWait?: (state: import("./capacity-retry").CapacityWaitState) => void | Promise<void>;
  /** Resolved by the manager provider (`resolveReasoning`); absent means Model default. */
  reasoning?: import("@shared/types").ReasoningChoice;
  /**
   * The project brief to pin in the manager's context for this turn, as saved.
   * Empty or absent when the project has none. Capping and the truncation note
   * are the manager's to apply (`pinnedBriefBlock`).
   */
  projectBrief?: string;
  /** The requirement ledger as a block to pin beside the brief (`ledgerBlock`), or empty. */
  ledger?: string;
  /**
   * Called when the manager's session compacts itself during the turn, or
   * just after it. The notice for the owner is the orchestrator's to write.
   */
  onCompaction?: (event: CompactionEvent) => void;
  /**
   * How full the conversation's context is, reported after the turn and after
   * a compaction; `undefined` when the conversation was reset.
   */
  onContextUsage?: (usage: ContextUsage | undefined) => void;
}

/**
 * Compacting the conversation without a turn: the turn's wiring, plus what to
 * focus the summary on. The brief is not here: it rides in each turn's system
 * prompt, so there is nothing of it in the conversation to summarise.
 */
export interface ManagerCompactContext
  extends Omit<ManagerTurnContext, "prompt" | "onDraft" | "projectBrief" | "workspace"> {
  instructions?: string;
}

export interface ManagerToolHost {
  readNotes(): Promise<string>;
  writeNotes(notes: string): Promise<string>;
  /** Replaces the pinned project brief; refuses one over `PROJECT_BRIEF_MAX_CHARS`. */
  writeBrief(brief: string): Promise<string>;
  listFiles(): Promise<Array<{ path: string; bytes: number }>>;
  readFile(path: string): Promise<string>;
  listProfiles(): Promise<
    Array<{
      id: string;
      name: string;
      contextTokens: number;
      readiness: string;
      lastCheck?: string;
      /** One plain sentence per measured capability, plus a fixed caveat. Absent when none are published. */
      capabilities?: string[];
    }>
  >;
  proposePlan(input: ProposePlanInput, signal?: AbortSignal): Promise<string>;
  askUser(question: string, options?: QuestionOption[]): Promise<string>;
  /** Ask the owner to let this project use a folder outside it. Ends the turn. */
  requestFolderAccess(input: {
    path: string;
    mode: "read" | "write";
    reason: string;
  }): Promise<string>;
  requestEscalation(input: {
    target: "manager" | "worker";
    taskId?: string;
    findings: string;
    revisedPrompt?: string;
  }): Promise<string>;
  delegateTask(input: ProposePlanInput["tasks"][number]): Promise<string>;
  investigate(input: InvestigationInput, signal?: AbortSignal): Promise<string>;
  requestRepair(taskId: string, findings: string, freshSession?: boolean): Promise<string>;
  requestApplyResult(taskId: string): Promise<string>;
  markComplete(summary: string): Promise<string>;
  /** Record a question or problem for the owner, raised when the round of tasks ends. */
  noteIssue(input: { text: string; requirementId?: string }): Promise<string>;
  /** Drop a requirement from the ledger on the owner's quoted word. */
  waiveRequirement(input: { id: string; ownerWords: string }): Promise<string>;
}

/** A question for a read-only worker, from the manager's `investigate` tool. */
export interface InvestigationInput {
  title: string;
  question: string;
  instructions: string;
  /** "verifier": run on the Verifier role when one is bound, else the worker. */
  role?: "verifier";
}

export interface ProposePlanInput {
  summary: string;
  acceptanceCriteria: string[];
  tasks: Array<{
    title: string;
    objective: string;
    workerPrompt: string;
    acceptanceCriteria: string;
    dependsOn?: string[];
    difficulty: "small" | "medium" | "large";
    /** Absent reproduces today's routing exactly — see `TaskKind` in `@shared/types`. */
    taskKind?: TaskKind;
    route?: "interactive" | "snippet";
    contextNote?: string;
    filesToTouch?: string[];
    reuse?: string[];
    writesTests?: boolean;
    changesFrozenTests?: boolean;
    /** Ledger requirements this task serves. */
    requirementIds?: string[];
    milestoneId?: string;
  }>;
  /** The owner's requirements, merged into the ledger kept across revisions. */
  requirements?: ProposedRequirement[];
  /** The spec's milestones; absent keeps the previous plan's. */
  milestones?: import("@shared/types").Milestone[];
  architecture?: string;
  scopeOut?: string[];
  /** Titles of published tasks a board update removes; every other task is kept. */
  removeTasks?: string[];
  allowDependencyDownloads?: boolean;
  environmentNeed?: "none" | "python";
}

/**
 * The board after a manager's update during a run: published tasks in order,
 * those the update names replaced in place, new ones inserted before the first
 * task that depends on them (else at the end), and only `removeTasks` dropped.
 */
export function amendedBoard(
  published: TaskRecord[],
  proposed: TaskRecord[],
  removeTasks: string[],
): TaskRecord[] {
  const removed = new Set(removeTasks.map((title) => title.trim().toLowerCase()));
  // A task that waited on a removed one now waits on what that one waited on;
  // left as it was, the board could never be approved (13 Oct).
  const handedOn = new Map(
    published
      .filter((task) => removed.has(taskIdentity(task)))
      .map((task) => [task.id, task.dependsOn ?? []]),
  );
  const resolve = (ids: string[], seen = new Set<string>()): string[] => [
    ...new Set(
      ids.flatMap((id) =>
        handedOn.has(id) && !seen.has(id)
          ? resolve(handedOn.get(id) ?? [], new Set([...seen, id]))
          : handedOn.has(id)
            ? []
            : [id],
      ),
    ),
  ];
  const rewire = (task: TaskRecord): TaskRecord =>
    (task.dependsOn ?? []).some((id) => handedOn.has(id))
      ? { ...task, dependsOn: resolve(task.dependsOn) }
      : task;
  const board = published.filter((task) => !removed.has(taskIdentity(task))).map(rewire);
  const fresh: TaskRecord[] = [];
  for (const task of proposed.map(rewire)) {
    const index = board.findIndex((item) => taskIdentity(item) === taskIdentity(task));
    if (index >= 0) board[index] = task;
    else fresh.push(task);
  }
  for (const task of fresh) {
    const dependent = board.findIndex((item) => (item.dependsOn ?? []).includes(task.id));
    if (dependent >= 0) board.splice(dependent, 0, task);
    else board.push(task);
  }
  return board;
}

/**
 * Running a command on this machine, supplied by the composition root.
 *
 * The orchestrator decides *whether* a command may run; the sandbox and the
 * process are a host concern. Importing them directly pointed `core` at
 * `runtime`, which is the one direction the layering guard exists to stop —
 * and it did not catch it, because it only looked for Electron.
 */
export interface HostCommandPort {
  run: typeof import("@runtime/host-command").runHostCommand;
  approvalAction: typeof import("@runtime/host-command").commandApprovalAction;
  approvalDisplay: typeof import("@runtime/host-command").commandApprovalDisplay;
  buildSandboxRequest: typeof import("@runtime/sandbox-policy").buildSandboxRequest;
}

export interface OrchestratorDeps {
  worker: WorkerPort;
  /** How this host runs a command. Without it, environment setup is refused. */
  hostCommands?: HostCommandPort;
  approvals?: ApprovalBroker;
  reviewAction?: import("./interactive-worker").WorkerContext["reviewAction"];
  store: FileStore;
  clientFor: () => Promise<PoundlockApi>;
  manager: ManagerPort;
  /** Cross-process fence for the folder a run writes into. See `FolderLock`. */
  folderLock?: import("./folder-lock").FolderLockPort;
  clock?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  notify?: () => void | Promise<void>;
  onActivity?: (text: string, projectId?: string) => void;
  /** The manager's in-flight reply. `undefined` drops it. See `AppStateView.managerDraft`. */
  onManagerDraft?: (text: string | undefined, projectId: string) => void;
  /** The manager conversation's context use. `undefined` drops it. See `AppStateView.contextUsage`. */
  onContextUsage?: (usage: ContextUsage | undefined, projectId: string) => void;
  onUsageRefresh?: () => void | Promise<void>;
}

/**
 * The structured `needsInput.kind` for a failed role/profile resolution: a
 * changed route gets its own kind so the status view can give the specific
 * "re-approve in Settings → Models and routing" instruction instead of
 * generic configuration wording, and so nothing downstream has to guess by
 * matching the error text. See `role-routing.ts`'s `RouteRevisionChangedError`.
 */
export function roleResolutionNeedsInputKind(error: unknown): NeedsInputKind {
  return error instanceof RouteRevisionChangedError ? "route_change" : "configuration";
}

const REPAIR_FINDINGS = "\n\nRepair findings from review:\n";

/** Requirements one round-end verification judges; more wait for the next round. */
const VERIFIED_PER_ROUND = 12;

/** Plans this size need the owner's requirements listed first. */
const LEDGER_REQUIRED_TASKS = 3;
/** Each unread owner message a turn leads with, at most. */
const UNREAD_OWNER_CHARS = 4_000;
/** The owner's words a plan review sees: the start and the latest. */
const PLAN_REVIEW_OWNER_CHARS = 16_000;

/**
 * Why an escalation is refused after the owner declined it. A local manager
 * asked for the same workstation escalation on two tasks in an hour (13 Oct).
 */
export function declinedEscalationNote(profileName: string): string {
  return `The owner declined escalation to ${profileName} in this run. Do not request it again: revise the plan, or call ask_user to offer a retry on the current rung (the owner's answer resets the task's fix rounds). It is offered again if the owner mentions escalation in a message.`;
}

/**
 * The worker brief with only the latest review's findings. Appending every
 * round could leave a brief with six, the oldest asking for work long done;
 * a session that continues has the earlier ones.
 */
export function withRepairFindings(prompt: string, findings: string): string {
  return `${prompt.split(REPAIR_FINDINGS)[0]}${REPAIR_FINDINGS}${findings}`;
}

export class ProjectOrchestrator {
  private readonly clock: () => Date;
  private turning = new Set<string>();
  private polling = new Set<string>();
  private dispatching = new Set<string>();
  private localRuns = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private managerSignals = new Map<string, AbortController>();
  private folderRuns = new Set<string>();
  /** Projects already told they are not the writer, so the poll says it once. */
  private lockBlocked = new Set<string>();
  private managerRetries = new Map<string, { prompt: string; after: number; startedAt: number }>();
  private infrastructureRetries = new Map<string, { after: number; startedAt: number }>();
  private respondingToInput = new Set<string>();
  private managerHandoffs = new Map<string, string>();
  private stopIntents = new Map<string, "paused" | "cancelled">();
  /** Owner messages seen at each project's last plan review: one review per owner message. */
  private planReviewedAt = new Map<string, number>();
  /** Briefs already told they name frozen tests, by project and task. */
  private frozenBriefsNoted = new Set<string>();
  async waitForLocal(projectId: string): Promise<void> {
    await this.localRuns.get(projectId)?.done;
  }

  /** True while this process is running manager, worker, dispatch or polling work for the project. */
  isBusy(projectId: string): boolean {
    return (
      this.turning.has(projectId) ||
      this.polling.has(projectId) ||
      this.dispatching.has(projectId) ||
      this.localRuns.has(projectId)
    );
  }

  /** Whether a manager turn is running for the project; a message sent now waits for the next one. */
  isManagerTurning(projectId: string): boolean {
    return this.turning.has(projectId);
  }

  hasBackgroundWork(): boolean {
    return this.localRuns.size > 0 || this.turning.size > 0 || this.dispatching.size > 0;
  }
  async shutdown(): Promise<void> {
    const active = (await this.deps.store.listProjects()).filter(shouldPauseOnDispatchSession);
    const ids = new Set([
      ...active.map((project) => project.id),
      ...this.localRuns.keys(),
      ...this.managerSignals.keys(),
    ]);
    for (const id of ids) {
      const project = await this.deps.store.getProject(id);
      if (project && ["completed", "cancelled"].includes(project.status)) {
        this.managerSignals.get(id)?.abort();
        await this.deps.manager.abort?.(id);
      } else await this.pause(id, { cause: "quit" });
    }
    // Wait for both an aborted interactive worker and an aborted manager
    // turn to actually finish (write their retained state) before Dispatch
    // quits — an abort signal stops the work, but the turn or run still
    // needs to run its own cleanup.
    await Promise.all([
      ...[...this.localRuns.values()].map((run) => run.done),
      ...this.managerTurnRuns.values(),
    ]);
  }

  constructor(private readonly deps: OrchestratorDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Whether a manager turn now would take the running local worker's model
   * slot away from it: a different profile on the same exclusive slot.
   *
   * Requests on one slot interleave, one generation at a time. With the same
   * profile in both roles that costs nothing but a short wait. With two
   * profiles it swaps the loaded model on every exchange — the worker's next
   * request reloads its model, the manager's next reloads the other — so each
   * reply would cost two model loads. Unknown answers are "no": this only
   * defers a reply, and must never hold one back on a guess.
   */
  private async managerWouldEvictWorker(projectId: string): Promise<boolean> {
    try {
      const project = await this.requireProject(projectId);
      const running = (await this.deps.store.getTasks(projectId))
        .flatMap((task) => task.attempts)
        .find((attempt) => attempt.status === "running" && attempt.execution === "interactive");
      if (!running?.profileId) return false;
      const connection = await this.deps.store.getConnection();
      const managerId = managerChoice(project, connection.roles).id;
      const models = await (await this.deps.clientFor()).listInteractiveModels();
      const find = (id: string) =>
        models.find((model) => [model.profileId, model.id, ...(model.aliases ?? [])].includes(id));
      const worker = find(running.profileId);
      const manager = find(managerId);
      if (!worker || !manager) return false;
      return (
        (worker.profileId ?? worker.id) !== (manager.profileId ?? manager.id) &&
        sameRuntimeSlot(worker, manager)
      );
    } catch {
      return false;
    }
  }

  async sendMessage(projectId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const blocked = composerSendBlocked({
      approvals: this.deps.approvals?.list(),
      projectId,
    });
    if (blocked) throw new Error(blocked);
    // A poll-driven manager turn sets no busy key, so the composer stays open
    // while one is running. Everything below mutates the project before
    // `managerTurn` reaches its "already has an active manager turn" throw —
    // which left the status changed, `needsInput` cleared and the question
    // gone from the screen, with the message never answered. Record the
    // message where the running turn's successor will read it, and say so.
    if (this.turning.has(projectId)) {
      await this.queueOwnerMessage(projectId, trimmed);
      await this.appendSystem(
        projectId,
        "The Project Manager is mid-turn. Your message is in the conversation and will be read on its next turn.",
      );
      return;
    }
    if (this.localRuns.has(projectId) && (await this.managerWouldEvictWorker(projectId))) {
      await this.queueOwnerMessage(projectId, trimmed);
      await this.appendSystem(
        projectId,
        "The worker is using this machine's only model slot, and the Project Manager runs a different model on it. Answering now would unload the worker's model mid-task. Your message is in the conversation and the manager will read it when the worker finishes.",
      );
      return;
    }
    const project = await this.requireProject(projectId);
    const previousStatus = project.status;
    const previousPause = project.pause;
    if (project.needsInput && project.status === "needs_input")
      this.respondingToInput.add(projectId);
    this.stopIntents.delete(projectId);
    if (project.status === "cancelled") {
      project.budget.managerTurnsUsed = 0;
      project.managerEscalation = undefined;
    }
    this.managerRetries.delete(projectId);
    this.infrastructureRetries.delete(projectId);
    project.infrastructureIssue = undefined;
    // Asking about escalation in their own words lifts the owner's earlier no.
    if (/escalat/i.test(trimmed)) project.declinedEscalations = undefined;
    // Replying about a stuck task is an explicit user decision: it resets
    // that task's loop counters (attempt history stays as evidence), and
    // rescues a project left in the pre-Phase-1 dead end (a task failed with
    // a recorded budget-exhausted stop). See also retryTask.
    const legacyStopReason =
      project.budget.stopReason &&
      /repair budget exhausted|recovery budget exhausted/i.test(project.budget.stopReason);
    const tasksBeforeTurn = await this.deps.store.getTasks(projectId);
    const stuckTasks = tasksBeforeTurn.filter(
      (task) => task.stuck || (legacyStopReason && task.status === "failed"),
    );
    if (stuckTasks.length) {
      for (const task of stuckTasks) {
        task.repairCount = 0;
        task.recoveryCount = 0;
        task.stuck = undefined;
        task.freshWorkerSession = true;
      }
      await this.deps.store.saveTasks(projectId, tasksBeforeTurn);
      if (legacyStopReason) project.budget.stopReason = undefined;
    }
    if (
      project.needsInput &&
      !(await this.deps.store.getMessages(projectId)).some(
        // The question may be preceded by what the manager said before asking.
        (m) =>
          Boolean(project.needsInput?.question) && m.text.includes(project.needsInput!.question),
      )
    )
      await this.appendMessage(projectId, {
        id: newId("msg"),
        role: "manager",
        text: project.needsInput.question,
        createdAt: project.needsInput.askedAt,
      });
    await this.appendMessage(projectId, {
      id: newId("msg"),
      role: "user",
      text: trimmed,
      createdAt: nowIso(this.clock),
    });
    project.goal = project.goal || trimmed;
    if (!this.localRuns.has(projectId)) project.status = "planning";
    project.needsInput = undefined;
    await this.save(project);
    this.deps.onActivity?.("Asking the Project Manager…", projectId);
    await this.deps.notify?.();
    await this.managerTurn(
      projectId,
      `The user said:\n${wrapUntrusted("user message", trimmed)}\nAnswer the user’s actual request. Questions need an answer, not a plan. If the answer needs facts your tools cannot reach, call investigate instead of asking the user for them. Propose a plan or delegate a deliverable only when the user is asking for that work. Discussing paused work does not resume it.`,
      false,
      true,
    );
    const latest = await this.requireProject(projectId);
    if (latest.status === "planning") {
      const recoveredManager =
        previousStatus === "paused" && previousPause?.cause === "manager_interrupted";
      const approvedPlan = (await this.deps.store.getPlan(projectId))?.approved;
      // An answer to a question the manager asked during an approved run lets
      // the run go on: the owner answered so it could, and a further Resume
      // click would leave the run paused after every answer.
      const answeredMidRun =
        previousStatus === "needs_input" && approvedPlan && !this.stopIntents.has(projectId);
      latest.status = recoveredManager
        ? approvedPlan
          ? "paused"
          : "draft"
        : previousStatus === "draft"
          ? "draft"
          : previousStatus === "needs_input"
            ? answeredMidRun
              ? "running"
              : "paused"
            : previousStatus;
      if (latest.status === "paused") {
        latest.pause =
          previousStatus === "paused" && previousPause && !recoveredManager
            ? previousPause
            : {
                cause: "awaiting_resume",
                detail:
                  "Your answer went to the Project Manager. Approved work stays paused until you resume.",
                at: nowIso(this.clock),
              };
      } else if (recoveredManager || latest.status === "running") {
        latest.pause = undefined;
      }
      await this.save(latest);
      if (latest.status === "running") {
        this.respondingToInput.delete(projectId);
        await this.tick(projectId);
        return;
      }
    }
    this.respondingToInput.delete(projectId);
  }

  async clearCurrentRun(projectId: string): Promise<void> {
    await this.archiveActiveRun(projectId, { resetConversation: false });
  }

  async startFresh(projectId: string): Promise<void> {
    await this.archiveActiveRun(projectId, { resetConversation: true });
  }

  private async archiveActiveRun(
    projectId: string,
    options: { resetConversation: boolean },
  ): Promise<void> {
    const project = await this.requireProject(projectId);
    const tasks = await this.deps.store.getTasks(projectId);
    if (
      this.turning.has(projectId) ||
      this.polling.has(projectId) ||
      this.localRuns.has(projectId) ||
      this.dispatching.has(projectId) ||
      ["running", "reviewing", "planning", "waiting_for_capacity"].includes(project.status) ||
      tasks.some((task) => task.attempts.some(isLiveAttempt))
    )
      throw new Error(
        "Stop the current run and resolve pending work before clearing it. Project files will be kept.",
      );
    if (this.deps.approvals?.list().some((request) => request.projectId === projectId))
      throw new Error("Resolve or cancel the pending action before clearing the current run.");
    this.turning.add(projectId);
    try {
      await this.deps.store.archiveCurrentRun(projectId, {
        keepConversation: !options.resetConversation,
      });
      if (options.resetConversation) await this.resetManagerConversation(projectId);
      this.stopIntents.delete(projectId);
      this.managerRetries.delete(projectId);
      this.infrastructureRetries.delete(projectId);
      this.managerHandoffs.delete(projectId);
      this.respondingToInput.delete(projectId);
      project.status = "draft";
      project.goal = undefined;
      project.needsInput = undefined;
      project.infrastructureIssue = undefined;
      const identity = newWorkflowIdentity();
      project.workflowId = identity.workflowId;
      if (options.resetConversation) {
        project.managerSessionId = identity.managerConversationId;
        project.freshConversation = true;
      }
      project.dispatchAuthorized = false;
      project.managerEscalation = undefined;
      project.escalations = [];
      project.declinedEscalations = undefined;
      project.budget = { managerTurnsUsed: 0, jobsSubmitted: 0 };
      project.integration.combinedVerification = undefined;
      await this.save(project);
      await this.deps.notify?.();
    } finally {
      this.turning.delete(projectId);
    }
  }

  async acceptReviewed(projectId: string): Promise<void> {
    const tasks = await this.deps.store.getTasks(projectId);
    const reviewable = tasks.filter((task) => task.status === "needs_review");
    if (!reviewable.length) throw new Error("There is no manager-reviewed result to accept yet.");
    for (const task of reviewable) await this.requestApply(projectId, task.id);
    await this.appendSystem(
      projectId,
      "You accepted the current manager-reviewed results. Project files were not reset.",
    );
  }

  async reopen(projectId: string): Promise<void> {
    const project = await this.requireProject(projectId);
    const tasks = await this.deps.store.getTasks(projectId);
    const accepted = tasks.filter((task) => task.status === "applied");
    if (project.status !== "completed" || !accepted.length) {
      throw new Error("Only completed accepted work can be sent for another review.");
    }
    for (const task of accepted) task.status = "needs_review";
    project.status = "reviewing";
    project.planRevision += 1;
    await this.deps.store.saveTasks(projectId, tasks);
    await this.save(project);
    await this.appendSystem(
      projectId,
      "You reopened accepted work for another review. This is a new workflow revision; previous results are retained.",
    );
  }

  async override(projectId: string, reason: string): Promise<void> {
    const project = await this.requireProject(projectId);
    project.needsInput = undefined;
    await this.save(project);
    await this.appendSystem(
      projectId,
      `You recorded an explicit override: ${reason.trim() || "operator decision"}. Dispatch will not infer additional authority from this.`,
    );
  }

  /** Whether the manager asked `question` after the owner's latest message. */
  private async askedSinceOwnerReplied(projectId: string, question: string): Promise<boolean> {
    const messages = await this.deps.store.getMessages(projectId);
    const same = (text: string) =>
      text.replace(/\s+/g, " ").trim() === question.replace(/\s+/g, " ").trim();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "user") return false;
      if (message.role === "manager" && same(message.text)) return true;
    }
    return false;
  }

  async reply(projectId: string, text: string): Promise<void> {
    const project = await this.requireProject(projectId);
    const trimmed = text.trim();
    const choice = project.needsInput?.choices?.find((item) => item.id === trimmed);
    if (choice && project.needsInput?.kind === "folder_access" && project.needsInput.folder) {
      await this.decideFolderAccess(projectId, choice.id);
      return;
    }
    // A manager question's option is answered with its words, not its id.
    if (choice?.id.startsWith(QUESTION_OPTION_PREFIX)) {
      await this.sendMessage(projectId, choice.label);
      return;
    }
    await this.sendMessage(projectId, text);
  }

  /**
   * Tell the manager what the owner decided about the folder it asked for.
   * The grant itself is written by the host before this runs: only the host
   * writes permissions (see `save`).
   */
  private async decideFolderAccess(projectId: string, choiceId: string): Promise<void> {
    const project = await this.requireProject(projectId);
    const folder = project.needsInput?.folder;
    if (!folder) return;
    const granted = (project.policy.roots ?? []).find((root) => root.path === folder.path);
    const allowed = choiceId !== FOLDER_CHOICE.deny && granted;
    await this.sendMessage(
      projectId,
      !allowed
        ? `Not allowed: ${folder.path}. Continue without it, or ask me another way.`
        : granted.mode === "write"
          ? `Allowed: this project may read and change ${folder.path}.`
          : `Allowed: this project may read ${folder.path} (read-only).`,
    );
  }

  /**
   * `automatic` is set when Dispatch approves within the tool-trust mode
   * instead of waiting for the user's Approve click; the conversation and the
   * plan say so, because no click happened to show it.
   */
  async approvePlan(
    projectId: string,
    automatic?: { mode: ToolTrustMode; taskTitle: string },
    /** Approved for Autopilot, which says itself how its run continues. */
    forAutopilot = false,
  ): Promise<void> {
    await this.applyPendingBoard(projectId);
    const project = await this.requireProject(projectId);
    const plan = await this.deps.store.getPlan(projectId);
    if (!plan) throw new Error("There is no plan to approve yet.");
    // Approving is the owner's explicit decision: a fresh allowance of turns.
    if (!plan.approved) project.budget = { managerTurnsUsed: 0, jobsSubmitted: 0 };
    plan.approved = true;
    plan.approvedAt = nowIso(this.clock);
    plan.autoApprovedUnder = automatic?.mode;
    await this.deps.store.savePlan(projectId, plan);
    project.dispatchAuthorized = true;
    project.status = "awaiting_approval";
    await this.save(project);
    if (automatic) {
      await this.appendSystem(projectId, autoApprovalNotice(automatic), "notice");
      return;
    }
    if (forAutopilot) return;
    await this.appendSystem(
      projectId,
      "Plan approved within the listed permissions and run limits. Nothing continues if you quit Poundlock Dispatch until you resume after reopening.",
    );
  }

  async approveAndStart(projectId: string): Promise<void> {
    const pending = await this.deps.store.getPendingBoard(projectId);
    const plan = await this.deps.store.getPlan(projectId);
    if (plan?.approved && !pending) return;
    await this.approvePlan(projectId);
    await this.start(projectId);
  }

  async start(projectId: string): Promise<void> {
    await this.restoreInterruptedRun(projectId);
    const project = await this.requireProject(projectId);
    const plan = await this.deps.store.getPlan(projectId);
    if (!plan?.approved) throw new Error("Approve the plan before starting.");
    if (project.status === "cancelled")
      throw new Error(
        "This run was cancelled. Ask the manager for a revised plan to start new work.",
      );
    if (project.budget.stopReason) {
      if (runStopBlocksResume(project)) throw new Error(project.budget.stopReason);
      // Resuming after the turn cap is the owner choosing to continue.
      if (isTurnBudgetStop(project.budget.stopReason)) project.budget.managerTurnsUsed = 0;
      project.budget.stopReason = undefined;
    }
    this.stopIntents.delete(projectId);
    project.needsInput = undefined;
    project.infrastructureIssue = undefined;
    project.status = "running";
    await this.save(project);
    await this.tick(projectId);
  }

  async pause(projectId: string, options?: { cause?: "wait" | "quit" }): Promise<void> {
    this.infrastructureRetries.delete(projectId);
    this.stopIntents.set(projectId, "paused");
    this.managerRetries.delete(projectId);
    const project = await this.requireProject(projectId);
    project.infrastructureIssue = undefined;
    this.markPaused(
      project,
      options?.cause === "quit" ? "dispatch_closed" : "user_wait",
      options?.cause === "quit"
        ? "Dispatch closed while this run was active."
        : "You chose Wait or Pause.",
    );
    await this.save(project);
    this.localRuns.get(projectId)?.controller.abort();
    this.managerSignals.get(projectId)?.abort();
    this.deps.approvals?.cancel(projectId);
    await this.deps.manager.abort?.(projectId);
    await this.appendSystem(
      projectId,
      options?.cause === "quit"
        ? "Poundlock Dispatch closed. Interactive work on this Mac stopped. Nothing will continue here until you resume."
        : "Wait registered. No new work will start until you resume or explicitly agree new work. You can discuss the proposal with the manager.",
    );
    this.deps.onActivity?.("", projectId);
  }

  async cancel(projectId: string): Promise<void> {
    this.stopIntents.set(projectId, "cancelled");
    this.managerRetries.delete(projectId);
    const project = await this.requireProject(projectId);
    project.infrastructureIssue = undefined;
    project.status = "cancelled";
    project.budget.stopReason =
      "Cancelled by you. No further worker jobs will be submitted for this run.";
    await this.save(project);
    this.localRuns.get(projectId)?.controller.abort();
    this.managerSignals.get(projectId)?.abort();
    this.deps.approvals?.cancel(projectId);
    await this.deps.manager.abort?.(projectId);
    await this.waitForLocal(projectId);
    const tasks = await this.deps.store.getTasks(projectId);
    for (const task of tasks) {
      for (const attempt of task.attempts) {
        if (isLiveAttempt(attempt)) {
          attempt.status = "cancelled";
          attempt.terminalAt = nowIso(this.clock);
        }
      }
      if (task.status === "queued" || task.status === "running" || task.status === "ready") {
        task.status = "cancelled";
      }
    }
    await this.deps.store.saveTasks(projectId, tasks);
    project.status = "cancelled";
    project.budget.stopReason =
      "Cancelled by you. No further worker jobs will be submitted for this run.";
    await this.save(project);
    await this.appendSystem(projectId, project.budget.stopReason);
  }

  /**
   * An explicit user decision on a stuck or exhausted task: give it a fresh
   * allowance on the same worker/model, keeping attempt history as evidence.
   * Also rescues a project stuck in the pre-Phase-1 dead end (task failed
   * with a recorded "Repair budget exhausted"/"Recovery budget exhausted"
   * stop, run paused): that stop is cleared the same way.
   */
  async retryTask(projectId: string, taskId: string): Promise<void> {
    const project = await this.requireProject(projectId);
    if (["cancelled", "completed"].includes(project.status))
      throw new Error(
        "This run is cancelled or completed. Start a new run to try this task again.",
      );
    const tasks = await this.deps.store.getTasks(projectId);
    const task = tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("Unknown task.");
    if (
      ["running", "queued", "repairing"].includes(task.status) ||
      task.attempts.some(isLiveAttempt)
    )
      throw new Error("This task is already running.");
    task.repairCount = 0;
    task.recoveryCount = 0;
    task.stuck = undefined;
    task.freshWorkerSession = true;
    task.status = "ready";
    await this.deps.store.saveTasks(projectId, tasks);
    this.stopIntents.delete(projectId);
    project.infrastructureIssue = undefined;
    project.needsInput = undefined;
    // Retrying is an explicit user decision, so it clears whichever stop was
    // recorded. Without this, a run stopped by a budget resumed into nothing.
    project.budget.stopReason = undefined;
    project.status = "running";
    await this.save(project);
    await this.appendSystem(
      projectId,
      `You retried “${task.title}”. It has a fresh fix-round and retry allowance; earlier attempts are kept as evidence.`,
    );
    await this.tick(projectId);
  }

  async recover(projectId: string): Promise<void> {
    const project = await this.requireProject(projectId);
    await this.restorePendingMutation(projectId).catch(() => undefined);
    if (project.status === "cancelled" || project.status === "completed") return;
    const from = project.status;
    if (from !== "paused")
      this.markPaused(project, "dispatch_closed", "Dispatch reopened after this run was active.");
    if (shouldPauseOnDispatchSession({ status: from })) {
      await this.appendSystem(
        projectId,
        "Poundlock Dispatch reopened. Work is paused until you resume. Files and models may have changed while the app was closed.",
      );
    }
    await this.save(project);
    this.deps.onActivity?.("", projectId);
    const tasks = await this.deps.store.getTasks(projectId);
    for (const task of tasks) {
      const attempt = task.attempts.at(-1);
      if (attempt?.execution === "interactive" && attempt.status === "running") {
        attempt.status = "failed";
        attempt.error =
          "Interrupted when Poundlock Dispatch closed. Files may have changed; review before resuming.";
        attempt.terminalAt = nowIso(this.clock);
        task.status = "needs_review";
      }
    }
    await this.deps.store.saveTasks(projectId, tasks);
  }

  async tick(projectId: string): Promise<void> {
    if (
      this.polling.has(projectId) ||
      this.turning.has(projectId) ||
      this.dispatching.has(projectId) ||
      this.localRuns.has(projectId)
    )
      return;
    const pendingRetry = this.infrastructureRetries.get(projectId);
    if (pendingRetry && this.clock().getTime() < pendingRetry.after) return;
    this.polling.add(projectId);
    try {
      const project = await this.requireProject(projectId);
      if (
        project.status === "paused" ||
        project.status === "cancelled" ||
        project.status === "completed"
      ) {
        return;
      }
      if (["draft", "planning", "needs_input", "awaiting_approval"].includes(project.status))
        return;
      const retry = this.managerRetries.get(projectId);
      if (retry) {
        if (this.clock().getTime() >= retry.after) await this.managerTurn(projectId, retry.prompt);
        return;
      }
      let tasks = await this.deps.store.getTasks(projectId);
      const live = tasks.some((task) => task.attempts.some(isLiveAttempt));
      if (live) {
        if (project.status !== "running" && project.status !== "waiting_for_capacity") {
          project.status = "running";
          await this.save(project);
        }
        return;
      }
      if (tasks.some((task) => task.status === "needs_review")) {
        await this.reviewTurn(projectId);
        tasks = await this.deps.store.getTasks(projectId);
        if (tasks.some((task) => task.status === "needs_review")) return;
      }
      await this.dispatchReady(projectId);
      const after = await this.deps.store.getTasks(projectId);
      const stillQueued = after.some(
        (task) => task.status === "queued" || task.status === "running",
      );
      if (!stillQueued && after.length > 0 && after.every((task) => task.status === "applied"))
        await this.combinedVerify(projectId);
      this.infrastructureRetries.delete(projectId);
    } catch (error) {
      if (!INFRASTRUCTURE_ERROR.test(String(error))) throw error;
      const failure = classifyInfrastructureError(String(error));
      const startedAt = pendingRetry?.startedAt ?? this.clock().getTime();
      const current = await this.requireProject(projectId);
      if (["paused", "cancelled", "completed", "needs_input"].includes(current.status)) return;
      if (!failure.retryable) {
        this.infrastructureRetries.delete(projectId);
        this.markPaused(current, "infrastructure", failure.issue.detail);
        current.infrastructureIssue = failure.issue;
        await this.save(current);
        await this.appendSystem(projectId, `${failure.issue.title}. ${failure.issue.detail}`);
        return;
      }
      if (this.clock().getTime() - startedAt >= 21 * 60_000) {
        this.infrastructureRetries.delete(projectId);
        this.markPaused(
          current,
          "infrastructure",
          "Poundlock did not recover within the retry window.",
        );
        current.infrastructureIssue = {
          ...failure.issue,
          title: "Poundlock still needs attention",
          detail:
            "Poundlock did not recover within the retry window. No replacement jobs were created. Check the service, then resume or discuss next steps.",
        };
      } else {
        this.infrastructureRetries.set(projectId, {
          startedAt,
          after: this.clock().getTime() + 15_000,
        });
        current.status = "waiting_for_capacity";
        current.infrastructureIssue = {
          ...failure.issue,
          retryAt: new Date(this.clock().getTime() + 15_000).toISOString(),
        };
      }
      await this.save(current);
    } finally {
      this.polling.delete(projectId);
    }
  }

  toolHost(projectId: string): ManagerToolHost {
    return {
      readNotes: async () => {
        const notes = projectFiles(this.deps.store.layout.root, projectId).notes;
        return readFile(`${notes}/manager.md`, "utf8").catch(() => "");
      },
      writeNotes: async (notes) => {
        if (notes.length > 32_000) throw new Error("Keep private notes under 32,000 characters.");
        const directory = projectFiles(this.deps.store.layout.root, projectId).notes;
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(`${directory}/manager.md`, notes, { mode: 0o600 });
        return "Private notes saved in Poundlock Dispatch data.";
      },
      writeBrief: async (brief) => {
        const saved = normalizeProjectBrief(brief);
        await this.deps.store.saveBrief(projectId, saved);
        await this.deps.notify?.();
        return saved
          ? `Project brief saved (${saved.length.toLocaleString("en-US")} of ${PROJECT_BRIEF_MAX_CHARS.toLocaleString("en-US")} characters). It is pinned in every turn and the owner can read it.`
          : "Project brief cleared.";
      },
      listFiles: async () => {
        const project = await this.requireProject(projectId);
        const excluded =
          project.source.kind === "local_folder" ? project.source.excludedPatterns : [];
        const listed = await listLiveProjectFiles(
          managerReadableRoot(this.deps.store.layout.root, project),
          excluded,
        );
        // Granted folders are listed under their own path, so the manager can
        // tell where a file lives and ask for it by the same name.
        for (const root of readRootsFor(project)) {
          for (const entry of await listLiveProjectFiles(root, []).catch(() => []))
            listed.push({ ...entry, path: `${root}/${entry.path}` });
        }
        return listed;
      },
      readFile: async (path) => {
        const project = await this.requireProject(projectId);
        const root = managerReadableRoot(this.deps.store.layout.root, project);
        return wrapUntrusted(
          `file ${path}`,
          await safeReadFile(
            root,
            path,
            project.policy.readGrants,
            project.source.kind === "local_folder" ? project.source.excludedPatterns : [],
            readRootsFor(project),
          ),
        );
      },
      listProfiles: async () => {
        const interactive = await (await this.deps.clientFor()).listInteractiveModels();
        const capabilitySentences = (
          profile: { capabilities?: import("@shared/types").CapabilityMeasurement[] } | undefined,
        ): string[] | undefined =>
          profile?.capabilities?.length
            ? [...profile.capabilities.map(capabilityEvidenceSentence), CAPABILITY_EVIDENCE_CAVEAT]
            : undefined;
        // The manager is told which profiles share its machine's single model
        // slot, because on such a machine every handoff between two different
        // profiles unloads one model and loads the other (minutes, not
        // seconds), and nothing else in this listing would say so.
        const managerId = (await this.deps.store.getConnection()).roles?.manager?.profileId;
        const manager = interactive.find((model) =>
          [model.profileId, model.id].includes(managerId ?? ""),
        );
        const slotNote = (model: {
          id: string;
          profileId?: string;
          occupancy?: import("@shared/types").ModelOccupancy;
        }) =>
          manager &&
          (model.profileId ?? model.id) !== (manager.profileId ?? manager.id) &&
          sameRuntimeSlot(model, manager)
            ? "; shares your machine's single model slot, so switching to it unloads your model and loads this one"
            : "";
        return interactive.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          contextTokens: model.context_tokens ?? 0,
          readiness: `${model.busy ? "busy (advisory)" : "not reserved; may need waking/loading"}${slotNote(model)}`,
          source: "interactive",
          destination: model.dataDestination ?? "unknown",
          maxOutputTokens: model.max_output_tokens,
          capabilities: capabilitySentences(model),
        }));
      },
      proposePlan: async (input, signal) =>
        `${await this.proposePlan(projectId, input)}${taskSizeNotes(input.tasks)}${await this.ledgerCoverageNote(projectId)}${await this.reviewPlan(projectId, input, signal)}`,
      investigate: async (input, signal) => this.investigate(projectId, input, signal),
      requestEscalation: async (input) => this.requestEscalation(projectId, input),
      delegateTask: async (task) => {
        await this.noteFrozenBrief(
          projectId,
          `delegate:${task.title}`,
          task,
          `${task.objective}\n${task.workerPrompt}\n${task.acceptanceCriteria}`,
        );
        const running =
          this.localRuns.has(projectId) ||
          (await this.deps.store.getTasks(projectId)).some((item) =>
            ["running", "queued"].includes(item.status),
          );
        const result = await this.proposePlan(
          projectId,
          {
            summary: task.objective,
            acceptanceCriteria: [task.acceptanceCriteria],
            tasks: [{ ...task, route: "interactive" }],
          },
          true,
        );
        if (running) {
          await this.appendSystem(
            projectId,
            `Added “${task.title}” to the board while work runs; it starts when its turn comes.`,
          );
          return `Added “${task.title}” to the board without changing the running work. It starts when the tasks before it are done. Stop this turn.${taskSizeNotes([task])}`;
        }
        const project = await this.requireProject(projectId);
        const mode = effectiveToolTrust(
          project.policy.toolTrust,
          await this.deps.store.getPermissions(),
        );
        const sizeNote = taskSizeNotes([task]);
        if (mode === "ask")
          return `${result} The action awaits approval in the status panel.${sizeNote}`;
        await this.approvePlan(projectId, { mode, taskTitle: task.title });
        const current = await this.requireProject(projectId);
        current.status = "running";
        this.stopIntents.delete(projectId);
        await this.save(current);
        return `Agreed action delegated under existing tool permissions. Stop this turn; the worker will implement and return evidence for review.${sizeNote}`;
      },
      askUser: async (question, options) => {
        const project = await this.requireProject(projectId);
        project.status = "needs_input";
        const choices = (options ?? [])
          .filter((option) => option.label.trim())
          .slice(0, MAX_QUESTION_OPTIONS)
          .map((option, index) => ({
            id: `${QUESTION_OPTION_PREFIX}${index + 1}`,
            label: option.label.trim(),
            ...(option.description?.trim() ? { description: option.description.trim() } : {}),
          }));
        project.needsInput = {
          question,
          askedAt: nowIso(this.clock),
          kind: "question",
          ...(choices.length ? { choices } : {}),
        };
        await this.save(project);
        // After an Override cleared a question, the manager asked it again three
        // times in 15 seconds (12 Oct). The conversation shows it once.
        if (await this.askedSinceOwnerReplied(projectId, question))
          return "You already asked this and the owner has not replied since. End this turn and wait for the user.";
        await this.appendMessage(projectId, {
          id: newId("msg"),
          role: "manager",
          text: question,
          createdAt: nowIso(this.clock),
        });
        return "Question recorded in the main conversation. End this turn and wait for the user.";
      },
      requestFolderAccess: async ({ path, mode, reason }) => {
        const project = await this.requireProject(projectId);
        // Refuse a path the owner could never grant before asking them about it.
        const canonical = await normalizeAccessRoot(path, {
          projectRoot: projectWorkingRoot(this.deps.store.layout.root, project),
          dataRoot: this.deps.store.layout.root,
        });
        const write = mode === "write";
        const question =
          `May this project ${write ? "read and change" : "read"} ${canonical}? ${reason.trim()}`.trim();
        project.status = "needs_input";
        project.needsInput = {
          question,
          askedAt: nowIso(this.clock),
          kind: "folder_access",
          folder: { path: canonical, mode, reason: reason.trim() },
          choices: [
            { id: FOLDER_CHOICE.read, label: "Allow read-only" },
            ...(write ? [{ id: FOLDER_CHOICE.write, label: "Allow read and write" }] : []),
            { id: FOLDER_CHOICE.deny, label: "Don't allow" },
          ],
        };
        await this.save(project);
        await this.appendMessage(projectId, {
          id: newId("msg"),
          role: "manager",
          text: question,
          createdAt: nowIso(this.clock),
        });
        return "Folder request shown to the owner. End this turn and wait for their decision.";
      },
      requestRepair: async (taskId, findings, freshSession) =>
        this.requestRepair(projectId, taskId, findings, freshSession),
      requestApplyResult: async (taskId) => {
        const result = await this.requestApply(projectId, taskId);
        await this.settleLedger(projectId);
        return result;
      },
      noteIssue: async ({ text, requirementId }) => {
        const plan = await this.deps.store.getPlan(projectId);
        if (!plan)
          throw new Error("Issues are noted against a plan; before one exists, ask the owner.");
        if (!text.trim()) throw new Error("Say what the issue is.");
        plan.issues = [
          ...(plan.issues ?? []),
          {
            text: text.trim(),
            ...(requirementId?.trim() ? { requirementId: requirementId.trim() } : {}),
            notedAt: nowIso(this.clock),
          },
        ];
        await this.deps.store.savePlan(projectId, plan);
        return "Noted. Dispatch raises open issues with the owner when this round of tasks ends; carry on with the work.";
      },
      waiveRequirement: async ({ id, ownerWords }) => {
        const plan = await this.deps.store.getPlan(projectId);
        const item = plan?.requirements?.find(
          (requirement) => requirement.id.trim().toUpperCase() === id.trim().toUpperCase(),
        );
        if (!plan || !item) throw new Error(`The ledger has no requirement ${id}.`);
        const said = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
        const quoted = said(ownerWords);
        const owner = (await this.deps.store.getMessages(projectId)).filter(
          (message) => message.role === "user",
        );
        if (quoted.length < 3 || !owner.some((message) => said(message.text).includes(quoted)))
          throw new Error(
            "Only the owner can waive a requirement: quote their own words from this conversation in ownerWords. To ask them, call ask_user.",
          );
        item.status = "waived";
        item.evidence = `Owner: “${ownerWords.trim()}”`;
        await this.deps.store.savePlan(projectId, plan);
        await this.appendSystem(
          projectId,
          `Waived ${item.id} (${item.text}) on your word: “${ownerWords.trim()}”.`,
        );
        return `Waived ${item.id}.`;
      },
      markComplete: async (summary) => {
        this.assertManagerActionAllowed(projectId);
        const project = await this.requireProject(projectId);
        const tasks = await this.deps.store.getTasks(projectId);
        if (!tasks.length || tasks.some((task) => task.status !== "applied"))
          throw new Error("Accept every task before marking complete.");
        const settled = await this.settleLedger(projectId);
        const disputed = disputedRequirements(settled);
        if (disputed.length)
          throw new Error(
            `The verifier found accepted work that does not show ${disputed.map((item) => `${item.id} (${item.verdict?.result})`).join(", ")}. Propose tasks that make each one work, or ask the owner whether to waive it.`,
          );
        const open = openRequirements(settled);
        if (open.length)
          throw new Error(
            `Requirements still open: ${open.map((item) => `${item.id} (${item.text})`).join(", ")}. Propose the next round of tasks for them. If the owner might drop one, ask them; waive_requirement needs their words.`,
          );
        const expected = project.policy.verification.commands;
        for (const task of tasks) {
          const required = expected;
          const verification = task.attempts.at(-1)?.result?.verification;
          if (required.length && !checksPassed(verification, required))
            throw new Error("Required task checks have not passed.");
        }
        if (
          tasks.length > 1 &&
          expected.length &&
          !checksPassed(project.integration.combinedVerification, expected)
        )
          throw new Error("Combined checks have not passed.");
        project.status = "completed";
        await this.save(project);
        const ledger = (await this.deps.store.getPlan(projectId))?.requirements;
        const waived = (ledger ?? []).filter((item) => item.status === "waived");
        await this.appendSystem(
          projectId,
          ledger?.length
            ? `${summary}\n\nRequirement ledger: ${ledgerLine(ledger)}.${waived.length ? ` Waived: ${waived.map((item) => `${item.id} (${item.text}), ${item.evidence}`).join("; ")}.` : ""}`
            : summary,
        );
        return "Marked complete.";
      },
    };
  }

  private assertManagerActionAllowed(projectId: string): void {
    if (this.stopIntents.has(projectId) || this.managerSignals.get(projectId)?.signal.aborted)
      throw new Error(
        "Work is paused or cancelled. Wait for explicit user follow-up before requesting another action.",
      );
  }

  private async proposePlan(
    projectId: string,
    input: ProposePlanInput,
    action = false,
  ): Promise<string> {
    this.assertManagerActionAllowed(projectId);
    const project = await this.requireProject(projectId);
    const previousPlan = await this.deps.store.getPlan(projectId);
    const ledger = mergeRequirements(previousPlan?.requirements, input.requirements);
    if (!action && !ledger.length && input.tasks.length >= LEDGER_REQUIRED_TASKS)
      throw new Error(
        "List the owner's requirements first, in requirements: an id (R1, R2, …), what the owner needs in their words, and one or two scenarios a user could carry out to show it works. Then have each task cite the IDs it serves in requirementIds.",
      );
    if (!action && ledger.length) {
      const known = new Set(ledger.map((item) => item.id.trim().toUpperCase()));
      const uncited = input.tasks.filter(
        (task) =>
          !task.requirementIds?.length &&
          (!task.taskKind || task.taskKind === "closed_implementation") &&
          !isDocumentationOnlyChange(task.filesToTouch ?? []),
      );
      const unknown = [
        ...new Set(
          input.tasks
            .flatMap((task) => task.requirementIds ?? [])
            .filter((id) => !known.has(id.trim().toUpperCase())),
        ),
      ];
      // A local manager left twelve of thirteen tasks uncited after a note
      // asked it to cite them, so its ledger could never be covered (13 Oct).
      if (uncited.length || unknown.length)
        throw new Error(
          [
            uncited.length &&
              `Each task must cite the requirement IDs it delivers in requirementIds; ${uncited.map((task) => `“${task.title}”`).join(", ")} cite none.`,
            unknown.length && `The ledger has no ${unknown.join(", ")}.`,
            `The ledger's IDs: ${[...known].join(", ")}. A documentation-only task may cite none.`,
          ]
            .filter(Boolean)
            .join(" "),
        );
    }
    // The spec's shape (ADR 016) outlives a revision that does not restate it.
    const milestones = input.milestones?.length
      ? input.milestones.map((item) => ({
          ...item,
          id: item.id.trim().toUpperCase(),
          requirementIds: item.requirementIds.map((id) => id.trim().toUpperCase()),
        }))
      : previousPlan?.milestones;
    if (!action && milestones?.length) {
      const problems = milestoneProblems(milestones, ledger, input.tasks);
      if (problems.length) throw new Error(problems.join(" "));
    }
    const architecture = input.architecture ?? previousPlan?.architecture;
    const scopeOut = input.scopeOut ?? previousPlan?.scopeOut;
    // A task cannot change a frozen test unless it says so; catch it while
    // planning rather than when its worker is refused (13 Oct).
    const frozenPaths = new Set(frozenTestsIn(previousPlan?.frozenTests).map((test) => test.path));
    const touchesFrozen = input.tasks
      .filter((task) => !task.changesFrozenTests)
      .flatMap((task) =>
        (task.filesToTouch ?? [])
          .filter((path) => frozenPaths.has(path.replace(/^\.\//, "")))
          .map((path) => `“${task.title}” lists ${path}`),
      );
    if (touchesFrozen.length)
      throw new Error(
        `${touchesFrozen.join("; ")}, a frozen test its worker cannot change. Put new tests in a new file, or mark the task changesFrozenTests if the test itself must change (the owner sees it on the plan card).`,
      );
    const compiled = compilePlanProposal(
      { ...input, requirements: ledger, milestones, architecture, scopeOut },
      project,
      await this.deps.store.getPermissions(),
    );
    const current = await this.deps.store.getTasks(projectId);
    const busy =
      this.localRuns.has(projectId) ||
      current.some((task) => ["running", "queued"].includes(task.status));
    // An agreed new task joins a running board; only replacing or changing
    // published tasks waits, so the manager can add tasks the owner asks for
    // while close-out runs.
    const joinsRunningBoard =
      busy &&
      action &&
      effectiveToolTrust(project.policy.toolTrust, await this.deps.store.getPermissions()) !==
        "ask" &&
      this.materializePlanTasks(compiled.tasks, action).every(
        (task) => !current.some((old) => taskIdentity(old) === taskIdentity(task)),
      );
    if (busy && !joinsRunningBoard)
      throw new Error(
        action
          ? "Pause active work before changing a published task; a new task can join while work runs only outside Ask mode."
          : "Pause active work before replacing its plan.",
      );
    if (!compiled.tasks.length || compiled.tasks.length > 20)
      throw new Error("Plan between one and twenty tasks.");
    const oldTasks = await this.deps.store.getTasks(projectId);
    if (!joinsRunningBoard && oldTasks.some((task) => task.attempts.some(isLiveAttempt)))
      throw new Error(
        "Wait for the running worker to end before replacing this run. You can still discuss the project.",
      );
    const tasks = this.materializePlanTasks(compiled.tasks, action);
    // Frozen tests, the ledger and noted issues outlive a plan revision.
    const frozenTests = previousPlan?.frozenTests;
    const plan: PlanRecord = {
      ...compiled.plan,
      ...(frozenTests?.length ? { frozenTests } : {}),
      ...(ledger.length ? { requirements: ledger } : {}),
      ...(previousPlan?.issues?.length ? { issues: previousPlan.issues } : {}),
      revision: project.planRevision + 1,
      approved: false,
      createdAt: nowIso(this.clock),
    };
    const write = classifyBoardWrite({
      source: action ? "user" : "manager",
      kind: action ? "upsert" : "replace",
      published: tasksSectionState(
        oldTasks,
        project.status,
        Boolean(project.budget.stopReason?.startsWith("Cancelled by you")),
      ),
    });
    // Every task the board takes as written needs real content; a published
    // task an update restates vaguely keeps its own (retainTaskIdentity).
    const published = new Set(
      write === "amend" || write === "merge" ? oldTasks.map(taskIdentity) : [],
    );
    const vague = tasks.find(
      (task) =>
        !published.has(taskIdentity(task)) &&
        (isPlaceholderText(task.objective) || isPlaceholderText(task.acceptanceCriteria)),
    );
    if (vague)
      throw new Error(
        `“${vague.title}” has no real objective or acceptance criteria. State it in full; a published task you leave out of an update keeps its own.`,
      );
    if (write === "amend") {
      // During a run an update adds or changes tasks and keeps the rest; a
      // manager removes a task only by naming it. Local managers asked to
      // restate a fifteen-task board proposed just the two tasks they changed.
      const board = amendedBoard(oldTasks, tasks, input.removeTasks ?? []);
      const changes = boardChanges(
        oldTasks,
        mergeSectionItems(oldTasks, board, taskIdentity, retainTaskIdentity),
      );
      await this.deps.store.savePendingBoard(projectId, {
        source: "manager",
        reason: "Manager proposed a change to the published inspector board.",
        createdAt: nowIso(this.clock),
        plan,
        tasks: board,
        changes,
      });
      const restatedVaguely = tasks.filter(
        (task) =>
          published.has(taskIdentity(task)) &&
          (isPlaceholderText(task.objective) || isPlaceholderText(task.acceptanceCriteria)),
      ).length;
      if (project.status !== "paused") project.status = "awaiting_approval";
      await this.save(project);
      // An update replaces the board: say plainly which published tasks it
      // would drop, so a two-task fix-up never silently deletes the plan.
      const kept = new Set(board.map(taskIdentity));
      const dropped = oldTasks.filter((task) => !kept.has(taskIdentity(task)));
      const droppedNote = dropped.length
        ? ` Warning: approving it removes ${dropped.length} published task(s): ${dropped
            .slice(0, 12)
            .map((task) => `“${task.title}”`)
            .join(
              ", ",
            )}${dropped.length > 12 ? ", …" : ""}. To keep them, propose the complete list again with their titles unchanged.`
        : "";
      const keptNote = restatedVaguely
        ? ` ${restatedVaguely} published task(s) restated without real content keep their own objective, criteria and brief.`
        : "";
      return `Proposed board update revision ${plan.revision}: ${tasks.length} task(s) added or changed, ${board.length} on the board after approval. The published task list stays until you approve this change.${droppedNote}${keptNote}`;
    }
    if (write === "merge") {
      // Read again just before writing: while work runs, the running task's
      // own record changes, and this proposal's earlier copy must not undo it.
      const latest = joinsRunningBoard ? await this.deps.store.getTasks(projectId) : oldTasks;
      const merged = upsertSectionItems(latest, tasks, taskIdentity, retainTaskIdentity);
      this.assertTaskGraph(merged);
      await this.deps.store.saveTasks(projectId, merged);
      await this.deps.store.clearPendingBoard(projectId);
      if (!joinsRunningBoard) await this.save(project);
      return `Added or updated ${tasks.length} task(s) on the published board without replacing the rest.`;
    }
    await this.archivePlanSnapshot(projectId, oldTasks);
    if (
      project.budget.stopReason?.startsWith("Cancelled by you") ||
      (oldTasks.length && oldTasks.every((task) => task.status === "applied"))
    ) {
      // A new round gets a fresh allowance: the limit is sized from the new
      // board, so the turns a sixteen-task round used must not stop a two-task
      // one on its first turn.
      project.budget = { jobsSubmitted: 0, managerTurnsUsed: 0 };
    }
    project.planRevision = plan.revision;
    project.managerEscalation = undefined;
    project.needsInput = undefined;
    project.integration.combinedVerification = undefined;
    project.status = "awaiting_approval";
    await this.deps.store.savePlan(projectId, plan);
    await this.deps.store.saveTasks(projectId, tasks);
    await this.deps.store.clearPendingBoard(projectId);
    await this.save(project);
    const continued = await this.continueRound(
      projectId,
      previousPlan,
      oldTasks,
      plan,
      tasks,
      action,
    );
    if (continued) return continued;
    return `Plan revision ${plan.revision} recorded with ${tasks.length} task(s). Wait for the user to approve and start.`;
  }

  private materializePlanTasks(
    compiled: ReturnType<typeof compilePlanProposal>["tasks"],
    action: boolean,
  ): TaskRecord[] {
    const tasks: TaskRecord[] = compiled.map(({ requestedDependencies: _, ...task }) => ({
      ...task,
      managerReviewOnly: action,
      id: newId("task"),
      dependsOn: [],
      route: resolveTaskRoute(task),
      status: "ready",
      repairCount: 0,
      attempts: [],
    }));
    const byTitle = new Map(tasks.map((task) => [task.title, task.id]));
    compiled.forEach((raw, index) => {
      const requestedDependencies =
        raw.requestedDependencies ?? (index > 0 ? [tasks[index - 1].id] : []);
      tasks[index].dependsOn = requestedDependencies
        .map((title) => byTitle.get(title) || title)
        .filter(Boolean);
    });
    this.assertTaskGraph(tasks);
    for (const task of tasks) {
      task.status = task.dependsOn.length ? "blocked" : "ready";
    }
    return tasks;
  }

  private assertTaskGraph(tasks: TaskRecord[]): void {
    if (new Set(tasks.map((task) => task.title)).size !== tasks.length)
      throw new Error("Task titles must be unique.");
    const visit = (id: string, path = new Set<string>()): void => {
      if (path.has(id)) throw new Error("Task dependencies contain a cycle.");
      const task = tasks.find((item) => item.id === id);
      if (!task) {
        const waiting = tasks.find((item) => item.dependsOn.includes(id));
        throw new Error(
          `A task dependency does not exist${waiting ? `: “${waiting.title}” depends on a task that is not on the board` : ""}.`,
        );
      }
      for (const dep of task.dependsOn) visit(dep, new Set([...path, id]));
    };
    for (const task of tasks) visit(task.id);
  }

  private async archivePlanSnapshot(projectId: string, oldTasks: TaskRecord[]): Promise<void> {
    const project = await this.requireProject(projectId);
    const oldPlan = await this.deps.store.getPlan(projectId);
    if (!oldPlan) return;
    const directory = `${projectFiles(this.deps.store.layout.root, projectId).dir}/history`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
      `${directory}/plan-${oldPlan.revision}.json`,
      JSON.stringify(
        {
          plan: oldPlan,
          tasks: oldTasks,
          budget: project.budget,
          integration: project.integration,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }

  private async applyPendingBoard(projectId: string): Promise<boolean> {
    const pending = await this.deps.store.getPendingBoard(projectId);
    if (!pending) return false;
    const project = await this.requireProject(projectId);
    const oldTasks = await this.deps.store.getTasks(projectId);
    await this.archivePlanSnapshot(projectId, oldTasks);
    const merged = mergeSectionItems(oldTasks, pending.tasks, taskIdentity, retainTaskIdentity);
    const pendingById = new Map(pending.tasks.map((task) => [task.id, task]));
    const idByIdentity = new Map(merged.map((task) => [taskIdentity(task), task.id]));
    for (const task of merged) {
      const proposed = pending.tasks.find((item) => taskIdentity(item) === taskIdentity(task));
      task.dependsOn = (proposed?.dependsOn ?? [])
        .map((depId) => {
          const dep = pendingById.get(depId);
          return dep ? (idByIdentity.get(taskIdentity(dep)) ?? depId) : depId;
        })
        .filter(Boolean);
      if (task.attempts.length) continue;
      task.status = task.dependsOn.length ? "blocked" : "ready";
    }
    this.assertTaskGraph(merged);
    // Waivers and issues recorded since the update was proposed are kept.
    const current = await this.deps.store.getPlan(projectId);
    if (pending.plan.requirements?.length || current?.requirements?.length) {
      const waived = new Map(
        (current?.requirements ?? [])
          .filter((item) => item.status === "waived")
          .map((item) => [item.id.trim().toUpperCase(), item]),
      );
      pending.plan.requirements = settleRequirements(
        mergeRequirements(current?.requirements, pending.plan.requirements).map(
          (item) => waived.get(item.id.trim().toUpperCase()) ?? item,
        ),
        merged,
      );
    }
    if (current?.issues?.length) pending.plan.issues = current.issues;
    pending.plan.approved = false;
    project.planRevision = pending.plan.revision;
    project.managerEscalation = undefined;
    // A grant names the plan revision it was given for, so bumping the
    // revision invalidates every task grant too. Clearing the project's and
    // keeping the tasks' left those tasks in a dead end: too invalid to run,
    // and nothing ever removed the grant that made them invalid, so retrying
    // and re-escalating both landed back on the same refusal.
    for (const task of merged) task.escalation = undefined;
    await this.deps.store.savePlan(projectId, pending.plan);
    await this.deps.store.saveTasks(projectId, merged);
    await this.deps.store.clearPendingBoard(projectId);
    await this.save(project);
    return true;
  }

  private async restoreInterruptedRun(projectId: string): Promise<void> {
    const project = await this.requireProject(projectId);
    if (project.status === "cancelled") return;
    const tasks = await this.deps.store.getTasks(projectId);
    let restored = false;
    for (const task of tasks) {
      const last = task.attempts.at(-1);
      if (!last || !isInterruptAttempt(last)) continue;
      if (!["failed", "needs_review"].includes(task.status) && last.status !== "paused") continue;
      const changed = Array.isArray(last.result?.provenance?.changedFiles)
        ? last.result.provenance.changedFiles
        : [];
      const patches = last.result?.patches ?? [];
      if (task.repairCount > 0 && changed.length === 0 && patches.length === 0)
        task.repairCount -= 1;
      task.status = "needs_review";
      task.freshWorkerSession = true;
      restored = true;
    }
    if (
      restored &&
      project.budget.stopReason &&
      /Repair budget exhausted|Recovery budget exhausted/i.test(project.budget.stopReason)
    ) {
      const stillFailed = tasks.some((task) => {
        const lastAttempt = task.attempts.at(-1);
        return task.status === "failed" && (!lastAttempt || !isInterruptAttempt(lastAttempt));
      });
      if (!stillFailed) {
        project.budget.stopReason = undefined;
        if (project.status === "failed" || project.status === "needs_input")
          this.markPaused(project, "awaiting_resume", "Interrupted work was restored for review.");
      }
    }
    if (restored) {
      await this.deps.store.saveTasks(projectId, tasks);
      await this.save(project);
    }
  }

  private async requestEscalation(
    projectId: string,
    input: {
      target: "manager" | "worker";
      taskId?: string;
      findings: string;
      revisedPrompt?: string;
    },
  ): Promise<string> {
    this.assertManagerActionAllowed(projectId);
    const project = await this.requireProject(projectId);
    if (!["planning", "reviewing", "running"].includes(project.status))
      throw new Error("Resume work before requesting escalation.");
    if (input.findings.trim().length < 20)
      throw new Error(
        "Explain the evidence, the unmet requirement, and why a corrected prompt or local repair is insufficient.",
      );
    const connection = await this.deps.store.getConnection();
    const settings = escalationSettings(connection.escalation, connection.roles);
    // Escalating to a rung on the operator's own infrastructure is bounded
    // only by the ladder itself (nextEscalation below refuses to go past the
    // last configured rung for this task). Only a move to an external
    // provider spends maxTransitionsPerRun, and it is counted for the whole
    // run — project.escalations is cleared only when a run is archived, not
    // when a revised plan is approved — so a revised plan never refreshes it.
    const externalUsed = externalEscalationsUsed(project);
    const tasks = await this.deps.store.getTasks(projectId);
    const task =
      input.target === "worker" ? tasks.find((item) => item.id === input.taskId) : undefined;
    if (input.target === "worker") {
      if (!task || !["needs_review", "failed"].includes(task.status))
        throw new Error("Only finished, reconciled worker results can be escalated.");
      const attempt = task.attempts.at(-1);
      if (!attempt || !["completed", "failed"].includes(attempt.status))
        throw new Error("Reconcile the previous attempt before escalation.");
      if (
        OPERATIONAL_FAILURE.test(
          `${attempt.error ?? ""} ${attempt.result?.verification?.failureCode ?? ""}`,
        )
      )
        throw new Error(
          "The previous attempt has an operational failure. Recover or ask the user; do not spend on a capability escalation.",
        );
      // An exhausted fix-round or retry-after-interruption allowance does not
      // block escalation: moving a stuck task to a stronger model is one of
      // the alternatives the stuck-task brief offers, bounded instead by the
      // escalation transition limit checked above.
    }
    const prior =
      task?.escalation ?? (input.target === "manager" ? project.managerEscalation : undefined);
    if (prior && !validEscalationGrant(prior, connection, project))
      throw new Error(
        "Escalation policy changed. Review the settings and prior attempt before further escalation.",
      );
    const binding = nextEscalation(settings, task ? rungOfTask(settings, task) : prior?.profile);
    if (project.declinedEscalations?.includes(binding.profileId))
      throw new Error(declinedEscalationNote(binding.profileName));
    const models = await (await this.deps.clientFor()).listInteractiveModels();
    const model = models.find((item) =>
      [item.id, item.profileId, ...(item.aliases ?? [])].includes(binding.profileId),
    );
    if (!model || interactiveUnavailableReason(model))
      throw new Error(
        "The next escalation profile is unavailable or lacks published Pi-compatible limits. Fix the profile or its order; it was not skipped.",
      );
    const profileId = model.profileId ?? model.id;
    if (
      task &&
      project.policy.allowedWorkerProfileIds.length &&
      !project.policy.allowedWorkerProfileIds.includes(profileId)
    )
      throw new Error("The next escalation profile is not in this project's allowed worker list.");
    const destination = effectiveDestination(
      model.dataDestination,
      connection.profiles?.[profileId]?.approvedDestination,
    );
    const routingRevision = model.routingRevision;
    const isLocalRung = destination === "operator_network";
    if (!isLocalRung && externalUsed >= settings.maxTransitionsPerRun)
      throw new Error(
        "The escalation transition limit for external providers is used up for this run. Ask the user how to proceed.",
      );
    const key = escalationPolicyKey(connection);
    const reason = input.findings.trim();
    const action = `Escalate ${task ? `worker “${task.title}”` : "manager reasoning"} to ${binding.profileName} (${destination}). Selected project context and prior results may be sent.${
      isLocalRung
        ? ""
        : ` Transition ${externalUsed + 1} of ${settings.maxTransitionsPerRun} to an external provider this run.`
    }`;
    if (settings.mode !== "standing" || destination === "unknown") {
      const allowed = await this.deps.approvals?.request(
        {
          projectId,
          projectName: project.name,
          planRevision: project.planRevision,
          taskId: task?.id,
          kind: "escalation",
          action,
          reason: `${reason} Cost and gateway balance are unknown to Dispatch. Existing scope and run limits remain in force.`,
        },
        this.managerSignals.get(projectId)?.signal,
      );
      if (!allowed) {
        const current = await this.requireProject(projectId);
        current.declinedEscalations = [
          ...new Set([...(current.declinedEscalations ?? []), binding.profileId]),
        ];
        await this.save(current);
        // A declined escalation is an answer, not a stop: pausing the run would
        // leave it idle after a "no". A pause the owner chose while the card
        // was open still stands.
        if (this.stopIntents.has(projectId))
          return "Escalation declined, and the owner paused work.";
        return `Escalation declined: the owner keeps this work off ${binding.profileName}. Do not ask for it again this run. Carry on with another way forward: accept the result if its checks pass, repair it on the current rung if fix rounds remain, revise the plan, or ask the user.`;
      }
    }
    const current = await this.requireProject(projectId);
    const freshConnection = await this.deps.store.getConnection();
    if (
      this.stopIntents.has(projectId) ||
      current.planRevision !== project.planRevision ||
      escalationPolicyKey(freshConnection) !== key ||
      !["planning", "reviewing", "running"].includes(current.status)
    )
      throw new Error(
        "Work or escalation policy changed while awaiting permission. Nothing was escalated.",
      );
    const grant = {
      profile: binding,
      policyKey: key,
      planRevision: project.planRevision,
      destination,
      routingRevision,
      reason,
    };
    if (task) {
      await this.requestRepair(
        projectId,
        task.id,
        input.revisedPrompt ? `${reason}\n\nRevised instructions: ${input.revisedPrompt}` : reason,
        false,
        { viaEscalation: true },
      );
      const updated = await this.deps.store.getTasks(projectId);
      const repaired = updated.find((item) => item.id === task.id)!;
      repaired.escalation = grant;
      await this.deps.store.saveTasks(projectId, updated);
    }
    const latest = await this.requireProject(projectId);
    latest.escalations = [
      ...(latest.escalations ?? []),
      { ...grant, target: input.target, taskId: task?.id, createdAt: nowIso(this.clock) },
    ];
    if (input.target === "manager") {
      latest.managerEscalation = grant;
      this.managerHandoffs.set(
        projectId,
        `Continue the manager's current work using the same manager-only tools. Reason for escalation: ${reason}. ${input.revisedPrompt ?? "Review recent conversation and task results before deciding the next action."}`,
      );
    }
    await this.save(latest);
    await this.appendSystem(
      projectId,
      `${action}\nReason: ${reason}\nAuthorization: ${settings.mode === "standing" && destination !== "unknown" ? "standing policy" : "user decision"}.`,
    );
    return input.target === "manager"
      ? "Manager escalation recorded. Stop this turn; the next manager turn uses the authorized profile."
      : `Worker repair queued on ${binding.profileName}. No worker has been replayed mid-attempt.`;
  }

  private async requestRepair(
    projectId: string,
    taskId: string,
    findings: string,
    freshSession = false,
    options?: { viaEscalation?: boolean },
  ): Promise<string> {
    this.assertManagerActionAllowed(projectId);
    const project = await this.requireProject(projectId);
    if (
      !["running", "reviewing"].includes(project.status) &&
      !(
        project.status === "planning" &&
        this.respondingToInput.has(projectId) &&
        (await this.deps.store.getPlan(projectId))?.approved
      )
    )
      throw new Error("Resume the approved run before queuing a repair.");
    const tasks = await this.deps.store.getTasks(projectId);
    const task = tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("Unknown task.");
    const last = task.attempts.at(-1);
    const lastClass = last?.failureClass;
    const lastIsInterrupt = Boolean(last && isInterruptAttempt(last));
    if (lastIsInterrupt && !isAttemptTimeLimit(last)) freshSession = true;
    // "free" covers a user-caused interruption (Pause/Wait, Dispatch closing,
    // an explicitly denied approval) and an environment problem on the user's
    // machine: Phase 1 requires neither to ever spend the fix-round or
    // retry-after-interruption allowance.
    const outcome = classifyLoopOutcome(last);
    if (outcome === "recovery" && shouldDeferInfrastructureRecovery(task, this.clock().getTime())) {
      const profile = last?.profileName?.trim() || "The selected worker profile";
      throw new Error(
        `${profile} is still unavailable. Wait for that runtime to recover; this retry was not counted against the retry-after-interruption allowance.`,
      );
    }
    // An oversized task that failed is a planning problem first: suggest a
    // split once. Asking again repairs it as is; the limit stays soft. A task
    // that used a whole attempt's time is oversized whatever it names.
    const sizeReason = oversizeReason(task);
    const oversized = sizeReason
      ? `${sizeReason}, and its attempt failed`
      : last && isAttemptTimeLimit(last)
        ? "ran out of attempt time"
        : undefined;
    if (oversized && outcome !== "free" && !task.splitAdvised && !options?.viaEscalation) {
      task.splitAdvised = true;
      await this.deps.store.saveTasks(projectId, tasks);
      // Thrown, not returned: request_repair ends the turn, and a refusal must
      // leave the manager in it to split the task or repair it after all.
      throw new Error(
        `“${task.title}” ${oversized}. If what is left is several pieces of work, split it into smaller tasks that each name their files (propose_plan updates the board; the work so far stays in the folder). If it is one piece, call request_repair again: the same worker session continues with what it knows. This is advice, not a used-up allowance; replacing a task with one that does the same work only loses that session.`,
      );
    }
    await this.noteFrozenBrief(projectId, task.id, task, findings);
    const fixRounds = fixRoundsPerTask(
      project.policy.fixRoundsPerTask,
      (await this.deps.store.getPermissions()).fixRoundsPerTask,
    );
    let exhausted =
      outcome === "recovery"
        ? (task.recoveryCount ?? 0) >= MAX_RECOVERIES_PER_TASK
        : outcome === "repair"
          ? task.repairCount >= fixRounds
          : false;
    // An escalation grant is itself a fresh, separately bounded allowance
    // (the escalation transition limit): the stronger rung starts with clean
    // counters and attempt budget instead of reproducing the stuck-task brief.
    if (options?.viaEscalation) {
      if (outcome === "recovery") task.recoveryCount = 0;
      else if (outcome === "repair") task.repairCount = 0;
      task.stuck = undefined;
      exhausted = false;
    }
    if (exhausted && outcome === "recovery") {
      // Three attempts in a row with nothing usable: something is wrong beyond
      // what the manager can review, so the owner decides, not another retry.
      const failures = task.attempts
        .slice(-MAX_RECOVERIES_PER_TASK)
        .map((attempt) => `attempt ${attempt.number}: ${attempt.error ?? attempt.status}`)
        .join("; ");
      task.status = "needs_review";
      await this.deps.store.saveTasks(projectId, tasks);
      this.markPaused(
        project,
        "unusable_attempts",
        `“${task.title}” failed ${MAX_RECOVERIES_PER_TASK} times in a row without a usable result (${failures}).`,
      );
      await this.save(project);
      await this.appendSystem(
        projectId,
        `Paused: “${task.title}” failed ${MAX_RECOVERIES_PER_TASK} times in a row without producing anything to review (${failures}). Resume tries again; Retry task starts it fresh.`,
      );
      return "This task failed three times in a row without a usable result. Dispatch paused the run for the owner. End this turn.";
    }
    if (exhausted) {
      // Phase 1: exhaustion never fails the task or stops the run. The task
      // stays reviewable; the manager gets a stuck-task brief with the actual
      // per-attempt issue, a category, what's on disk, the counters used, and
      // every alternative (escalate, revise the plan, ask the user) with its
      // own limit. Only an explicit user decision (reply, Retry task, a new
      // run) resets the counters — see sendMessage and retryTask.
      const connection = await this.deps.store.getConnection();
      const escalation = escalationSettings(connection.escalation, connection.roles);
      const { category, reason, brief } = buildStuckTaskBrief({
        task,
        fixRounds,
        // Only "repair" or "recovery" reach this branch: "free" always forces
        // `exhausted` false above.
        outcome: outcome as "repair" | "recovery",
        escalation,
        externalEscalationsUsed: externalEscalationsUsed(project),
        claimedCapability: await this.claimedCapabilityFor(task),
        declinedProfiles: project.declinedEscalations,
      });
      task.stuck = { since: nowIso(this.clock), category, reason, brief };
      task.status = "needs_review";
      await this.deps.store.saveTasks(projectId, tasks);
      await this.save(project);
      return brief;
    }
    if (
      task.status !== "needs_review" &&
      task.status !== "failed" &&
      !(task.status === "applied" && verificationFailed(project.integration.combinedVerification))
    )
      throw new Error("Only finished work can be repaired.");
    project.integration.combinedVerification = undefined;
    if (options?.viaEscalation) {
      // The escalation grant is the fresh allowance; spending one of its own
      // rounds on the transition would leave the stronger rung with one fewer.
    } else if (outcome === "recovery") task.recoveryCount = (task.recoveryCount ?? 0) + 1;
    else if (outcome === "repair") {
      task.repairCount += 1;
      // Unusable attempts count only in a row: a reviewed attempt ends the streak.
      task.recoveryCount = 0;
    }
    // A "free" outcome (user-caused stop, environment problem) spends nothing.
    task.stuck = undefined;

    const restartSession = freshSession || lastClass === "ambiguous_inference";
    task.freshWorkerSession = restartSession;
    const limitNote = isAttemptTimeLimit(last)
      ? "Continue the same worker session after the 45-minute attempt limit. Keep retained folder changes. Finish remaining acceptance criteria and required checks. Do not redo completed files."
      : undefined;
    task.workerPrompt = withRepairFindings(
      task.workerPrompt,
      [findings, limitNote].filter(Boolean).join("\n\n"),
    );

    const outcomeLabel =
      outcome === "recovery"
        ? `Retry after interruption ${task.recoveryCount}`
        : outcome === "repair"
          ? `Fix round ${task.repairCount}`
          : "Retry";
    const reason = findings.replace(/\s+/g, " ").trim().slice(0, 1000) || "Further review needed.";
    if (last) {
      last.review = {
        decision: outcome === "free" ? "retry" : outcome,
        reason,
        at: nowIso(this.clock),
        nextAttempt: last.number + 1,
      };
    }
    task.status = "ready";
    project.status = "running";
    await this.deps.store.saveTasks(projectId, tasks);
    await this.save(project);
    if (last) {
      await this.appendSystem(
        projectId,
        `Attempt ${last.number} of “${task.title}” was sent back (${outcomeLabel.toLowerCase()}). ${reason}`,
      );
    }
    return `${outcomeLabel} queued for ${task.title}${outcome === "free" ? " without using any fix-round or retry allowance" : ""}. ${restartSession ? "A fresh worker session will start because the prior response ended incompletely." : "The same worker session will continue."}`;
  }

  /**
   * When the profile that ran the last attempt has published a `qualified`
   * or `smoke` measurement for the capability the task's `taskKind` requires,
   * name it so a `model_capability` stuck brief can call out suspect
   * evidence (`stuck-task.ts`). Best-effort: any lookup failure is silent,
   * since this is advisory context for the brief, not a gate on anything.
   */
  private async claimedCapabilityFor(
    task: TaskRecord,
  ): Promise<
    { name: CapabilityName; status: "qualified" | "smoke"; measuredAt?: string } | undefined
  > {
    const last = task.attempts.at(-1);
    if (!task.taskKind || !last) return undefined;
    const requiredCapability = TASK_KIND_CAPABILITY[task.taskKind];
    try {
      const client = await this.deps.clientFor();
      const profile = (await client.listInteractiveModels()).find(
        (model) => (model.profileId ?? model.id) === last.profileId,
      );
      const status = capabilityStatus(profile, requiredCapability);
      if (status !== "qualified" && status !== "smoke") return undefined;
      const entry = profile?.capabilities?.find((item) => item.name === requiredCapability);
      return { name: requiredCapability, status, measuredAt: entry?.measured_at };
    } catch {
      return undefined;
    }
  }

  private async requestApply(projectId: string, taskId: string): Promise<string> {
    this.assertManagerActionAllowed(projectId);
    const project = await this.requireProject(projectId);
    const tasks = await this.deps.store.getTasks(projectId);
    const task = tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("Unknown task.");
    const attempt = task.attempts.at(-1);
    if (task.status === "applied") return "This result is already accepted.";
    this.deps.onActivity?.(`Accepting "${task.title}"…`, projectId);
    if (isAttemptTimeLimit(attempt))
      throw new Error(
        "This attempt hit the 45-minute limit and is not finished. Call request_repair to continue the same worker session. Do not accept it yet.",
      );
    if (attempt && isInterruptAttempt(attempt) && attempt.status !== "completed")
      throw new Error(
        "This attempt was interrupted. Call request_repair with a fresh session. Do not accept it yet.",
      );
    if (task.status !== "needs_review" || !attempt || attempt.status !== "completed")
      throw new Error("Only a completed attempt can be accepted.");
    if (attempt.execution !== "interactive")
      throw new Error(
        "That result came from a Poundlock job, which Dispatch no longer applies. Call request_repair to run the task again on this Mac.",
      );
    const required = project.policy.verification.commands;
    const changedFiles = changedFilesForReview(task);
    const documentationOnly = isDocumentationOnlyChange(changedFiles);
    const managerReviewedWithoutCheck = canManagerReviewWithoutCheck(task, required);
    const redTests = expectsRedTests(task, changedFiles);
    // A tests-first task is accepted red: its tests exist to fail until the
    // implementation task, and they are frozen below so nothing weakens them.
    if (
      !redTests &&
      (verificationFailed(attempt.result?.verification) ||
        (required.length && !checksPassed(attempt.result?.verification, required)) ||
        (!required.length &&
          attempt.result?.verification?.status !== "passed" &&
          !documentationOnly &&
          !managerReviewedWithoutCheck))
    )
      throw new Error("Fix the failing or missing checks before accepting this result.");
    const plan = await this.deps.store.getPlan(projectId);
    const frozen = frozenTestsIn(plan?.frozenTests);
    const workingRoot = projectWorkingRoot(this.deps.store.layout.root, project);
    const frozenCopies = `${projectFiles(this.deps.store.layout.root, project.id).dir}/frozen`;
    // Tests frozen before Dispatch kept copies get one while they still match.
    await keepFrozenCopies(frozen, workingRoot, frozenCopies);
    // Its checks passed against the edited tests, so putting them back does
    // not make the attempt acceptable; the next attempt runs them again.
    if (attempt.frozenRestored?.length)
      throw new Error(frozenRefusal(attempt.frozenRestored, attempt.frozenRestored));
    if (frozen.length && !task.changesFrozenTests) {
      const touched = await frozenDrift(frozen, workingRoot);
      if (touched.length) {
        const restored = await restoreFrozenTests(frozen, touched, workingRoot, frozenCopies);
        if (restored.length) {
          attempt.frozenRestored = restored;
          await this.deps.store.saveTasks(projectId, tasks);
        }
        throw new Error(frozenRefusal(touched, restored));
      }
    }
    if (
      !redTests &&
      !documentationOnly &&
      !task.writesTests &&
      // Saved checks, or the conventional ones Dispatch found and ran.
      attempt.result?.verification?.status === "passed" &&
      attempt.result.verification.commands.length
    ) {
      const survivors = await this.mutationCheck(projectId, project, tasks, task, workingRoot);
      if (survivors) throw new Error(survivors);
    }
    task.status = "applied";
    task.stuck = undefined;
    await this.deps.store.saveTasks(projectId, tasks);
    await this.recordFrozenTests(projectId, task, changedFiles, workingRoot);
    if (redTests && verificationFailed(attempt.result?.verification))
      await this.appendSystem(
        projectId,
        `Accepted the tests from “${task.title}” while they fail, as tests written before their code should. The implementation task must make them pass without changing them.`,
      );
    if (managerReviewedWithoutCheck)
      await this.appendSystem(
        projectId,
        `Accepted “${task.title}” after manager review. No independent project check was configured or discovered.`,
      );
    return "Reviewed local edits accepted. They were already written in the project folder and were not applied again.";
  }

  /** Throws `frozenBriefNote` once per task whose brief names frozen tests it may not change. */
  private async noteFrozenBrief(
    projectId: string,
    key: string,
    task: { changesFrozenTests?: boolean },
    brief: string,
  ): Promise<void> {
    if (task.changesFrozenTests || this.frozenBriefsNoted.has(`${projectId}:${key}`)) return;
    const named = frozenNamedIn(
      frozenTestsIn((await this.deps.store.getPlan(projectId))?.frozenTests),
      brief,
    );
    if (!named.length) return;
    this.frozenBriefsNoted.add(`${projectId}:${key}`);
    throw new Error(frozenBriefNote(named));
  }

  /**
   * What the manager weighs when a round of tasks ends: the ledger, the open
   * requirements with their scenarios, and the issues noted during the round,
   * which are marked raised. Empty for a project with neither, which keeps the
   * plain completion review.
   */
  private async roundEndBrief(projectId: string): Promise<string> {
    const requirements = await this.settleLedger(projectId);
    const plan = await this.deps.store.getPlan(projectId);
    const issues = openIssues(plan?.issues);
    if (plan && issues.length) {
      const raisedAt = nowIso(this.clock);
      plan.issues = (plan.issues ?? []).map((issue) =>
        issue.raisedAt ? issue : { ...issue, raisedAt },
      );
      await this.deps.store.savePlan(projectId, plan);
    }
    if (!requirements.length && !issues.length) return "";
    const open = openRequirements(requirements);
    const disputed = disputedRequirements(requirements);
    return [
      requirements.length ? `Requirement ledger: ${ledgerLine(requirements)}.` : "",
      disputed.length
        ? `The verifier found accepted work that does not show these requirements; treat them as open:\n${disputed
            .map(
              (item) =>
                `- ${item.id}: ${item.verdict?.result} — ${item.verdict?.note || item.text}`,
            )
            .join("\n")}`
        : "",
      open.length
        ? `Open requirements:\n${open
            .map(
              (item) =>
                `- ${item.id}: ${item.text}${item.scenarios.length ? ` (shown by: ${item.scenarios.join("; ")})` : ""}`,
            )
            .join("\n")}`
        : "",
      issues.length
        ? `Issues noted during this round, for the owner:\n${issues
            .map(
              (issue) => `- ${issue.requirementId ? `${issue.requirementId}: ` : ""}${issue.text}`,
            )
            .join("\n")}`
        : "",
      open.length || disputed.length
        ? "Do not call mark_complete while requirements are open or disputed: propose the next round of tasks for them now. Put any decision the owner must make, with the issues above, in one ask_user."
        : issues.length
          ? "Raise the issues above with the owner in one ask_user before calling mark_complete, unless they no longer matter."
          : "Check that the accepted work shows each requirement's scenarios, then call mark_complete.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /**
   * Start the next round without an Approve click when it only continues
   * what the owner already approved: the previous plan was approved and all
   * its tasks accepted, every new task serves a requirement still open, the
   * new plan asks for no download or environment the old one did not, and
   * the owner chose a mode that approves within permissions. The owner wants
   * building to keep going between rounds rather than stop at each one.
   */
  private async continueRound(
    projectId: string,
    previous: PlanRecord | undefined,
    previousTasks: TaskRecord[],
    plan: PlanRecord,
    tasks: TaskRecord[],
    action: boolean,
  ): Promise<string | undefined> {
    if (action || !previous?.approved || !plan.requirements?.length) return undefined;
    if (!previousTasks.length || previousTasks.some((task) => task.status !== "applied"))
      return undefined;
    if (plan.allowDependencyDownloads && !previous.allowDependencyDownloads) return undefined;
    if ((plan.environmentNeed ?? "none") !== (previous.environmentNeed ?? "none")) return undefined;
    const project = await this.requireProject(projectId);
    const mode = effectiveToolTrust(
      project.policy.toolTrust,
      await this.deps.store.getPermissions(),
    );
    if (mode === "ask") return undefined;
    const open = new Map(
      openRequirements(settleRequirements(plan.requirements, previousTasks)).map((item) => [
        item.id.trim().toUpperCase(),
        item,
      ]),
    );
    const serves = (task: TaskRecord) =>
      (task.requirementIds ?? []).some((id) => open.has(id.trim().toUpperCase()));
    if (!tasks.every(serves)) return undefined;
    const ids = [...new Set(tasks.flatMap((task) => task.requirementIds ?? []))]
      .map((id) => id.trim().toUpperCase())
      .filter((id) => open.has(id));
    await this.approvePlan(projectId, { mode, taskTitle: `Next round for ${ids.join(", ")}` });
    const current = await this.requireProject(projectId);
    current.status = "running";
    this.stopIntents.delete(projectId);
    await this.save(current);
    return `Plan revision ${plan.revision} continues open requirements ${ids.join(", ")} within the approved authority, so it was approved automatically and starts now. Stop this turn.`;
  }

  /** Record an owner message the busy manager has not read; its next turn leads with it. */
  private async queueOwnerMessage(projectId: string, text: string): Promise<void> {
    const id = newId("msg");
    await this.appendMessage(projectId, { id, role: "user", text, createdAt: nowIso(this.clock) });
    const project = await this.requireProject(projectId);
    project.unreadOwnerMessages = [...(project.unreadOwnerMessages ?? []), id];
    await this.save(project);
  }

  /**
   * The owner's unread messages as the head of the next turn's prompt, and
   * their ids. A review turn clips its conversation to a few thousand
   * characters after the review packet, so a manager could miss requests for
   * new tasks sent while it worked.
   */
  private async unreadOwnerHead(projectId: string): Promise<{ head: string; ids: string[] }> {
    const ids = (await this.requireProject(projectId)).unreadOwnerMessages ?? [];
    if (!ids.length) return { head: "", ids };
    const wanted = new Set(ids);
    const texts = (await this.deps.store.getMessages(projectId))
      .filter((message) => wanted.has(message.id))
      .map((message) =>
        message.text.length > UNREAD_OWNER_CHARS
          ? `${message.text.slice(0, UNREAD_OWNER_CHARS)}…`
          : message.text,
      );
    if (!texts.length) return { head: "", ids };
    return {
      head: `The owner wrote while you were busy. Act on this in this turn, before anything else below:\n${texts.map((text) => `> ${text.replace(/\n/g, "\n> ")}`).join("\n\n")}\n\n`,
      ids,
    };
  }

  /**
   * The round-end check by someone other than the manager: a read-only
   * worker judges whether the code and tests show each requirement the round
   * marked done. A manager can accept work that matches its own spec but not
   * the owner's words when nobody else looks. Verdicts go on the ledger; "partly" or "not shown" blocks
   * completion until new work or the owner settles it.
   */
  private async verifyRound(projectId: string): Promise<void> {
    const requirements = await this.settleLedger(projectId);
    const pending = unverifiedRequirements(requirements).slice(0, VERIFIED_PER_ROUND);
    if (!pending.length) return;
    const report = await this.investigate(projectId, {
      role: "verifier",
      title: "Verify the round's requirements",
      question: `For each requirement below, decide from the code and tests whether the accepted work shows it to a user.\n${pending
        .map(
          (item) =>
            `- ${item.id}: ${item.text}${item.scenarios.length ? ` (scenarios: ${item.scenarios.join("; ")})` : ""}`,
        )
        .join("\n")}`,
      instructions:
        "Be skeptical. A requirement is shown only when code implements each scenario and a test exercises it the way a user would. For each scenario, name the test that would fail if the behaviour broke; if no test would, the requirement is not shown. Look for stubs, placeholders, UI that is never wired (menu items or buttons without targets, settings that are never read), swapped or wrong behaviour, tests that assert nothing, and documentation that claims more than the code does. End with exactly one line per requirement in the form `ID: shown | partly | not shown — evidence (file:line, test name)`.",
    });
    const verdicts = parseVerdicts(report, pending);
    const plan = await this.deps.store.getPlan(projectId);
    if (!plan?.requirements || !verdicts.size) {
      await this.appendSystem(
        projectId,
        "The round-end verification gave no verdicts, so the accepted work stands unverified.",
      );
      return;
    }
    const at = nowIso(this.clock);
    plan.requirements = plan.requirements.map((item) => {
      const verdict = verdicts.get(item.id.trim().toUpperCase());
      return verdict ? { ...item, verdict: { ...verdict, at } } : item;
    });
    await this.deps.store.savePlan(projectId, plan);
    const lines = [...verdicts.entries()].map(
      ([id, verdict]) => `- ${id}: ${verdict.result}${verdict.note ? ` — ${verdict.note}` : ""}`,
    );
    await this.appendSystem(projectId, `Round-end verification:\n${lines.join("\n")}`);
  }

  /**
   * A second opinion on a plan before the owner approves it, from the
   * Verifier role. A local manager's rewrite of a plan can be wrong where the
   * original was right; a stronger model reading the plan
   * against the owner's words catches that while it is cheap to fix. Only
   * with a Verifier bound: the worker is no stronger than the manager, so its
   * review would cost minutes and add little. A plan that auto-continued is
   * already running and is not reviewed.
   */
  private async reviewPlan(
    projectId: string,
    input: ProposePlanInput,
    signal?: AbortSignal,
  ): Promise<string> {
    if (input.tasks.length < LEDGER_REQUIRED_TASKS) return "";
    if (!(await this.deps.store.getConnection()).roles.verifier?.profileId) return "";
    if ((await this.requireProject(projectId)).status !== "awaiting_approval") return "";
    const pending = await this.deps.store.getPendingBoard(projectId);
    const plan = pending?.plan ?? (await this.deps.store.getPlan(projectId));
    const tasks = pending?.tasks ?? (await this.deps.store.getTasks(projectId));
    const said = (await this.deps.store.getMessages(projectId)).filter(
      (message) => message.role === "user",
    );
    // The manager's revision after a review goes to the owner as it is.
    if (this.planReviewedAt.get(projectId) === said.length) return "";
    this.planReviewedAt.set(projectId, said.length);
    const owner = said.map((message) => message.text.trim()).join("\n\n");
    const words =
      owner.length > PLAN_REVIEW_OWNER_CHARS
        ? `${owner.slice(0, PLAN_REVIEW_OWNER_CHARS * 0.4)}\n…\n${owner.slice(-PLAN_REVIEW_OWNER_CHARS * 0.6)}`
        : owner;
    const clip = (text: string, limit: number) =>
      text.length > limit ? `${text.slice(0, limit)}…` : text;
    const ledger = (plan?.requirements ?? [])
      .map(
        (item) =>
          `- ${item.id} [${item.status}]: ${item.text}${item.scenarios.length ? ` (scenarios: ${item.scenarios.join("; ")})` : ""}`,
      )
      .join("\n");
    const board = tasks
      .map(
        (task, index) =>
          `${index + 1}. ${task.title} [${task.status}]${task.requirementIds?.length ? ` serves ${task.requirementIds.join(", ")}` : ""}${task.dependsOn.length ? `; after ${task.dependsOn.join(", ")}` : ""}\n   Objective: ${clip(task.objective, 400)}\n   Accepted when: ${clip(task.acceptanceCriteria, 500)}${task.filesToTouch?.length ? `\n   Files: ${task.filesToTouch.join(", ")}` : ""}`,
      )
      .join("\n");
    const report = await this.investigate(
      projectId,
      {
        role: "verifier",
        title: "Review the proposed plan",
        question: `Review this plan before the owner approves it.\n\nThe owner's words:\n${words}\n\nRequirement ledger:\n${ledger || "(none)"}\n\nTasks:\n${board}`,
        instructions:
          "Read the project as needed and judge the plan, not the code. Check: the ledger holds everything the owner asked for (quote any missing request); each requirement's scenarios are things a user does and sees; each task's acceptance criteria describe behaviour a test can show, not only files, builds or passing checks; tasks that change a user interface can be tested without a person (controller-level tests, off-screen snapshots); the order and dependencies work, with a thin path a user can walk end to end early rather than a deep core and the app last; no task is too big for one worker; and the plan builds on what the project already has instead of redoing it. Be brief. End with `Verdict: sound` or `Verdict: revise`, followed by at most six numbered changes.",
      },
      signal,
    );
    const verdict = /verdict:\s*(sound|revise)[\s\S]*$/i.exec(report)?.[0];
    if (verdict) await this.appendSystem(projectId, `Plan review: ${clip(verdict, 2000)}`);
    return `\n\nPlan review by the Verifier (read-only):\n${report}\n\nIf it asks for changes you agree with, propose the plan again with them. If you disagree, say why in your message to the owner.`;
  }

  /** Gaps between the ledger and the board the owner is about to approve. */
  private async ledgerCoverageNote(projectId: string): Promise<string> {
    const pending = await this.deps.store.getPendingBoard(projectId);
    const plan = pending?.plan ?? (await this.deps.store.getPlan(projectId));
    if (!plan?.requirements?.length) return "";
    return coverageNote(
      requirementCoverage(
        plan.requirements,
        pending?.tasks ?? (await this.deps.store.getTasks(projectId)),
      ),
    );
  }

  /** Bring the ledger's statuses in line with the board, saving only on a change. */
  private async settleLedger(projectId: string): Promise<Requirement[]> {
    const plan = await this.deps.store.getPlan(projectId);
    if (!plan?.requirements?.length) return [];
    const settled = settleRequirements(
      plan.requirements,
      await this.deps.store.getTasks(projectId),
    );
    if (JSON.stringify(settled) !== JSON.stringify(plan.requirements)) {
      plan.requirements = settled;
      await this.deps.store.savePlan(projectId, plan);
    }
    return settled;
  }

  /**
   * Break the task's new code in a few small ways and rerun the project's
   * checks, once per attempt; returns the refusal when a break went unnoticed.
   * The folder is held so no worker runs meanwhile, and every file is put back
   * exactly as the worker left it.
   */
  private async mutationCheck(
    projectId: string,
    project: ProjectRecord,
    tasks: TaskRecord[],
    task: TaskRecord,
    root: string,
  ): Promise<string | undefined> {
    const attempt = task.attempts.at(-1);
    if (
      !attempt ||
      attempt.mutation ||
      project.policy.mutationCheck === false ||
      (task.taskKind && task.taskKind !== "closed_implementation") ||
      !this.deps.worker?.verify ||
      this.folderRuns.has(root)
    )
      return undefined;
    // Every attempt's patch, newest first: a repair's patch alone misses the
    // code earlier attempts wrote.
    const patch = [...task.attempts]
      .reverse()
      .flatMap((item) => item.result?.patches.map((view) => view.patch) ?? [])
      .join("\n");
    const candidates = mutantsFromPatch(patch);
    const tried: Array<Mutant & { caught: boolean }> = [];
    await this.restorePendingMutation(projectId);
    if (candidates.length) {
      const connection = await this.deps.store.getConnection();
      const files = projectFiles(this.deps.store.layout.root, projectId);
      const pending = `${files.dir}/mutation/pending.json`;
      this.folderRuns.add(root);
      try {
        for (const mutant of candidates) {
          if (tried.length >= MUTANTS_PER_ATTEMPT) break;
          const path = await mutableFile(root, mutant.path);
          if (!path) continue;
          const original = await readFile(path, "utf8").catch(() => undefined);
          const broken = original === undefined ? undefined : applyMutant(original, mutant);
          if (original === undefined || broken === undefined) continue;
          this.deps.onActivity?.(
            `Mutation check on “${task.title}”: ${mutant.path}:${mutant.line} ${mutant.change}`,
            projectId,
          );
          // Journalled first: if Dispatch quits mid-check, `restorePendingMutation`
          // puts the line back on the next start.
          await mkdir(`${files.dir}/mutation`, { recursive: true, mode: 0o700 });
          await writeFile(pending, JSON.stringify({ path, original }), { mode: 0o600 });
          await writeFile(path, broken);
          try {
            const verification = await this.deps.worker.verify({
              project,
              task,
              cwd: root,
              model: { id: attempt.profileName || "verification-only" },
              controllerUrl: connection.url,
              token: connection.token,
              dataDir: `${files.dir}/mutation`,
              trust: effectiveToolTrust(
                project.policy.toolTrust,
                await this.deps.store.getPermissions(),
              ),
              allowDependencyDownloads: false,
              signal: new AbortController().signal,
              approvals: this.deps.approvals!,
              getPolicy: async () => ({
                project: await this.requireProject(projectId),
                permissions: await this.deps.store.getPermissions(),
              }),
              reviewAction: this.deps.reviewAction,
              privateHome: `${files.dir}/worker-home`,
              onActivity: (text) => this.deps.onActivity?.(text, projectId),
            });
            tried.push({ ...mutant, caught: verification.status !== "passed" });
          } finally {
            await writeFile(path, original);
            await rm(pending, { force: true });
          }
        }
      } finally {
        this.folderRuns.delete(root);
      }
    }
    attempt.mutation = {
      at: nowIso(this.clock),
      mutants: tried.map(({ path, line, change, caught }) => ({ path, line, change, caught })),
    };
    await this.deps.store.saveTasks(projectId, tasks);
    if (!tried.length) return undefined;
    const survivors = tried.filter((mutant) => !mutant.caught);
    await this.appendSystem(
      projectId,
      `Mutation check on “${task.title}”: ${tried.length - survivors.length} of ${tried.length} small breaks caught by the checks.${survivors
        .map((mutant) => `\n- Not caught: ${mutant.path}:${mutant.line} ${mutant.change}`)
        .join("")}`,
    );
    return survivors.length ? survivorsRefusal(survivors, tried.length) : undefined;
  }

  /** Put back a line a mutation check broke when Dispatch stopped before restoring it. */
  private async restorePendingMutation(projectId: string): Promise<void> {
    const pending = `${projectFiles(this.deps.store.layout.root, projectId).dir}/mutation/pending.json`;
    const saved = await readFile(pending, "utf8").catch(() => undefined);
    if (!saved) return;
    const { path, original } = JSON.parse(saved) as { path: string; original: string };
    await writeFile(path, original);
    await rm(pending, { force: true });
    await this.appendSystem(
      projectId,
      `Dispatch stopped during a mutation check and has put ${path} back as the worker left it.`,
    );
  }

  /** Freeze an accepted test task's tests, and tell the conversation which. */
  private async recordFrozenTests(
    projectId: string,
    task: TaskRecord,
    changedFiles: string[],
    root: string,
  ): Promise<void> {
    if (!task.writesTests && !task.changesFrozenTests) return;
    const plan = await this.deps.store.getPlan(projectId);
    if (!plan) return;
    const before = plan.frozenTests ?? [];
    plan.frozenTests = await freezeAccepted(before, task, changedFiles, root);
    await this.deps.store.savePlan(projectId, plan);
    await keepFrozenCopies(
      plan.frozenTests,
      root,
      `${projectFiles(this.deps.store.layout.root, projectId).dir}/frozen`,
    );
    const added = plan.frozenTests.filter(
      (test) => !before.some((old) => old.path === test.path && old.sha256 === test.sha256),
    );
    if (added.length)
      await this.appendSystem(
        projectId,
        `Frozen tests from “${task.title}”: ${added.map((test) => test.path).join(", ")}. Later workers may not change them.`,
      );
  }

  private async combinedVerify(projectId: string): Promise<void> {
    const project = await this.requireProject(projectId);
    const tasks = await this.deps.store.getTasks(projectId);
    let verification = tasks.at(-1)?.attempts.at(-1)?.result?.verification;
    if (tasks.length > 1 && project.policy.verification.commands.length) {
      if (!this.deps.worker.verify) throw new Error("Combined local verification is unavailable.");
      const connection = await this.deps.store.getConnection();
      const controller = new AbortController();
      this.managerSignals.set(projectId, controller);
      try {
        const task = tasks.at(-1)!;
        verification = await this.deps.worker.verify({
          project,
          task,
          cwd: managerReadableRoot(this.deps.store.layout.root, project),
          model: { id: task.profileName ?? "verification-only" },
          controllerUrl: connection.url,
          token: connection.token,
          dataDir: `${projectFiles(this.deps.store.layout.root, projectId).dir}/combined-local`,
          trust: effectiveToolTrust(
            project.policy.toolTrust,
            await this.deps.store.getPermissions(),
          ),
          allowDependencyDownloads: false,
          signal: controller.signal,
          approvals: this.deps.approvals!,
          getPolicy: async () => ({
            project: await this.requireProject(projectId),
            permissions: await this.deps.store.getPermissions(),
          }),
          reviewAction: this.deps.reviewAction,
          privateHome: `${projectFiles(this.deps.store.layout.root, projectId).dir}/worker-home`,
          onActivity: (text) => this.deps.onActivity?.(text, projectId),
        });
      } finally {
        this.managerSignals.delete(projectId);
      }
      if (controller.signal.aborted) return;
    }
    project.integration.combinedVerification = verification;
    project.status = "reviewing";
    await this.save(project);
    await this.verifyRound(projectId);
    const roundEnd = await this.roundEndBrief(projectId);
    await this.managerTurn(
      projectId,
      `All local tasks have been reviewed and accepted. ${roundEnd || "Review the task verification evidence and call mark_complete if the whole plan is satisfied."}\n${wrapUntrusted(
        "task checks",
        tasks
          .map(
            (task) =>
              `- ${task.title} (${task.id}): ${checksLine(task.attempts.at(-1)?.result?.verification)}`,
          )
          .join("\n"),
      )}`,
    );
  }

  private async dispatchReady(projectId: string): Promise<void> {
    if (this.dispatching.has(projectId) || this.localRuns.has(projectId)) return;
    this.dispatching.add(projectId);
    try {
      await this.dispatchReadyOnce(projectId);
    } finally {
      this.dispatching.delete(projectId);
    }
  }

  private async dispatchReadyOnce(projectId: string): Promise<void> {
    const project = await this.requireProject(projectId);
    if (
      project.status === "paused" ||
      project.status === "cancelled" ||
      project.status === "failed"
    )
      return;
    if (project.budget.stopReason) return;
    const workingRoot = projectWorkingRoot(this.deps.store.layout.root, project);
    if (project.source.kind === "local_folder" && this.folderRuns.has(workingRoot)) return;
    // `folderRuns` fences this process; the lock fences the machine. Another
    // Dispatch client may be driving the same folder from its own data
    // directory, where an in-process Set cannot see it.
    if (this.deps.folderLock && !this.deps.folderLock.holds(workingRoot)) {
      // Silence here reads exactly like a hung project: the poll keeps
      // ticking, the status keeps saying "working", and nothing dispatches.
      // Say it once, and say it again if the lock is lost a second time.
      if (!this.lockBlocked.has(projectId)) {
        this.lockBlocked.add(projectId);
        const holder = await this.deps.folderLock.heldBy(workingRoot);
        await this.appendSystem(
          projectId,
          `${lockBlockedMessage(holder)} Nothing will start from here until that client releases ${workingRoot}.`,
        );
      }
      return;
    }
    this.lockBlocked.delete(projectId);
    const plan = await this.deps.store.getPlan(projectId);
    if (!plan?.approved) return;
    assertWorkflowCanDispatch({
      workflowId: project.workflowId ?? project.id,
      revision: project.planRevision,
      planRevision: project.planRevision,
      managerConversationId: project.managerSessionId,
      workerConversations: {},
      dispatchAuthorized: project.dispatchAuthorized ?? true,
    });
    const tasks = await this.deps.store.getTasks(projectId);
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
      const depsDone = task.dependsOn.every((id) => byId.get(id)?.status === "applied");
      if (task.status === "blocked" && depsDone) task.status = "ready";
      if (task.status === "ready" && !depsDone) task.status = "blocked";
    }
    await this.deps.store.saveTasks(projectId, tasks);
    const ready = tasks.find((task) => task.status === "ready");
    if (!ready) return;
    if (!(await this.prepareApprovedEnvironment(project))) return;
    const current = await this.requireProject(projectId);
    if (["paused", "cancelled", "failed", "needs_input"].includes(current.status)) return;
    await this.dispatchLocal(current, ready);
  }

  private async reviewTurn(projectId: string): Promise<void> {
    const tasks = await this.deps.store.getTasks(projectId);
    const pending = tasks.filter((task) => task.status === "needs_review");
    if (pending.length === 0) return;
    const project = await this.requireProject(projectId);
    project.status = "reviewing";
    await this.save(project);

    await this.managerTurn(
      projectId,
      buildManagerReviewPrompt(pending, project.policy.verification.commands),
      true,
    );
    // A review that ends without a decision gets one reminder before the run
    // waits for the owner; unattended, a silent review stalled a run for hours.
    if (await this.reviewUndecided(projectId))
      await this.managerTurn(
        projectId,
        "Your review ended without a decision, so the work is waiting. Decide each pending task now: request_apply_result, request_repair, request_escalation, or ask_user.",
        true,
      );
    await this.settleUnresolvedReview(projectId);
  }

  /** True when a review turn left finished work with no decision and nothing else pending. */
  private async reviewUndecided(projectId: string): Promise<boolean> {
    const latest = await this.requireProject(projectId);
    if (
      [
        "paused",
        "cancelled",
        "completed",
        "needs_input",
        "failed",
        "running",
        "waiting_for_capacity",
        "awaiting_approval",
      ].includes(latest.status)
    )
      return false;
    return (await this.deps.store.getTasks(projectId)).some(
      (task) => task.status === "needs_review",
    );
  }

  private async settleUnresolvedReview(projectId: string): Promise<void> {
    const latest = await this.requireProject(projectId);
    if (
      [
        "paused",
        "cancelled",
        "completed",
        "needs_input",
        "failed",
        "running",
        "waiting_for_capacity",
        // A revised plan proposed during review is a decision: the user approves it.
        "awaiting_approval",
      ].includes(latest.status)
    )
      return;
    const tasks = await this.deps.store.getTasks(projectId);
    const pending = tasks.filter((task) => task.status === "needs_review");
    if (!pending.length) return;
    this.markPaused(
      latest,
      "undecided_review",
      "The Project Manager ended its review without a decision.",
    );
    await this.save(latest);
    const titles = pending.map((task) => `“${task.title}”`).join(", ");
    await this.appendSystem(
      projectId,

      `The Project Manager finished this review without accepting ${titles}, requesting a repair, or asking you a question. Resume sends the result for another review. Reply in the composer if you want to give guidance first.`,
    );
  }

  /**
   * Compacts the manager's conversation now: the notice goes into the
   * conversation, like the one written when it compacts itself.
   *
   * The project counts as mid-turn while this runs, because Pi aborts whatever
   * the session is doing before it compacts, and a poll must not start a turn
   * under it. A local worker on the manager's own model slot holds it off for
   * the reason a message does: the summary is an inference request, and it
   * would unload the worker's model mid-task.
   */
  async compactConversation(projectId: string, instructions?: string): Promise<CompactOutcome> {
    const focus = instructions?.trim() || undefined;
    if (focus && focus.length > MAX_COMPACT_INSTRUCTIONS)
      throw new Error(
        `Instructions for the summary are limited to ${MAX_COMPACT_INSTRUCTIONS.toLocaleString("en-US")} characters; these are ${focus.length.toLocaleString("en-US")}.`,
      );
    if (this.turning.has(projectId))
      throw new Error(
        "The Project Manager is working on this conversation. Compact it when the turn has finished.",
      );
    this.turning.add(projectId);
    const signal = new AbortController();
    this.managerSignals.set(projectId, signal);
    const run = this.runCompaction(projectId, focus, signal.signal);
    this.managerTurnRuns.set(
      projectId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await run;
    } finally {
      await this.settleCompactionNotices();
      this.turning.delete(projectId);
      this.managerSignals.delete(projectId);
      this.managerTurnRuns.delete(projectId);
      this.deps.onActivity?.("", projectId);
      await this.deps.notify?.();
      void this.deps.onUsageRefresh?.();
    }
  }

  private async runCompaction(
    projectId: string,
    instructions: string | undefined,
    signal: AbortSignal,
  ): Promise<CompactOutcome> {
    if (this.localRuns.has(projectId) && (await this.managerWouldEvictWorker(projectId)))
      throw new Error(
        "The worker is using this machine's only model slot, and the Project Manager runs a different model on it. Compacting now would unload the worker's model mid-task. Compact the conversation when the worker finishes.",
      );
    const manager = this.deps.manager;
    if (!manager.compact) return { status: "unsupported" };
    const project = await this.requireProject(projectId);
    this.deps.onActivity?.("Compacting the conversation…", projectId);
    await this.deps.notify?.();
    try {
      const outcome = await manager.compact({
        project,
        signal,
        host: this.toolHost(projectId),
        instructions,
        onActivity: (text) => this.deps.onActivity?.(text, projectId),
        onCapacityWait: async (state) => {
          await this.recordCapacityWait(projectId, state);
        },
        onContextUsage: (usage) => this.deps.onContextUsage?.(usage, projectId),
      });
      if (outcome.status === "compacted")
        await this.appendSystem(projectId, compactionNoticeText(outcome), "notice");
      return outcome;
    } catch (error) {
      if (signal.aborted) {
        await this.appendSystem(projectId, "Compaction stopped. The conversation is unchanged.");
        throw new Error("Compaction stopped.");
      }
      throw new Error(
        `The conversation could not be compacted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Drops the manager's session; a new one starts empty, so its context use is unknown. */
  private async resetManagerConversation(projectId: string): Promise<void> {
    await this.deps.manager.reset?.(projectId);
    this.deps.onContextUsage?.(undefined, projectId);
  }

  /** Notices still being written. A turn ends only after they are in the conversation. */
  private compactionNotices = new Set<Promise<void>>();

  private recordCompaction(projectId: string, event: CompactionEvent): void {
    const write = this.appendSystem(projectId, compactionNoticeText(event), "notice").catch(
      () => undefined,
    );
    this.compactionNotices.add(write);
    void write.finally(() => this.compactionNotices.delete(write));
  }

  private async settleCompactionNotices(): Promise<void> {
    await Promise.all([...this.compactionNotices]);
  }

  /**
   * Tracks the in-flight manager turn per project so `shutdown()` can wait
   * for it to actually finish (persist its final state) after aborting it,
   * the same way `localRuns` lets shutdown wait for an interactive worker.
   * Without this, closing Dispatch mid-turn could quit before the aborted
   * turn's own cleanup (recording the interruption, saving state) completed.
   */
  private managerTurnRuns = new Map<string, Promise<void>>();

  private async managerTurn(
    projectId: string,
    prompt: string,
    boundedReview = false,
    fromOwner = false,
  ): Promise<void> {
    const run = this.runManagerTurn(projectId, prompt, boundedReview, fromOwner);
    this.managerTurnRuns.set(projectId, run);
    try {
      await run;
    } finally {
      if (this.managerTurnRuns.get(projectId) === run) this.managerTurnRuns.delete(projectId);
    }
  }

  private async runManagerTurn(
    projectId: string,
    prompt: string,
    boundedReview = false,
    fromOwner = false,
  ): Promise<void> {
    if (this.turning.has(projectId)) {
      throw new Error("This project already has an active manager turn.");
    }
    const project = await this.requireProject(projectId);
    const planTasks = (await this.deps.store.getTasks(projectId)).length;
    if (project.budget.managerTurnsUsed >= managerTurnsForPlan(planTasks)) {
      // A limit reached, not a failure: Resume continues with a fresh allowance.
      project.budget.stopReason = TURN_BUDGET_STOP;
      this.markPaused(project, "awaiting_resume", TURN_BUDGET_STOP);
      await this.save(project);
      await this.appendSystem(projectId, project.budget.stopReason);
      return;
    }
    this.turning.add(projectId);
    const managerSignal = new AbortController();
    this.managerSignals.set(projectId, managerSignal);
    project.budget.managerTurnsUsed += 1;
    await this.save(project);
    this.deps.onActivity?.("Starting the Project Manager…", projectId);
    await this.deps.notify?.();
    const files = projectFiles(this.deps.store.layout.root, projectId);
    try {
      const recentConversation = wrapUntrusted(
        "recent conversation",
        JSON.stringify((await this.deps.store.getMessages(projectId)).slice(-8)),
        boundedReview ? 3_000 : 20_000,
      );
      const taskState = wrapUntrusted(
        "task state",
        JSON.stringify(
          (await this.deps.store.getTasks(projectId)).map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            attempts: task.attempts.length,
            escalation: task.escalation?.profile.profileName,
          })),
        ),
        boundedReview ? 1_500 : 20_000,
      );
      const turnPrompt = `${prompt}\n\nCurrent project status: ${project.status}. Plan revision: ${project.planRevision}.\n${recentConversation}\n${taskState}`;
      const unread = await this.unreadOwnerHead(projectId);
      const result = await this.deps.manager.runTurn({
        project,
        // A turn the owner's own words started or reached (ADR 017's web content hold).
        fromOwner: fromOwner || unread.ids.length > 0,
        signal: managerSignal.signal,
        workspace: files.workspace,
        prompt: `${unread.head}${boundedReview ? limitManagerReviewTurn(turnPrompt) : turnPrompt}`,
        projectBrief: await this.deps.store.getBrief(projectId),
        ledger: ledgerBlock((await this.deps.store.getPlan(projectId))?.requirements),
        host: this.toolHost(projectId),
        onActivity: (text) => this.deps.onActivity?.(text, projectId),
        onDraft: (text) => this.deps.onManagerDraft?.(text, projectId),
        onCompaction: (event) => this.recordCompaction(projectId, event),
        onContextUsage: (usage) => this.deps.onContextUsage?.(usage, projectId),
        onCapacityWait: async (state) => {
          await this.recordCapacityWait(projectId, state);
        },
      });
      if (result.capacityBlocked) {
        const failure = classifyInfrastructureError(
          result.infrastructureError ?? "capacity_in_use",
        );
        if (result.toolTrace.length) {
          if (result.text.trim())
            await this.appendMessage(projectId, {
              id: newId("msg"),
              role: "manager",
              text: result.text,
              createdAt: nowIso(this.clock),
              reasoning: result.reasoning,
            });
          const latest = await this.requireProject(projectId);
          this.markPaused(
            latest,
            failure.issue.code === "capacity" ? "capacity" : "infrastructure",
            failure.issue.detail,
          );
          latest.infrastructureIssue = failure.issue;
          await this.save(latest);
          await this.appendSystem(
            projectId,
            `${failure.issue.title}. ${failure.issue.detail} The manager had already used tools, so the turn was not replayed. Results are retained.`,
          );
        } else
          await this.managerInfrastructureFailure(
            projectId,
            prompt,
            failure,
            result.infrastructureError,
          );
        return;
      }
      this.managerRetries.delete(projectId);
      const recovered = await this.requireProject(projectId);
      const read = new Set(unread.ids);
      if (recovered.infrastructureIssue || read.size) {
        recovered.infrastructureIssue = undefined;
        if (read.size) {
          const left = (recovered.unreadOwnerMessages ?? []).filter((id) => !read.has(id));
          recovered.unreadOwnerMessages = left.length ? left : undefined;
        }
        await this.save(recovered);
      }
      const recordedPlan = result.toolTrace.some(
        (item) => item.name === "propose_plan" && !item.error,
      );
      const asked = result.toolTrace.some((item) => item.name === "ask_user" && !item.error);
      const proposal = recordedPlan ? await this.deps.store.getPlan(projectId) : undefined;
      // What the manager said on screen before a tool ended its turn is kept:
      // ahead of a proposal, or folded into the question it led to.
      const said = result.text.trim();
      if (!asked && proposal && said)
        await this.appendMessage(projectId, {
          id: newId("msg"),
          role: "manager",
          text: result.text,
          createdAt: nowIso(this.clock),
          reasoning: result.reasoning,
        });
      if (!asked && (proposal || said))
        await this.appendMessage(projectId, {
          id: newId("msg"),
          role: "manager",
          text: proposal
            ? `${proposal.summary}\n\n${proposal.authority}\n\nApprove the proposal below to start, or continue discussing it here.`
            : result.text,
          createdAt: nowIso(this.clock),
          toolTrace: result.toolTrace,
          reasoning: result.reasoning,
        });
      else if (asked && recovered.needsInput) {
        // ask_user already appended its own message (with no trace available
        // to it yet, since the turn's tools were still executing); attach the
        // now-complete trace so the discovery reads that led to the question
        // are not silently lost.
        const question = recovered.needsInput.question;
        const messages = await this.deps.store.getMessages(projectId);
        const message = [...messages]
          .reverse()
          .find((m) => m.role === "manager" && m.text === question && !m.toolTrace);
        if (message)
          await this.deps.store.updateMessage(projectId, message.id, {
            toolTrace: result.toolTrace,
            reasoning: result.reasoning,
            ...(said && said !== question
              ? { text: said.includes(question) ? said : `${said}\n\n${question}` }
              : {}),
          });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (INFRASTRUCTURE_ERROR.test(message)) {
        await this.managerInfrastructureFailure(
          projectId,
          prompt,
          classifyInfrastructureError(message),
          message,
        );
        return;
      }
      const partial = (error as { partialText?: string }).partialText;
      if (partial)
        await this.appendMessage(projectId, {
          id: newId("msg"),
          role: "manager",
          text: partial,
          createdAt: nowIso(this.clock),
        });
      const latest = await this.requireProject(projectId);
      if (managerSignal.signal.aborted) {
        if (!["completed", "cancelled"].includes(latest.status))
          await this.appendSystem(
            projectId,
            "Manager stopped. Conversation and task results are retained.",
          );
      } else if (
        error instanceof RouteRevisionChangedError &&
        !["completed", "cancelled"].includes(latest.status)
      ) {
        // Not an interrupted reply: sending another message fails the same way
        // until the owner re-approves the route, so say exactly that.
        latest.status = "needs_input";
        latest.needsInput = {
          question: message,
          askedAt: nowIso(this.clock),
          kind: "route_change",
        };
        await this.save(latest);
        await this.appendSystem(
          projectId,
          `${message} Approve the current route in Settings → Models and routing, then send your message again.`,
        );
      } else {
        let freshManagerSession = false;
        if (!["completed", "cancelled"].includes(latest.status)) {
          this.markPaused(latest, "manager_interrupted", `The manager turn failed: ${message}`);
          const managerFailure = classifyAttemptFailure({ error: message });
          if (
            ["ambiguous_inference", "output_limit", "context_limit"].includes(managerFailure) ||
            /manager model returned an error|manager finished without a visible reply/i.test(
              message,
            )
          ) {
            await this.resetManagerConversation(projectId);
            latest.managerSessionId = newId("mgr");
            latest.freshConversation = true;
            freshManagerSession = true;
          }
          await this.save(latest);
        }
        const plan = await this.deps.store.getPlan(projectId);
        await this.appendSystem(
          projectId,
          `The manager turn failed: ${message}${
            freshManagerSession
              ? plan?.approved
                ? " Resume starts a fresh manager session from Dispatch's saved conversation and task state."
                : " Send another message to retry in a fresh manager session using Dispatch's saved conversation."
              : ""
          }`,
        );
      }
    } finally {
      await this.settleCompactionNotices();
      this.turning.delete(projectId);
      this.managerSignals.delete(projectId);
      this.deps.onActivity?.("", projectId);
      await this.deps.notify?.();
      void this.deps.onUsageRefresh?.();
    }
    const handoff = this.managerHandoffs.get(projectId);
    this.managerHandoffs.delete(projectId);
    if (handoff) {
      const latest = await this.requireProject(projectId);
      if (
        !this.stopIntents.has(projectId) &&
        !["paused", "cancelled", "completed", "failed", "needs_input"].includes(latest.status)
      )
        await this.managerTurn(projectId, handoff);
    }
  }

  private async managerInfrastructureFailure(
    projectId: string,
    prompt: string,
    failure: ReturnType<typeof classifyInfrastructureError>,
    original = "",
  ): Promise<void> {
    if (
      failure.retryable &&
      !/wait exhausted|route changed while waiting|not resent/i.test(original)
    ) {
      await this.managerCapacityWait(projectId, prompt, failure.issue);
      return;
    }
    this.managerRetries.delete(projectId);
    const project = await this.requireProject(projectId);
    project.budget.managerTurnsUsed = Math.max(0, project.budget.managerTurnsUsed - 1);
    this.markPaused(
      project,
      failure.issue.code === "capacity" ? "capacity" : "infrastructure",
      failure.issue.detail,
    );
    project.infrastructureIssue = failure.issue;
    await this.save(project);
    await this.appendSystem(projectId, `${failure.issue.title}. ${failure.issue.detail}`);
  }

  private async managerCapacityWait(
    projectId: string,
    prompt: string,
    issue: import("@shared/types").InfrastructureIssue,
  ): Promise<void> {
    const first = !this.managerRetries.has(projectId);
    const startedAt = this.managerRetries.get(projectId)?.startedAt ?? this.clock().getTime();
    const project = await this.requireProject(projectId);
    if (this.clock().getTime() - startedAt >= 21 * 60_000) {
      this.managerRetries.delete(projectId);
      this.markPaused(project, "capacity", "Poundlock did not recover within the retry window.");
      project.infrastructureIssue = {
        ...issue,
        title: "Poundlock still needs attention",
        detail:
          "Poundlock did not recover within the retry window. Work is retained. Check the service, then retry your message or resume approved work.",
      };
      await this.save(project);
      await this.appendSystem(
        projectId,
        `${project.infrastructureIssue.title}. ${project.infrastructureIssue.detail}`,
      );
      return;
    }
    this.managerRetries.set(projectId, {
      prompt,
      after: this.clock().getTime() + 15_000,
      startedAt,
    });
    project.budget.managerTurnsUsed = Math.max(0, project.budget.managerTurnsUsed - 1);
    project.status = "waiting_for_capacity";
    project.infrastructureIssue = {
      ...issue,
      retryAt: new Date(this.clock().getTime() + 15_000).toISOString(),
    };
    await this.save(project);
    if (first)
      await this.appendSystem(
        projectId,
        `${issue.title}. ${issue.detail} The next check is in 15 seconds; waiting does not spend the manager-turn budget. You can pause at any time.`,
      );
  }

  /**
   * Answer a question the manager's own tools cannot: a read-only worker runs
   * now, inside the manager's turn, and its report is the tool's result.
   *
   * No plan, task or board entry is created, and the project's status is not
   * touched, so an investigation can run beside a published plan without
   * revising or pausing it. The trust mode still governs what the worker's
   * tools may do; it does not decide whether the manager may ask.
   */
  async investigate(
    projectId: string,
    input: InvestigationInput,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.deps.worker || !this.deps.approvals)
      return "Investigations need the local worker, which this client does not run. Answer from what you can read, and say what you could not check.";
    const project = await this.requireProject(projectId);
    const cwd = projectWorkingRoot(this.deps.store.layout.root, project);
    const connection = await this.deps.store.getConnection();
    const id = newId("investigation");
    const task: TaskRecord = {
      id,
      title: input.title,
      objective: input.question,
      workerPrompt: input.instructions,
      acceptanceCriteria:
        "A report with evidence, or an explicit statement that nothing was found.",
      dependsOn: [],
      difficulty: "small",
      taskKind: "open_investigation",
      route: "interactive",
      contextNote: "",
      status: "running",
      repairCount: 0,
      attempts: [],
    };
    let model: import("@shared/types").InteractiveModel;
    let reasoning: import("@shared/types").ReasoningChoice;
    try {
      const models = await (await this.deps.clientFor()).listInteractiveModels();
      const verifier =
        input.role === "verifier" ? resolveVerifierProfile(models, connection.roles) : undefined;
      model =
        verifier ??
        resolveInteractiveWorkerProfile(models, connection.roles, project, task, connection);
      const bound = verifier
        ? connection.roles.verifier
        : projectWorkerRoles(connection.roles, project.policy).interactive;
      ({ choice: reasoning } = resolveReasoning({
        model,
        role: "interactive",
        roleDefault:
          bound && [model.profileId, model.id].includes(bound.profileId)
            ? bound.reasoning
            : undefined,
      }));
    } catch (error) {
      return `The investigation could not start: ${error instanceof Error ? error.message : String(error)} This is a configuration problem, not a problem with the question. Tell the user what to fix.`;
    }
    const preference =
      connection.profiles?.[model.profileId ?? model.id] ?? connection.profiles?.[model.id] ?? {};
    if (
      !(await this.authorizeDestination(
        project,
        model,
        effectiveDestination(model.dataDestination, preference.approvedDestination),
      ))
    )
      return `The investigation did not start: the user has not approved sending this project to ${model.name ?? model.id}. Tell them, and answer from what you can read.`;
    const name = model.name ?? model.id;
    await this.appendSystem(
      projectId,
      `Investigating with ${name}: ${input.title}. Read-only: the worker can read files and Git history, not change anything.`,
    );
    const files = projectFiles(this.deps.store.layout.root, project.id);
    const dataDir = `${files.dir}/investigations/${id}`;
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    this.deps.onActivity?.(`Investigating with ${name}: ${input.title}`, projectId);
    try {
      const capabilities = await (await this.deps.clientFor())
        .capabilities?.()
        .catch(() => undefined);
      const result = await this.deps.worker.run({
        project,
        task,
        cwd,
        model,
        reasoning,
        controllerUrl: connection.url,
        token: connection.token,
        dataDir,
        trust: effectiveToolTrust(project.policy.toolTrust, await this.deps.store.getPermissions()),
        readOnly: true,
        allowDependencyDownloads: false,
        signal: controller.signal,
        approvals: this.deps.approvals,
        getPolicy: async () => ({
          project: await this.requireProject(projectId),
          permissions: await this.deps.store.getPermissions(),
        }),
        reviewAction: this.deps.reviewAction,
        sessionDir: `${dataDir}/sessions`,
        privateHome: `${files.dir}/worker-home`,
        lastApprovedRoutingRevision: lastApprovedWorkerRevision(task, model, connection.roles),
        capabilities,
        onActivity: (text) => this.deps.onActivity?.(text, projectId),
      });
      const changed = result.changedFiles.length
        ? `\nWarning: files changed while it ran, which a read-only worker cannot do; something else is editing this folder: ${result.changedFiles.join(", ")}.`
        : "";
      if (result.error) {
        const failure = classifyAttemptFailure({ error: result.error });
        await this.appendSystem(projectId, `Investigation stopped: ${result.error}`);
        return [
          `The investigation by ${name} could not finish.`,
          `Exact error: ${result.error}`,
          failure === "policy"
            ? "A command was declined. That is the user's decision, not a failure of the worker."
            : failure === "context_limit"
              ? "The question was too big for one worker context. Split it: investigate fewer commits or files at a time, then combine the reports. Repeating it whole will fail the same way."
              : "This is an operational problem (environment, permission or availability), not a reasoning failure. Do not retry it as a plan.",
          "Tell the user what failed and what would let it succeed, and include anything the worker reported before it stopped:",
          result.output,
          changed,
        ]
          .filter(Boolean)
          .join("\n");
      }
      await this.appendSystem(projectId, `Investigation finished: ${input.title}.`);
      return `Report from ${name} (read-only; nothing in the project was changed by it):${changed}\n\n${result.output}`;
    } finally {
      signal?.removeEventListener("abort", stop);
    }
  }

  private async dispatchLocal(project: ProjectRecord, task: TaskRecord): Promise<void> {
    const cwd = projectWorkingRoot(this.deps.store.layout.root, project);
    if (this.folderRuns.has(cwd)) return;
    // A copy of each frozen test before a worker can touch it, so a refused
    // edit can be put back without Git.
    await keepFrozenCopies(
      frozenTestsIn((await this.deps.store.getPlan(project.id))?.frozenTests),
      cwd,
      `${projectFiles(this.deps.store.layout.root, project.id).dir}/frozen`,
    );
    const connection = await this.deps.store.getConnection();
    const models = await (await this.deps.clientFor()).listInteractiveModels();
    if (task.escalation && !validEscalationGrant(task.escalation, connection, project)) {
      project.status = "needs_input";
      project.needsInput = {
        question:
          "The saved escalation authorization no longer matches current settings. Review the frontier policy with the manager before retrying.",
        askedAt: nowIso(this.clock),
        kind: "configuration",
      };
      await this.save(project);
      return;
    }
    let model;
    let reasoning: import("@shared/types").ReasoningChoice;
    try {
      model = resolveInteractiveWorkerProfile(models, connection.roles, project, task, connection);
      // The Worker role's saved choice belongs to the profile it was saved
      // for; any other worker profile runs at its own default.
      const bound = projectWorkerRoles(connection.roles, project.policy).interactive;
      ({ choice: reasoning } = resolveReasoning({
        model,
        role: "interactive",
        roleDefault:
          bound && [model.profileId, model.id].includes(bound.profileId)
            ? bound.reasoning
            : undefined,
      }));
    } catch (error) {
      project.status = "needs_input";
      project.needsInput = {
        question: error instanceof Error ? error.message : String(error),
        askedAt: nowIso(this.clock),
        kind: roleResolutionNeedsInputKind(error),
      };
      await this.save(project);
      return;
    }
    const preference =
      connection.profiles?.[model.profileId ?? model.id] ?? connection.profiles?.[model.id] ?? {};
    if (
      !(
        task.escalation &&
        task.escalation.destination ===
          effectiveDestination(model.dataDestination, preference.approvedDestination)
      ) &&
      !(await this.authorizeDestination(
        project,
        model,
        effectiveDestination(model.dataDestination, preference.approvedDestination),
      ))
    )
      return;
    const latest = await this.requireProject(project.id);
    const latestConnection = await this.deps.store.getConnection();
    if (
      escalationPolicyKey(latestConnection) !== escalationPolicyKey(connection) ||
      latest.planRevision !== project.planRevision ||
      !["running", "waiting_for_capacity", "reviewing"].includes(latest.status)
    )
      return;
    const controller = new AbortController();
    const id = newId("local");
    const attempt: AttemptRecord = {
      id,
      number: task.attempts.length + 1,
      idempotencyKey: id,
      requestHash: "local",
      profileId: model.profileId ?? model.id,
      profileName: model.name ?? model.id,
      harnessId: "pi",
      execution: "interactive",
      role: task.escalation ? "escalation" : "interactive",
      routingRevision: model.routingRevision,
      dataDestination: preference.approvedDestination ?? model.dataDestination,
      status: "running",
      createdAt: nowIso(this.clock),
      selectionReason: task.escalation
        ? `Manager escalation to ${model.name ?? model.id}: ${task.escalation.reason}`
        : `Interactive worker ${model.name ?? model.id} for a ${task.difficulty} task${task.repairCount ? " repair" : ""}. Tools run in the attached folder; no snapshot upload.`,
    };
    if (task.freshWorkerSession || !task.workerSessionKey) task.workerSessionKey = id;
    task.freshWorkerSession = false;
    task.attempts.push(attempt);
    task.status = "running";
    task.profileId = attempt.profileId;
    task.profileName = attempt.profileName;
    task.selectionReason = attempt.selectionReason;
    const tasks = await this.deps.store.getTasks(project.id);
    await this.deps.store.saveTasks(
      project.id,
      tasks.map((item) => (item.id === task.id ? task : item)),
    );
    project.status = "running";
    await this.save(project);
    const plan = await this.deps.store.getPlan(project.id);
    const trust = effectiveToolTrust(
      project.policy.toolTrust,
      await this.deps.store.getPermissions(),
    );
    const dataDir = `${projectFiles(this.deps.store.layout.root, project.id).dir}/attempts/${id}`;
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    this.folderRuns.add(cwd);
    this.deps.onActivity?.(`Starting ${model.id} for ${task.title}…`, project.id);
    const capabilities = await (await this.deps.clientFor())
      .capabilities?.()
      .catch(() => undefined);
    const done = (async () => {
      try {
        const result = await this.deps.worker!.run({
          project,
          task,
          cwd,
          model,
          reasoning,
          controllerUrl: connection.url,
          token: connection.token,
          dataDir,
          trust,
          allowDependencyDownloads: plan?.allowDependencyDownloads ?? false,
          environmentNeed: plan?.environmentNeed,
          // Frozen tests are enforced where the worker writes, not only at review.
          frozenPaths: task.changesFrozenTests
            ? []
            : frozenTestsIn(plan?.frozenTests).map((test) => test.path),
          signal: controller.signal,
          approvals: this.deps.approvals!,
          getPolicy: async () => ({
            project: await this.requireProject(project.id),
            permissions: await this.deps.store.getPermissions(),
          }),
          reviewAction: this.deps.reviewAction,
          sessionDir: `${projectFiles(this.deps.store.layout.root, project.id).dir}/workers/${task.id}/${project.planRevision}/${attempt.profileId}/${task.workerSessionKey}/sessions`,
          privateHome: `${projectFiles(this.deps.store.layout.root, project.id).dir}/worker-home`,
          lastApprovedRoutingRevision: lastApprovedWorkerRevision(
            task,
            model,
            latestConnection.roles,
          ),
          capabilities,
          onCapacityWait: async (state) => {
            await this.recordCapacityWait(project.id, state);
          },
          onActivity: (text) => this.deps.onActivity?.(text, project.id),
        });
        attempt.status = result.error || controller.signal.aborted ? "failed" : "completed";
        attempt.error =
          result.error ||
          (controller.signal.aborted
            ? "Interactive work interrupted. Review the retained changes before resuming."
            : undefined);

        if (attempt.status !== "completed") {
          attempt.failureClass = classifyAttemptFailure({
            error: attempt.error,
            verificationOutput: result.verification.commands.map((item) => item.output).join("\n"),
            denied: attempt.error?.includes("approval denied"),
            environmentBlocked: attempt.error?.includes("environment_blocked"),
          });
          if (attempt.failureClass === "ambiguous_inference") attempt.status = "uncertain";
        }

        if (controller.signal.aborted && this.stopIntents.has(project.id)) {
          attempt.status = "paused";
          attempt.failureClass = "infrastructure";
        }
        attempt.result = {
          status: attempt.status,
          output: result.output,
          verification: result.verification,
          patches: result.patch
            ? [
                {
                  root: "",
                  baseRevision: "live-folder",
                  patch: result.patch,
                  sha256: sha256Text(result.patch),
                },
              ]
            : [],
          provenance: {
            execution: "interactive",
            changedFiles: result.changedFiles,
            model: model.id,
            harness: "pi",
            harness_version: PI_VERSION,
            ...(result.editGuard ? { editGuard: result.editGuard } : {}),
            ...(result.compactions?.length ? { compactions: result.compactions } : {}),
            ...(result.snapshots?.length ? { snapshots: result.snapshots } : {}),
          },
        };
      } catch (error) {
        attempt.status = "failed";
        attempt.error = error instanceof Error ? error.message : String(error);
        // Poundlock's own reason code when it gave one, rather than reading
        // its prose: an infrastructure event misread as bad work spends a
        // repair round and a slice of the escalation budget.
        attempt.failureClass = classifyAttemptFailure({
          error: attempt.error,
          code: error instanceof PoundlockError ? error.code : undefined,
        });
        if (controller.signal.aborted && this.stopIntents.has(project.id)) {
          attempt.status = "paused";
          attempt.failureClass = "infrastructure";
        }
      } finally {
        attempt.terminalAt = nowIso(this.clock);
        const currentTasks = await this.deps.store.getTasks(project.id);
        const current = currentTasks.find((item) => item.id === task.id);
        const state = await this.requireProject(project.id);
        // The model's slot was taken for longer than the in-stream wait, and
        // the worker never got a turn. That is a wait, not a result: nothing
        // for the manager to review, no repair to spend. Sending it to review
        // cost a manager turn — on a shared machine, a model swap — and then a
        // retry from the task's allowance, for work that never started.
        const neverStarted =
          attempt.status === "failed" &&
          attempt.failureClass === "infrastructure" &&
          /capacity_in_use/i.test(attempt.error ?? "") &&
          !attempt.result?.patches?.length &&
          !this.stopIntents.has(project.id);
        if (
          attempt.error?.includes("approval denied") &&
          !isAttemptTimeLimit(attempt) &&
          state.status !== "cancelled"
        ) {
          this.stopIntents.set(project.id, "paused");
          this.markPaused(
            state,
            "approval_denied",
            "A worker action was declined, so the worker stopped.",
          );
          await this.save(state);
          await this.appendSystem(
            project.id,
            `A worker action for “${task.title}” was declined, so the worker stopped. Its changes so far are kept. Resume to continue, or message the manager to change the approach.`,
          );
        }
        if (isAttemptTimeLimit(attempt) && state.status !== "cancelled") {
          await this.appendSystem(project.id, INTERACTIVE_ATTEMPT_LIMIT_ERROR);
        }
        if (current) {
          const discoveredCommands =
            attempt.result?.verification?.commands.map((item) => item.command).filter(Boolean) ??
            [];
          current.attempts = current.attempts.map((item) => (item.id === id ? attempt : item));
          current.status =
            state.status === "cancelled" ? "cancelled" : neverStarted ? "ready" : "needs_review";
          await this.deps.store.saveTasks(project.id, currentTasks);
          if (!state.policy.verification.commands.length && discoveredCommands.length)
            state.policy.verification.commands = discoveredCommands;
        }
        if (neverStarted && !["paused", "cancelled", "needs_input"].includes(state.status)) {
          state.status = "waiting_for_capacity";
          state.infrastructureIssue = classifyInfrastructureError("capacity_in_use").issue;
          await this.save(state);
        } else if (!["paused", "cancelled", "needs_input"].includes(state.status)) {
          state.status = "reviewing";
          await this.save(state);
        }
        this.folderRuns.delete(cwd);
        this.localRuns.delete(project.id);
        this.deps.onActivity?.("", project.id);
        await this.deps.notify?.();
      }
    })();
    this.localRuns.set(project.id, { controller, done });
  }

  private async prepareApprovedEnvironment(project: ProjectRecord): Promise<boolean> {
    const hostCommands = this.deps.hostCommands;
    if (!hostCommands) {
      // A host that cannot run commands cannot set an environment up. Saying
      // so beats a crash deep in the setup loop.
      project.status = "needs_input";
      project.needsInput = {
        question:
          "This client cannot run commands on this machine, so it cannot prepare the project environment. Use the desktop app for this project, or choose a plan that needs no setup.",
        askedAt: nowIso(this.clock),
      };
      await this.save(project);
      return false;
    }
    const root = projectWorkingRoot(this.deps.store.layout.root, project);
    const plan = await this.deps.store.getPlan(project.id);
    const journal = new ToolJournal(projectFiles(this.deps.store.layout.root, project.id).journal);
    const unresolvedBefore = await journal.unresolved();
    if (unresolvedBefore.some((record) => record.status === "pending")) {
      const unresolved = await journal.reconcileOnStart();
      project.status = "needs_input";
      project.needsInput = {
        question: `A prior local tool action was interrupted and its outcome is unknown (${unresolved.length} action${unresolved.length === 1 ? "" : "s"}). Review the retained project changes, then choose Resume again to acknowledge the recovery notice and continue. Dispatch will not replay the interrupted action automatically.`,
        askedAt: nowIso(this.clock),
        kind: "tool_reconciliation",
      };
      await this.save(project);
      return false;
    }
    if (unresolvedBefore.length) {
      for (const record of unresolvedBefore) {
        await journal.acknowledgeReconciliation(record.eventId);
      }
      project.needsInput = undefined;
    }
    const stateFile = `${projectFiles(this.deps.store.layout.root, project.id).dir}/environment-state.json`;
    const state = {
      read: async () =>
        JSON.parse(await readFile(stateFile, "utf8").catch(() => "null")) ?? undefined,
      write: async (value: import("./environment.js").PreparationState) =>
        writeJsonAtomic(stateFile, value),
    };
    const detected = await selectProjectEnvironment(root, {
      need: plan?.environmentNeed,
      state: await state.read(),
    });
    if (!detected) return true;
    if (detected.blocked || !["python-uv", "python-venv"].includes(detected.kind)) {
      project.environment = environmentRecord(detected, nowIso(this.clock));
      if (detected.blocked) {
        project.status = "needs_input";
        project.needsInput = {
          question: detected.blocked,
          askedAt: nowIso(this.clock),
          kind: "environment",
        };
      }
      await this.save(project);
      return !detected.blocked;
    }
    const trust = effectiveToolTrust(
      project.policy.toolTrust,
      await this.deps.store.getPermissions(),
    );
    const privateHome = `${projectFiles(this.deps.store.layout.root, project.id).dir}/worker-home`;
    const controller = new AbortController();
    this.managerSignals.set(project.id, controller);
    try {
      const prepared = await new PythonUvAdapter().prepare(root, detected, {
        signal: controller.signal,
        allowDownloads: projectReach(project.policy).internet,
        state,
        run: async (input) => {
          try {
            const result = await hostCommands.run(
              {
                program: input.program,
                arguments: input.arguments,
                capability: input.capability,
                effect: input.effect,
                networkMode: input.networkMode,
              },
              {
                projectRoot: root,
                cwd: root,
                extraPath: [],
                runtimeDirs: trustedRuntimeDirectories(project.policy),
                writeRoots: writeRootsFor(project),
                privateHome,
                trust,
                allowDependencyNetwork: plan?.allowDependencyDownloads ?? false,
                reach: projectReach(project.policy),
                sandboxRequest: await hostCommands.buildSandboxRequest({
                  projectRoot: root,
                  project,
                  privateHome,
                  network: input.networkMode,
                  virtualenv: detected.virtualenv,
                }),
                signal: controller.signal,
                journal,
                journalMeta: {
                  workflowId: project.workflowId,
                  planRevision: project.planRevision,
                },
                refreshPolicy: async () => {
                  const currentProject = await this.requireProject(project.id);
                  const currentTrust = effectiveToolTrust(
                    currentProject.policy.toolTrust,
                    await this.deps.store.getPermissions(),
                  );
                  return {
                    trust: currentTrust,
                    allowDependencyNetwork: plan?.allowDependencyDownloads ?? false,
                    reach: projectReach(currentProject.policy),
                    sandboxRequest: await hostCommands.buildSandboxRequest({
                      projectRoot: root,
                      project: currentProject,
                      privateHome,
                      network: input.networkMode,
                      virtualenv: detected.virtualenv,
                    }),
                  };
                },
                authorize: async (command, context) => {
                  const action = hostCommands.approvalAction(command);
                  const permissions = await this.deps.store.getPermissions();
                  if (
                    permissions.grants?.[project.id]?.some(
                      (rule) =>
                        rule.kind === "bash" && rule.cwd === command.cwd && rule.action === action,
                    )
                  ) {
                    return "allow";
                  }
                  if (!context.requireUserApproval) return "allow";
                  if (!this.deps.approvals) return "deny";
                  const allowed = await this.deps.approvals.request(
                    {
                      projectId: project.id,
                      projectName: project.name,
                      planRevision: project.planRevision,
                      kind: "bash",
                      action,
                      reason:
                        context.approvalReason ?? "Approve environment setup for this project.",
                      cwd: command.cwd,
                      ...hostCommands.approvalDisplay(command),
                    },
                    controller.signal,
                  );
                  return allowed ? "allow" : "deny";
                },
              },
            );
            return result.error || result.exitCode !== 0
              ? {
                  error: [
                    result.error ?? `exit ${result.exitCode}`,
                    result.output.trim().slice(-600),
                  ]
                    .filter(Boolean)
                    .join(": "),
                  output: result.output,
                }
              : { output: result.output };
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        },
      });
      project.environment = environmentRecord(prepared, nowIso(this.clock));
      if (prepared.blocked) {
        project.status = "needs_input";
        project.needsInput = {
          question: prepared.blocked,
          askedAt: nowIso(this.clock),
          kind: "environment",
        };
        await this.save(project);
        return false;
      }
      await this.save(project);
      return true;
    } finally {
      this.managerSignals.delete(project.id);
    }
  }

  private async authorizeDestination(
    project: ProjectRecord,
    profile: {
      id: string;
      name?: string;
      aliases?: string[];
      profileId?: string;
      routingRevision?: string;
      routing_revision?: string;
    },
    destination: string,
  ): Promise<boolean> {
    const connection = await this.deps.store.getConnection();
    const name = profile.name ?? profile.id;
    if (destination === "operator_network" || !this.deps.approvals) return true;
    if (
      savedRoleAuthorizesDestination(
        connection.roles,
        catalogProfileForDestination(profile),
        destination,
      )
    )
      return true;
    const text = inferenceApprovalText(name, destination);
    const allowed = await this.deps.approvals.request({
      projectId: project.id,
      projectName: project.name,
      planRevision: project.planRevision,
      kind: "inference",
      action: text.action,
      reason: `${text.reason} ${routeConsequence("interactive")}`,
    });
    if (!allowed) {
      const current = await this.requireProject(project.id);
      if (current.status !== "cancelled")
        this.markPaused(
          current,
          "approval_denied",
          `You declined sending project context to ${name}.`,
        );
      await this.save(current);
    }
    return allowed;
  }

  private async recordCapacityWait(
    projectId: string,
    state: import("./capacity-retry").CapacityWaitState,
  ): Promise<void> {
    const current = await this.requireProject(projectId);
    if (current.status === "cancelled" || this.stopIntents.get(projectId) === "cancelled") return;
    if (state.status === "waiting") {
      if (current.status === "paused" || this.stopIntents.get(projectId) === "paused") return;
      current.status = "waiting_for_capacity";
      current.infrastructureIssue = classifyInfrastructureError("capacity_in_use").issue;
    } else if (
      state.status === "paused" ||
      state.status === "exhausted" ||
      state.status === "route_changed"
    ) {
      this.markPaused(
        current,
        "capacity",
        "The capacity wait ended without resending the request.",
      );
      current.infrastructureIssue = {
        code: "capacity",
        title:
          state.status === "route_changed"
            ? "Profile route changed"
            : state.status === "exhausted"
              ? "Capacity wait exhausted"
              : "Capacity wait paused",
        detail:
          state.status === "route_changed"
            ? "The selected profile UUID, token, destination, or routing revision changed. The rejected request was not resent."
            : state.status === "exhausted"
              ? "The capacity_in_use wait deadline ended. The original request was not resent."
              : "Capacity wait paused. The rejected request was not resent.",
      };
    }
    await this.save(current);
  }

  private async requireProject(id: string): Promise<ProjectRecord> {
    const project = await this.deps.store.getProject(id);
    if (!project) throw new Error("Project not found.");
    return project;
  }

  private markPaused(project: ProjectRecord, cause: PauseCause, detail: string): void {
    project.status = "paused";
    project.pause = { cause, detail, at: nowIso(this.clock) };
  }

  private async save(project: ProjectRecord): Promise<void> {
    const stop = this.stopIntents.get(project.id);
    if (stop) project.status = stop;
    const stored = await this.deps.store.getProject(project.id);
    // Permission is the user's to give and to take back, and only the host
    // ever writes it. A copy read before an approval the user spent minutes
    // over is stale by definition, so taking these from the record rather
    // than the copy is what stops a revoked write root coming back — with the
    // next worker then starting inside it, and nothing said about it.
    if (stored) {
      project.policy = stored.policy;
    }
    if (project.status !== "paused") project.pause = undefined;
    else if (!project.pause) {
      // A stale in-memory copy must not erase the recorded reason, and a pause
      // is never saved without one.
      project.pause = (stored?.status === "paused" && stored.pause) || {
        cause: "awaiting_resume",
        detail: "Work is paused until you resume.",
        at: nowIso(this.clock),
      };
    }
    if (stop === "cancelled")
      project.budget.stopReason =
        "Cancelled by you. No further worker jobs will be submitted for this run.";
    project.updatedAt = nowIso(this.clock);
    await this.deps.store.saveProject(project);
  }

  private async appendSystem(
    projectId: string,
    text: string,
    kind?: ChatMessage["kind"],
  ): Promise<void> {
    await this.appendMessage(projectId, {
      id: newId("msg"),
      role: "system",
      text,
      createdAt: nowIso(this.clock),
      ...(kind ? { kind } : {}),
    });
  }

  private async appendMessage(projectId: string, message: ChatMessage): Promise<void> {
    await this.deps.store.appendMessage(projectId, message);
    await this.deps.notify?.();
  }
}
