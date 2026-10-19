/**
 * Everything a front end does that is not drawing.
 *
 * This is the state assembly, action queue and poll loop that used to live
 * inside the Electron entry point. It was never Electron-specific — it read
 * the store, called the orchestrator and pushed a snapshot — but while it sat
 * in `src/main/index.ts` a second front end could only have reimplemented it,
 * which is exactly the duplication ADR 001 forbids.
 *
 * A host supplies `HostFacilities`: the few things only it can do — where its
 * data lives, how it asks the user to pick a folder or a file, and how it
 * signals that a project needs a decision. Everything else is here, so the
 * Electron main process and a terminal both become thin adapters over one
 * object and cannot drift apart.
 */

import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { grantAccessRoot, rootsForFolderChoice } from "@core/access-roots";
import type { ApprovalBroker } from "@core/approval-broker";
import type { PoundlockCapabilities } from "@core/capabilities";
import { retireDurableWork } from "@core/durable-retirement";
import type { FolderLock, FolderLockHolder } from "@core/folder-lock";
import { assertHttpsGitUrl, forgeHostMatches } from "@core/git";
import {
  type AutopilotFacilities,
  autopilotBusy,
  exportAutopilot,
  mergeAutopilot,
  messageAutopilot,
  previewAutopilotMerge,
  projectAutopilot,
  resumeAutopilot,
  startAutopilot,
  stopAutopilot,
} from "@core/host/autopilot";
import { discoverNodeRuntimes, validateTrustedRuntime } from "@core/host-tools";
import { newId } from "@core/ids";
import type { WorkerPort } from "@core/interactive-worker";
import { GLOBAL_LIVE_WORK, LiveWorkBook } from "@core/live-work";
import { normalizeLocalManager, probeLocalManager } from "@core/local-manager";
import type { ManagerPort, OrchestratorDeps, ProjectOrchestrator } from "@core/orchestration";
import { projectFiles } from "@core/paths";
import { PoundlockClient } from "@core/poundlock";
import type { ProjectLifecycle } from "@core/project-lifecycle";
import { attachProjectForge, createFolderProject, createGitProject } from "@core/projects";
import { recoveryNoticesFromSnapshot } from "@core/recovery-notices";
import { connectionDiscoveryChanged, ServerDiscovery } from "@core/server-discovery";
import { shouldPauseOnDispatchSession } from "@core/session-pause";
import { previewFolder } from "@core/snapshot";
import { snapshotDataUrl } from "@core/snapshots";
import type { FileStore } from "@core/store";
import { projectWorkingRoot } from "@core/workflow-support";
import type { AppearanceSettings } from "@shared/appearance";
import { normalizeAppearance } from "@shared/appearance";
import type { AutopilotMergePreview, AutopilotStartOptions } from "@shared/auto-run";
import { type ContextUsage, compactionLine, compactionSkippedText } from "@shared/compaction";
import { composerSendBlocked } from "@shared/composer-guard";
import type { EscalationSettings } from "@shared/escalation";
import { validateEscalationSettings } from "@shared/escalation";
import { countProjectsNeedingYou } from "@shared/needs-you";
import type { PermissionSettings, ToolApprovalDecision } from "@shared/permissions";
import { effectiveToolTrust, localToolsAutoAllow, normalizePermissions } from "@shared/permissions";
import type { LifecycleActionId } from "@shared/project-status";
import { isReasoningChoice, offeredReasoning, reasoningLabel } from "@shared/reasoning";
import type { RoleMap } from "@shared/roles";
import {
  canonicalRoleMap,
  catalogFromProbe,
  catalogMatchesBinding,
  effectiveDestination,
  guessRoleMap,
  managerChoice,
  roleMapReady,
} from "@shared/roles";
import { autopilotProgressLine } from "@shared/task-view";
import type { TrayRun } from "@shared/tray-view";
import type {
  AccessRoot,
  AppStateView,
  ConnectionSettings,
  ExportOutcome,
  ForgeKind,
  LocalManagerSettings,
  ProfilePreference,
  ProjectActionTarget,
  ProjectPolicy,
  ProjectRecord,
  ProjectSnapshot,
} from "@shared/types";
import { defaultPolicy, EXAMPLE_CONTROLLER_URL } from "@shared/types";
import type { UiPreferences } from "@shared/ui-preferences";
import { normalizeUiPreferences } from "@shared/ui-preferences";

/** The few capabilities only a host has. Every one is optional but `dataRoot`. */
export interface HostFacilities {
  /** Absolute data root. Electron passes `app.getPath("userData")`. */
  dataRoot: string;
  /** Ask the user for a directory. Without it, folder actions must be given a path. */
  chooseFolder?(options: { title?: string; hidden?: boolean }): Promise<string | undefined>;
  /** Ask the user for one exact file, for a read grant. */
  chooseFile?(options: { title: string }): Promise<string | undefined>;
  /** Ask the user where to write an export. */
  chooseSaveTarget?(options: { title: string; defaultName: string }): Promise<string | undefined>;
  /**
   * How many projects are waiting on the user, on every change. `alert` says
   * whether this is new work to interrupt them for; the count itself is a
   * standing figure and must be shown even when it falls, or a badge set once
   * never clears.
   */
  notifyNeedsYou?(count: number, preferences: UiPreferences, alert: boolean): void;
  /** Autopilot (ADR 016): where runs live and how a runner starts. Absent: no Autopilot. */
  autopilot?: AutopilotFacilities;
  /** Open a file Dispatch wrote, such as a run's report, in the owner's default app. */
  openPath?(path: string): Promise<void>;
}

/**
 * The manager provider, described structurally so `src/core` never imports the
 * Pi adapter that implements it.
 */
interface ManagerProviderPort {
  get(project: ProjectRecord, signal?: AbortSignal): Promise<ManagerPort>;
  reset(id: string): Promise<void>;
  abort(id: string): unknown;
  clear(): void;
}

/**
 * Collaborators the host builds for itself, as factories, because each one
 * needs something the host does not have until it exists — the store, the
 * approval broker, or a callback back into the host.
 */
export interface HostDependencies {
  worker(): WorkerPort;
  /** Fences the folder against other Dispatch clients. Omit to run unfenced. */
  folderLock?: FolderLock;
  reviewAction?(store: FileStore): OrchestratorDeps["reviewAction"];
  managerProvider(wiring: {
    getStore: () => FileStore;
    approvals: ApprovalBroker;
    recordActivity: (text: string, projectId?: string) => void;
    onSelection: (selection: AppStateView["managerSelection"]) => void;
    capabilities: () => PoundlockCapabilities | undefined;
  }): ManagerProviderPort;
  orchestrator(deps: OrchestratorDeps): ProjectOrchestrator;
  lifecycle(deps: {
    store: FileStore;
    orchestrator: ProjectOrchestrator;
    approvals: ApprovalBroker;
  }): ProjectLifecycle;
}

const APP_BUSY_KEY = "app";
/**
 * How long streamed manager text may accumulate before the snapshot carries
 * it. Fast enough to read as typing, slow enough that a snapshot build is not
 * paid per token.
 */
const DRAFT_COALESCE_MS = 120;
const POLL_INTERVAL_MS = 2500;
const USAGE_REFRESH_INTERVAL_MS = 15_000;
/** Statuses a poll tick advances. Anything else is waiting on the user. */
const POLLED: readonly string[] = ["running", "waiting_for_capacity", "reviewing", "paused"];

export class DispatchHost {
  private selectedProjectId: string | undefined;
  private activeManager: AppStateView["managerSelection"];
  private notice: AppStateView["notice"];
  private readonly liveWorkBook = new LiveWorkBook();
  private lastNeedingYou = 0;
  private lastUsageRefreshAt = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /** Who holds a project's folder, when this client could not take it. */
  private readonly lockHolders = new Map<string, FolderLockHolder>();
  /** In-flight manager replies, per project. See `AppStateView.managerDraft`. */
  private readonly managerDrafts = new Map<string, string>();
  /** How full each project's manager conversation was when it last answered. */
  private readonly contextUsages = new Map<string, ContextUsage>();
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(state: AppStateView) => void>();
  // One action queue per project (and one for app-wide work), so a manager
  // turn in one project never blocks another project's controls.
  private readonly busyKeys = new Set<string>();
  private readonly busyChains = new Map<string, Promise<void>>();

  readonly discovery: ServerDiscovery;
  readonly folderLock: FolderLock | undefined;
  readonly managerProvider: ManagerProviderPort;
  readonly orchestrator: ProjectOrchestrator;
  readonly lifecycle: ProjectLifecycle;

  constructor(
    readonly facilities: HostFacilities,
    readonly store: FileStore,
    readonly approvals: ApprovalBroker,
    deps: HostDependencies,
  ) {
    this.folderLock = deps.folderLock;
    this.discovery = new ServerDiscovery(
      (connection) => new PoundlockClient(connection.url, connection.token).probe(),
      () => {
        void this.emitState();
      },
      async (connection) =>
        (await new PoundlockClient(connection.url, connection.token).usage()).managed_identities,
    );
    this.managerProvider = deps.managerProvider({
      getStore: () => this.store,
      approvals: this.approvals,
      recordActivity: (text, projectId) => this.recordActivity(text, projectId),
      onSelection: (selection) => {
        this.activeManager = selection;
        void this.emitState();
      },
      capabilities: () => this.discovery.probe?.capabilities as PoundlockCapabilities | undefined,
    });
    this.orchestrator = deps.orchestrator({
      store: this.store,
      clientFor: async () => {
        const connection = await this.store.getConnection();
        if (!connection.url || !connection.token)
          throw new Error("Connect to Poundlock before starting work.");
        return new PoundlockClient(connection.url, connection.token);
      },
      worker: deps.worker(),
      reviewAction: deps.reviewAction?.(this.store),
      approvals: this.approvals,
      manager: {
        reset: (id) => this.managerProvider.reset(id),
        runTurn: async (ctx) =>
          (await this.managerProvider.get(ctx.project, ctx.signal)).runTurn(ctx),
        compact: async (ctx) => {
          const port = await this.managerProvider.get(ctx.project, ctx.signal);
          return port.compact ? port.compact(ctx) : { status: "unsupported" };
        },
        abort: async (id) => {
          await this.managerProvider.abort(id);
        },
      },
      folderLock: this.folderLock,
      notify: () => this.emitState(),
      onActivity: (text, projectId) => {
        this.recordActivity(text || undefined, projectId);
      },
      onManagerDraft: (text, projectId) => {
        this.recordManagerDraft(text, projectId);
      },
      onContextUsage: (usage, projectId) => {
        // No emission: the turn or compaction that reported it notifies when it ends.
        if (usage) this.contextUsages.set(projectId, usage);
        else this.contextUsages.delete(projectId);
      },
      onUsageRefresh: () => this.refreshGatewayUsage(),
    });
    this.lifecycle = deps.lifecycle({
      store: this.store,
      orchestrator: this.orchestrator,
      approvals: this.approvals,
    });
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Finish anything the previous run left half-done, pause what cannot safely
   * continue across a restart, and start the poll loop.
   */
  async start(): Promise<void> {
    await this.lifecycle.completeInterruptedRemovals().catch((error: Error) => {
      this.notice = {
        kind: "error",
        text: `An interrupted project removal could not finish: ${error.message}`,
      };
    });
    // Before recovery, so a project from a version that ran Poundlock jobs is
    // recovered as the interactive project it now is.
    for (const project of await this.store.listProjects()) {
      if (project.removing) continue;
      await retireDurableWork(this.store, project.id).catch((error: Error) => {
        this.notice = {
          kind: "error",
          text: `Could not bring “${project.name}” up to date with Poundlock jobs being manual: ${error.message}`,
        };
      });
    }
    for (const project of await this.store.listProjects()) {
      if (!shouldPauseOnDispatchSession(project)) continue;
      await this.orchestrator.recover(project.id).catch((error: Error) => {
        this.notice = { kind: "error", text: error.message };
      });
    }
    this.pollTimer = setInterval(() => {
      void this.pollActive();
    }, POLL_INTERVAL_MS);
  }

  /**
   * Stop advancing work without tearing the host down. ADR 001: closing a
   * view differs from exiting its host. A closed window on macOS leaves the
   * app running, so shutting down here would pause every project, abort its
   * workers and drop the folder lock — and nothing would undo that when the
   * window came back.
   */
  stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    // A coalesced draft emission outliving the poll loop would rebuild a
    // snapshot for a view that has stopped asking for one.
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
  }

  /** Start polling again after `stopPolling`. Idempotent; never a second timer. */
  resumePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollActive();
    }, POLL_INTERVAL_MS);
  }

  async shutdown(): Promise<void> {
    this.stopPolling();
    await this.orchestrator.shutdown();
    await this.folderLock?.releaseAll();
  }

  private async pollActive(): Promise<void> {
    await this.folderLock?.heartbeat();
    for (const project of await this.store.listProjects()) {
      if (project.removing || this.lifecycle.isPending(project.id)) continue;
      if (!POLLED.includes(project.status)) continue;
      await this.orchestrator.tick(project.id).catch((error: Error) => {
        this.notice = { kind: "error", text: error.message };
      });
    }
    await this.emitState();
    if (Date.now() - this.lastUsageRefreshAt >= USAGE_REFRESH_INTERVAL_MS) {
      this.lastUsageRefreshAt = Date.now();
      void this.refreshGatewayUsage();
    }
  }

  // -------------------------------------------------------------------- state

  private autopilotPhaseCache = new Map<
    string,
    { at: number; phase?: "building" | "interrupted"; progress?: string }
  >();

  /**
   * Which projects Autopilot is building, so the project list does not call
   * them drafts. Read at most every 10 s per project: state is built often.
   */
  private async autopilotPhases(
    projects: ProjectRecord[],
  ): Promise<Record<string, "building" | "interrupted">> {
    const facilities = this.facilities.autopilot;
    if (!facilities) return {};
    const now = Date.now();
    const phases: Record<string, "building" | "interrupted"> = {};
    await Promise.all(
      projects
        .filter((project) => !project.archived)
        .map(async (project) => {
          let cached = this.autopilotPhaseCache.get(project.id);
          if (!cached || now - cached.at > 10_000) {
            const view = await projectAutopilot(facilities, project);
            const phase =
              view?.phase === "preparing" || view?.phase === "running"
                ? "building"
                : view?.phase === "interrupted"
                  ? "interrupted"
                  : undefined;
            cached = {
              at: now,
              ...(phase ? { phase } : {}),
              ...(phase && view
                ? {
                    progress: autopilotProgressLine(
                      view.cases.map((c) => c.stage),
                      "",
                    ),
                  }
                : {}),
            };
            this.autopilotPhaseCache.set(project.id, cached);
          }
          if (cached.phase) phases[project.id] = cached.phase;
        }),
    );
    return phases;
  }

  /** The Autopilot runs building or stopped, for the menu bar while no window is open. */
  async autopilotRuns(): Promise<TrayRun[]> {
    const projects = (await this.store.listProjects()).filter((project) => !project.removing);
    const phases = await this.autopilotPhases(projects);
    return projects
      .filter((project) => phases[project.id])
      .map((project) => {
        const progress = this.autopilotPhaseCache.get(project.id)?.progress;
        return {
          projectId: project.id,
          name: project.name,
          phase: phases[project.id],
          ...(progress ? { progress } : {}),
        };
      });
  }

  onState(listener: (state: AppStateView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getState(): Promise<AppStateView> {
    const projects = (await this.store.listProjects()).filter((project) => !project.removing);
    const projectSnapshot = this.selectedProjectId
      ? await this.snapshot(this.selectedProjectId)
      : undefined;
    const autopilot =
      this.facilities.autopilot && projectSnapshot
        ? await projectAutopilot(this.facilities.autopilot, projectSnapshot.project)
        : undefined;
    const autopilotProjects = await this.autopilotPhases(projects);
    return {
      approvals: this.approvals.list(),
      connection: await this.store.getConnectionPublic(),
      probe: this.discovery.probe,
      managerSelection: this.activeManager,
      discovery: { refreshing: this.discovery.refreshing, updatedAt: this.discovery.updatedAt },
      integrations: await this.store.getIntegrationsPublic(),
      permissions: await this.store.getPermissions(),
      ui: await this.store.getUiPreferences(),
      appearance: await this.store.getAppearance(),
      projects,
      selectedProjectId: this.selectedProjectId,
      snapshot: projectSnapshot,
      busy: this.isBusy(),
      managerTurning: Boolean(
        this.selectedProjectId && this.orchestrator.isManagerTurning(this.selectedProjectId),
      ),
      activity: this.liveWorkBook.view(this.selectedProjectId).activity,
      managerDraft: this.selectedProjectId
        ? this.managerDrafts.get(this.selectedProjectId)
        : undefined,
      contextUsage: this.selectedProjectId
        ? this.contextUsages.get(this.selectedProjectId)
        : undefined,
      ...(autopilot ? { autopilot } : {}),
      ...(Object.keys(autopilotProjects).length ? { autopilotProjects } : {}),
      autopilotAvailable: Boolean(this.facilities.autopilot),
      watching: this.watchingOnly(projectSnapshot?.project),
      liveWork: this.liveWorkBook.view(this.selectedProjectId).liveWork,
      notice: this.notice,
      recovery: recoveryNoticesFromSnapshot(projectSnapshot),
    };
  }

  private async snapshot(projectId: string): Promise<ProjectSnapshot | undefined> {
    const project = await this.store.getProject(projectId);
    if (!project) return undefined;
    const brief = (await this.store.getBrief(projectId)).trim();
    return {
      project,
      plan: await this.store.getPlan(projectId),
      tasks: await this.store.getTasks(projectId),
      pendingBoard: await this.store.getPendingBoard(projectId),
      messages: await this.store.getMessages(projectId),
      ...(brief ? { brief } : {}),
    };
  }

  async emitState(): Promise<void> {
    const state = await this.getState();
    const needing = countProjectsNeedingYou(state.projects, state.approvals ?? []);
    if (needing !== this.lastNeedingYou)
      this.facilities.notifyNeedsYou?.(needing, state.ui, needing > this.lastNeedingYou);
    this.lastNeedingYou = needing;
    for (const listener of this.listeners) listener(state);
  }

  private isBusy(): boolean {
    return (
      this.busyKeys.has(APP_BUSY_KEY) ||
      Boolean(this.selectedProjectId && this.busyKeys.has(this.selectedProjectId))
    );
  }

  private recordActivity(text: string | undefined, projectId?: string): void {
    this.liveWorkBook.record(projectId ?? this.selectedProjectId, text, new Date().toISOString());
    void this.emitState();
  }

  /**
   * Hold the manager's in-flight reply and publish it at a readable rate.
   *
   * Every emission re-reads the store — projects, permissions, the selected
   * project's whole message history — so emitting per token would turn a
   * normal manager turn into thousands of snapshot builds. Growth is therefore
   * coalesced; clearing is not, because a draft left up next to the finished
   * message shows the same text twice.
   */
  private recordManagerDraft(text: string | undefined, projectId: string): void {
    if (text === undefined) {
      if (!this.managerDrafts.delete(projectId)) return;
      if (this.draftTimer) clearTimeout(this.draftTimer);
      this.draftTimer = undefined;
      void this.emitState();
      return;
    }
    this.managerDrafts.set(projectId, text);
    if (this.draftTimer) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = undefined;
      void this.emitState();
    }, DRAFT_COALESCE_MS);
  }

  private async withBusy<T>(work: () => Promise<T>, key: string = APP_BUSY_KEY): Promise<T> {
    const previous = this.busyChains.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.busyChains.set(key, current);
    await previous;
    this.busyKeys.add(key);
    await this.emitState();
    try {
      return await work();
    } finally {
      this.busyKeys.delete(key);
      if (this.busyChains.get(key) === current) this.busyChains.delete(key);
      if (!this.orchestrator.hasBackgroundWork())
        this.liveWorkBook.clearActivity(this.selectedProjectId);
      await this.emitState();
      release();
    }
  }

  /**
   * Bind an action to the project (and optionally the run) the front end chose,
   * captured when the request arrives. A later project switch cannot redirect a
   * queued action, and a replaced run rejects it.
   */
  private actionTarget(target?: Partial<ProjectActionTarget>): ProjectActionTarget {
    const projectId =
      typeof target?.projectId === "string" ? target.projectId : this.selectedProjectId;
    if (!projectId) throw new Error("Open a project first.");
    return {
      projectId,
      workflowId: typeof target?.workflowId === "string" ? target.workflowId : undefined,
    };
  }

  private async boundProject(target: ProjectActionTarget): Promise<string> {
    if (this.lifecycle.isPending(target.projectId))
      throw new Error("Another action for this project is still in progress.");
    return (await this.lifecycle.resolve(target)).id;
  }

  /** Run one bound control, queued behind that project's other actions. */
  private async control(
    target: Partial<ProjectActionTarget> | undefined,
    work: (projectId: string) => Promise<unknown>,
    options?: { busy?: boolean },
  ): Promise<AppStateView> {
    const bound = this.actionTarget(target);
    const act = async () => {
      await work(await this.boundProject(bound));
      return this.getState();
    };
    return options?.busy === false ? act() : this.withBusy(act, bound.projectId);
  }

  private async assertComposerAllowed(
    text: string,
    projectId: string,
    choice?: boolean,
  ): Promise<void> {
    const project = await this.store.getProject(projectId);
    const blocked = composerSendBlocked({
      approvals: this.approvals.list(),
      needsInput: project?.needsInput,
      projectId,
      choiceId: choice ? text : undefined,
    });
    if (blocked) throw new Error(blocked);
  }

  // ---------------------------------------------------------------- decisions

  async decideApproval(id: string, decision: string): Promise<AppStateView> {
    if (!["once", "always", "deny"].includes(decision))
      throw new Error("Unknown approval decision.");
    const request = this.approvals.list().find((item) => item.id === id);
    if (
      decision === "always" &&
      request?.cwd &&
      (request.kind === "bash" || request.kind === "write")
    ) {
      const permissions = await this.store.getPermissions();
      const rules = permissions.grants?.[request.projectId] ?? [];
      await this.store.savePermissions({
        ...permissions,
        grants: {
          ...permissions.grants,
          [request.projectId]: [
            ...rules.filter(
              (rule) =>
                !(
                  rule.kind === request.kind &&
                  rule.action === request.action &&
                  rule.cwd === request.cwd
                ),
            ),
            { kind: request.kind, action: request.action, cwd: request.cwd },
          ],
        },
      });
      this.approvals.decide(id, "once");
    } else this.approvals.decide(id, decision as ToolApprovalDecision);
    if (request)
      await this.store.appendMessage(request.projectId, {
        id: `approval-${request.id}`,
        role: "system",
        createdAt: new Date().toISOString(),
        text: `${
          decision === "deny"
            ? "Denied"
            : decision === "always" && request.cwd
              ? "Allowed and saved as an exact project exception"
              : "Allowed"
        }: ${request.action}`,
      });
    return this.getState();
  }

  replyInput(text: string, target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.control(target, async (projectId) => {
      await this.assertComposerAllowed(text, projectId, true);
      await this.grantRequestedFolder(projectId, text);
      await this.orchestrator.reply(projectId, text);
    });
  }

  // -------------------------------------------------------------- run controls

  sendMessage(text: string, target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    // During a manager turn the message is recorded for its next turn at
    // once, instead of queueing behind the turn's own action for minutes.
    const projectId = target?.projectId ?? this.selectedProjectId;
    const turning = Boolean(projectId && this.orchestrator.isManagerTurning(projectId));
    return this.control(
      target,
      async (projectId) => {
        await this.assertComposerAllowed(text, projectId);
        const project = await this.store.getProject(projectId);
        if (project && (await autopilotBusy(this.facilities.autopilot, project)))
          await messageAutopilot(this.facilities.autopilot!, this.store, project, text);
        else await this.orchestrator.sendMessage(projectId, text);
      },
      { busy: !turning },
    );
  }

  approvePlan(target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.control(target, async (projectId) => {
      await this.assertNoAutopilot(projectId);
      await this.orchestrator.approveAndStart(projectId);
    });
  }

  startRun(target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.control(target, async (projectId) => {
      await this.assertNoAutopilot(projectId);
      await this.orchestrator.start(projectId);
    });
  }

  // ---------------------------------------------------------------- autopilot

  /** Interactive work on a project Autopilot is building would race its runner. */
  private async assertNoAutopilot(projectId: string): Promise<void> {
    const project = await this.store.getProject(projectId);
    if (project && (await autopilotBusy(this.facilities.autopilot, project)))
      throw new Error("Autopilot is building this project. Stop it before working here.");
  }

  private requireAutopilot(): AutopilotFacilities {
    if (!this.facilities.autopilot) throw new Error("Autopilot is not available in this build.");
    return this.facilities.autopilot;
  }

  /**
   * Build the plan with Autopilot: approve it if it is waiting (without
   * starting interactive work), then start an unattended run from the folder.
   */
  autopilotStart(
    options: AutopilotStartOptions,
    target?: Partial<ProjectActionTarget>,
  ): Promise<AppStateView> {
    return this.control(target, async (projectId) => {
      const facilities = this.requireAutopilot();
      // Before the plan is approved: a missing runner must leave nothing changed.
      await facilities.checkRunner();
      const project = (await this.store.getProject(projectId))!;
      if (["running", "waiting_for_capacity", "reviewing"].includes(project.status))
        throw new Error("Pause the interactive run before Autopilot builds this project.");
      const plan = await this.store.getPlan(projectId);
      if (!plan?.approved || (await this.store.getPendingBoard(projectId))) {
        await this.orchestrator.approvePlan(projectId, undefined, true);
        // Approved for Autopilot, not for interactive work: the project is
        // ready rather than waiting on the owner (which counts as needing them).
        const approved = (await this.store.getProject(projectId))!;
        if (approved.status === "awaiting_approval") {
          approved.status = "draft";
          await this.store.saveProject(approved);
        }
      }
      const started = await startAutopilot(
        facilities,
        this.store,
        (await this.store.getProject(projectId))!,
        options,
      );
      await this.store.appendMessage(projectId, {
        id: newId("msg"),
        role: "system",
        text: `Autopilot is building this plan unattended (${started.runId}). It keeps running if you quit Poundlock Dispatch; follow it in the Autopilot panel.`,
        createdAt: new Date().toISOString(),
      });
      this.notice = {
        kind: started.warnings.length ? "error" : "info",
        text: [`Autopilot started ${started.runId}.`, ...started.warnings].join(" "),
      };
    });
  }

  autopilotStop(
    mode: "after_case" | "now",
    target?: Partial<ProjectActionTarget>,
  ): Promise<AppStateView> {
    return this.control(
      target,
      async (projectId) => {
        const project = (await this.store.getProject(projectId))!;
        this.notice = {
          kind: "info",
          text: await stopAutopilot(this.requireAutopilot(), project, mode),
        };
      },
      { busy: false },
    );
  }

  autopilotResume(target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.control(target, async (projectId) => {
      const project = (await this.store.getProject(projectId))!;
      this.notice = {
        kind: "info",
        text: await resumeAutopilot(this.requireAutopilot(), project),
      };
    });
  }

  /** Open the newest run's morning report. */
  async autopilotReport(target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    const projectId = await this.boundProject(this.actionTarget(target));
    const project = (await this.store.getProject(projectId))!;
    const report = (await projectAutopilot(this.requireAutopilot(), project))?.report;
    if (!report) throw new Error("This run has no report yet: it is written when the run ends.");
    if (!this.facilities.openPath) throw new Error(`The report is at ${report}.`);
    await this.facilities.openPath(report);
    return this.getState();
  }

  /** What merging the run's verified work into the folder would bring, checked. */
  async autopilotMergePreview(
    target?: Partial<ProjectActionTarget>,
  ): Promise<AutopilotMergePreview> {
    const projectId = await this.boundProject(this.actionTarget(target));
    const project = (await this.store.getProject(projectId))!;
    return previewAutopilotMerge(this.requireAutopilot(), project);
  }

  /** Fast-forward the folder to the run's verified work, on the owner's word only. */
  autopilotMerge(target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.control(target, async (projectId) => {
      const project = (await this.store.getProject(projectId))!;
      const merged = await mergeAutopilot(this.requireAutopilot(), this.store, project);
      this.notice = {
        kind: "info",
        text: `Merged ${merged.commits} verified ${merged.commits === 1 ? "commit" : "commits"} (${merged.files} ${merged.files === 1 ? "file" : "files"}) into the folder. The work was verified by the checks, not reviewed.`,
      };
    });
  }

  /** Save the run's verified work as a patch; never applied to the folder. */
  async autopilotExport(target?: Partial<ProjectActionTarget>): Promise<ExportOutcome> {
    const projectId = await this.boundProject(this.actionTarget(target));
    const project = (await this.store.getProject(projectId))!;
    const facilities = this.requireAutopilot();
    const view = await projectAutopilot(facilities, project);
    const path = await this.facilities.chooseSaveTarget?.({
      title: "Export Autopilot's verified work as a patch",
      defaultName: `${view?.runId ?? "autopilot"}.patch`,
    });
    let outcome: ExportOutcome;
    if (!path) outcome = { status: "cancelled" };
    else
      try {
        const exported = await exportAutopilot(facilities, project, path);
        outcome = { status: "saved", path: exported.file };
        this.notice = {
          kind: exported.runsHere.length ? "error" : "info",
          text: [
            `Saved ${exported.files} files to ${exported.file}: verified by the checks, not reviewed.`,
            exported.runsHere.length
              ? `Review these before applying; they run on this Mac: ${exported.runsHere.join(", ")}.`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
        };
      } catch (error) {
        outcome = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    if (outcome.status === "cancelled")
      this.notice = { kind: "info", text: "Export cancelled. Nothing was written." };
    if (outcome.status === "failed")
      this.notice = { kind: "error", text: `The patch could not be saved: ${outcome.error}` };
    await this.emitState();
    return outcome;
  }

  pauseRun(target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.control(target, (projectId) => this.orchestrator.pause(projectId), {
      busy: false,
    });
  }

  cancelRun(target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.control(target, (projectId) => this.orchestrator.cancel(projectId), {
      busy: false,
    });
  }

  acceptReviewed(target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.control(target, async (projectId) => {
      await this.assertNoAutopilot(projectId);
      await this.orchestrator.acceptReviewed(projectId);
    });
  }

  reopenRun(target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.control(target, async (projectId) => {
      await this.assertNoAutopilot(projectId);
      await this.orchestrator.reopen(projectId);
    });
  }

  overrideRun(reason: string, target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.control(target, async (projectId) => {
      await this.assertNoAutopilot(projectId);
      await this.orchestrator.override(projectId, String(reason ?? ""));
    });
  }

  retryTask(taskId: string, target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.control(target, async (projectId) => {
      await this.assertNoAutopilot(projectId);
      await this.orchestrator.retryTask(projectId, String(taskId ?? ""));
    });
  }

  /**
   * Summarise the manager's older messages now, with optional instructions to
   * focus the summary. A compaction is written into the conversation; one that
   * had nothing to do is only said, in the notice.
   */
  compactConversation(
    instructions?: string,
    target?: Partial<ProjectActionTarget>,
  ): Promise<AppStateView> {
    return this.control(target, async (projectId) => {
      const outcome = await this.orchestrator.compactConversation(
        projectId,
        typeof instructions === "string" ? instructions : undefined,
      );
      this.notice = {
        kind: "info",
        text:
          outcome.status === "compacted" ? compactionLine(outcome) : compactionSkippedText(outcome),
      };
    });
  }

  async startFresh(target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.runLifecycle("newConversation", this.actionTarget(target));
  }

  async clearCurrentRun(target?: Partial<ProjectActionTarget>): Promise<AppStateView> {
    return this.runLifecycle("newRun", this.actionTarget(target));
  }

  async projectLifecycle(
    action: LifecycleActionId,
    target?: Partial<ProjectActionTarget>,
  ): Promise<AppStateView> {
    if (!["newConversation", "newRun", "archive", "unarchive", "remove"].includes(action))
      throw new Error("Unknown project action.");
    if (!target?.projectId) throw new Error("Choose a project first.");
    return this.runLifecycle(action, this.actionTarget(target));
  }

  private runLifecycle(
    action: LifecycleActionId,
    target: ProjectActionTarget,
  ): Promise<AppStateView> {
    return this.withBusy(async () => {
      const text = await this.lifecycle.run(action, target);
      if (
        (action === "remove" || action === "archive") &&
        this.selectedProjectId === target.projectId
      )
        this.selectedProjectId = undefined;
      this.notice = { kind: "info", text };
      return this.getState();
    }, target.projectId);
  }

  /**
   * A UI snapshot one of the project's attempts kept, as a data URL. The
   * attempt and name are checked against the project's own task records, so
   * a front end cannot name a file to read.
   */
  async attemptSnapshot(
    attemptId: unknown,
    name: unknown,
    target?: Partial<ProjectActionTarget>,
  ): Promise<string> {
    const projectId = target?.projectId ?? this.selectedProjectId;
    if (!projectId || typeof attemptId !== "string" || typeof name !== "string")
      throw new Error("Choose a snapshot of this project.");
    const attempt = (await this.store.getTasks(projectId))
      .flatMap((task) => task.attempts)
      .find((item) => item.id === attemptId);
    const kept = attempt?.result?.provenance?.snapshots;
    if (!Array.isArray(kept) || !kept.includes(name)) throw new Error("That snapshot is not kept.");
    return snapshotDataUrl(
      join(projectFiles(this.store.layout.root, projectId).dir, "attempts", attemptId),
      name,
    );
  }

  async runHistory(target?: Partial<ProjectActionTarget>) {
    const projectId = target?.projectId ?? this.selectedProjectId;
    return projectId ? this.store.getRunHistory(projectId) : [];
  }

  // ----------------------------------------------------------------- projects

  async listProjects(): Promise<ProjectRecord[]> {
    return this.store.listProjects();
  }

  async selectProject(id: string): Promise<AppStateView> {
    this.selectedProjectId = id;
    await this.claimFolder(id);
    return this.getState();
  }

  /**
   * Try to become the writer for this project's folder. Failing is not an
   * error: the front end stays open and readable, and says who is driving.
   * Without a lock, `dispatchReadyOnce` will not start work.
   */
  private async claimFolder(projectId: string): Promise<void> {
    if (!this.folderLock) return;
    const project = await this.store.getProject(projectId);
    if (!project) return;
    const result = await this.folderLock.acquireAll(
      [projectWorkingRoot(this.store.layout.root, project)],
      { projectId, workflowId: project.workflowId },
    );
    // Remembered against the project, not raised as an app-wide notice.
    //
    // This used to set `this.notice`, which is one banner for the whole app and
    // was only ever written on failure — so selecting a folder another client
    // held put an error on screen that then stayed there for every other
    // project the user opened afterwards, none of which were locked. The
    // condition belongs to one project and is not an error: reading is a
    // supported mode, and `dispatchReadyOnce` is what actually withholds work.
    if (result.ok) this.lockHolders.delete(projectId);
    else if (result.holder) this.lockHolders.set(projectId, result.holder);
  }

  /**
   * Whether this client is watching one project rather than driving it.
   *
   * `holds` is synchronous and in-memory, so this costs nothing on a snapshot
   * that is now rebuilt several times a second. The holder's name comes from
   * the last claim attempt rather than a fresh read of the lock file, for the
   * same reason — and `holds` is the authority, so a stale remembered holder
   * can never make a folder this client owns look contended.
   */
  private watchingOnly(project: ProjectRecord | undefined): AppStateView["watching"] {
    if (!this.folderLock || !project) return undefined;
    if (this.folderLock.holds(projectWorkingRoot(this.store.layout.root, project)))
      return undefined;
    const holder = this.lockHolders.get(project.id);
    return { heldBy: holder?.hostApp, pid: holder?.pid };
  }

  async previewFolder(folder: string) {
    return previewFolder(folder);
  }

  async chooseFolder(): Promise<string | undefined> {
    return this.facilities.chooseFolder?.({});
  }

  createProjectFromFolder(payload: {
    folder: string;
    name: string;
    include?: string[];
    extraExclusions?: string[];
    policy?: Partial<ProjectPolicy>;
  }): Promise<AppStateView> {
    return this.withBusy(async () => {
      await this.assertRolesReady();
      const project = await createFolderProject({
        store: this.store,
        folder: payload.folder,
        name: payload.name,
        extraExclusions: payload.extraExclusions,
        policy: { ...defaultPolicy(), ...payload.policy },
      });
      this.selectedProjectId = project.id;
      await this.claimFolder(project.id);
      this.notice = {
        kind: "info",
        text: "Project attached. Poundlock Dispatch will work in that folder. Private manager notes stay in Poundlock Dispatch’s data directory, not the repo.",
      };
      return this.getState();
    });
  }

  createProjectFromGit(payload: {
    repository: string;
    revision: string;
    name?: string;
    forge?: ForgeKind;
  }): Promise<AppStateView> {
    return this.withBusy(async () => {
      await this.assertRolesReady();
      const repository = assertHttpsGitUrl(payload.repository);
      const credentials = await this.credentialsForForge(payload.forge, repository);
      // The new project does not exist yet — never attribute this to whichever
      // other project happens to be selected right now.
      this.recordActivity("Cloning the repository…", GLOBAL_LIVE_WORK);
      await this.emitState();
      const project = await createGitProject({
        store: this.store,
        repository,
        revision: payload.revision,
        name: payload.name,
        forge: payload.forge,
        credentials,
      });
      this.selectedProjectId = project.id;
      this.notice = {
        kind: "info",
        text: payload.forge
          ? "Repository added. Pull requests stay off until you confirm a push."
          : "Repository added. Public clone only. Add GitHub or Gitea in Settings → Integrations to push later.",
      };
      return this.getState();
    });
  }

  private async assertRolesReady(): Promise<void> {
    if (!(await this.store.getConnectionPublic()).rolesReady)
      throw new Error(
        "Finish Connect: map Manager and Interactive to Poundlock profiles, then add a project.",
      );
  }

  /**
   * This conversation's reasoning choice for manager turns; `undefined` goes
   * back to the Manager default. Only a setting the manager's current profile
   * offers can be chosen, and it takes effect from the next turn.
   */
  async setConversationReasoning(
    id: string,
    choice: import("@shared/types").ReasoningChoice | undefined,
  ): Promise<AppStateView> {
    const project = await this.store.getProject(id);
    if (!project) return this.getState();
    if (choice !== undefined && !isReasoningChoice(choice))
      throw new Error("That reasoning setting is not recognised.");
    if (choice !== undefined && this.discovery.probe) {
      const connection = await this.store.getConnection();
      const selected = managerChoice(project, connection.roles);
      const profile = catalogMatchesBinding(catalogFromProbe(this.discovery.probe), {
        profileId: selected.id,
        profileName: selected.fallbackName,
        source: "interactive",
      });
      if (profile && !offeredReasoning(profile).includes(choice))
        throw new Error(
          `Reasoning "${reasoningLabel(choice)}" is not verified for ${profile.name}. It offers: ${offeredReasoning(
            profile,
          )
            .map(reasoningLabel)
            .join(", ")}.`,
        );
    }
    project.reasoningOverride = choice;
    await this.store.saveProject(project);
    return this.getState();
  }

  async updateProjectPolicy(id: string, policy: ProjectPolicy): Promise<AppStateView> {
    let project = await this.store.getProject(id);
    if (!project) return this.getState();
    // Trust and the network switches are read again before every command, so
    // changing them does not pause work (ADR 015).
    const { toolTrust: oldTrust, network: _oldNetwork, ...oldPolicy } = project.policy;
    const { toolTrust: newTrust, network: _newNetwork, ...newPolicy } = policy;
    // Only active work holds a snapshot of the old policy. Pausing an idle
    // draft, proposal or finished run would just strand it as "paused".
    if (
      JSON.stringify(oldPolicy) !== JSON.stringify(newPolicy) &&
      ["planning", "running", "reviewing", "waiting_for_capacity"].includes(project.status)
    ) {
      await this.orchestrator.pause(id);
      project = (await this.store.getProject(id))!;
    }
    // Native file selection is the only way to add read grants; ordinary policy
    // edits may revoke them. Pausing invalidates the current worker's snapshot.
    policy.readGrants = (policy.readGrants ?? []).filter((path) =>
      project.policy.readGrants?.includes(path),
    );
    policy.toolTrustRevision = (project.policy.toolTrustRevision ?? 0) + 1;
    // Trusted runtimes change only through the validated runtime selection,
    // and extra folders only through grantRoot and revokeRoot, which resolve
    // and check each path. A policy sent over IPC never widens them (L23).
    policy.runtimes = project.policy.runtimes;
    policy.roots = project.policy.roots;
    // Project overrides are stored by profile id, and follow the same rule as
    // the app defaults: an external model needs a token that may call external
    // providers, checked when chosen rather than on the first turn.
    const probe = this.discovery.probe;
    if (probe) {
      const connection = await this.store.getConnection();
      const catalog = catalogFromProbe(probe);
      for (const [field, label] of [
        ["managerModel", "manager"],
        ["workerModel", "worker"],
      ] as const) {
        const chosen = policy[field];
        if (!chosen) continue;
        const profile = catalogMatchesBinding(catalog, {
          profileId: chosen,
          profileName: chosen,
          source: "interactive",
        });
        if (!profile) continue;
        policy[field] = profile.profileId ?? profile.id;
        if (
          policy[field] !== project.policy[field] &&
          effectiveDestination(
            profile.dataDestination,
            connection.profiles?.[profile.profileId ?? profile.id]?.approvedDestination,
          ) === "external" &&
          !probe.permissions.includes("external:invoke")
        )
          throw new Error(
            `The current application token cannot use an external ${label}. In Poundlock Access, create a replacement token with Call external providers, save it under Connection, then test again.`,
          );
      }
    }
    if (project.policy.managerModel !== policy.managerModel && this.activeManager?.projectId === id)
      this.activeManager = undefined;
    project.policy = policy;
    await this.store.saveProject(project);
    if (oldTrust !== newTrust) {
      await this.releaseBashCardsNowAutoAllowed(
        await this.store.getPermissions(),
        (projectId) => projectId === id,
      );
    }
    return this.getState();
  }

  /**
   * After a trust-mode change, release the pending shell approvals the new
   * mode auto-allows — and only those.
   *
   * It never denies: not a card the mode has no opinion about (inference
   * consent), and not a shell card the new mode still wants decided.
   * Written twice, once per entry point, it was one edit away from the two
   * disagreeing about what a mode switch releases.
   */
  private async releaseBashCardsNowAutoAllowed(
    permissions: PermissionSettings,
    scope: (projectId: string) => boolean = () => true,
  ): Promise<void> {
    const autoAllowByProject = new Map<string, boolean>();
    for (const view of this.approvals.list()) {
      if (view.kind !== "bash" || !scope(view.projectId)) continue;
      if (autoAllowByProject.has(view.projectId)) continue;
      const project = await this.store.getProject(view.projectId);
      autoAllowByProject.set(
        view.projectId,
        localToolsAutoAllow(effectiveToolTrust(project?.policy.toolTrust, permissions), "bash"),
      );
    }
    this.approvals.recheck((view) =>
      view.kind === "bash" && autoAllowByProject.get(view.projectId) ? true : undefined,
    );
  }

  async runtimeCandidates() {
    return discoverNodeRuntimes();
  }

  async setProjectRuntime(
    id: string,
    kind: string,
    directory?: string | null,
  ): Promise<AppStateView> {
    const project = await this.store.getProject(id);
    if (!project) throw new Error("Project not found.");
    if (kind !== "node") throw new Error("Unknown runtime kind.");
    let selected = directory;
    if (selected === undefined) {
      selected =
        (await this.facilities.chooseFolder?.({
          title:
            "Choose the folder that contains node (for example ~/.nvm/versions/node/v22.0.0/bin)",
          hidden: true,
        })) ?? null;
      if (selected === null) return this.getState();
    }
    const runtimes = { ...project.policy.runtimes };
    if (selected === null || selected === "") delete runtimes.node;
    else
      runtimes.node = await validateTrustedRuntime("node", selected, {
        projectRoot:
          project.source.kind === "local_folder" ? project.source.originalPath : undefined,
        dataRoot: this.store.layout.root,
      });
    await this.orchestrator.pause(id).catch(() => undefined);
    const latest = (await this.store.getProject(id))!;
    latest.policy.runtimes = Object.keys(runtimes).length ? runtimes : undefined;
    await this.store.saveProject(latest);
    this.notice = {
      kind: "info",
      text: runtimes.node
        ? `Workers in this project will use Node from ${runtimes.node}. Active work is paused; resume when ready.`
        : "This project no longer uses a selected Node runtime.",
    };
    return this.getState();
  }

  async attachForge(id: string, forge?: ForgeKind): Promise<AppStateView> {
    const project = await this.store.getProject(id);
    if (!project) return this.getState();
    const kind = forge === "github" || forge === "gitea" ? forge : undefined;
    if (kind) {
      const remote =
        project.source.kind === "git" ? project.source.repository : project.source.gitRemote;
      if (!remote)
        throw new Error(
          "This folder has no git remote. Add one, or add a Git repository project instead.",
        );
      await this.credentialsForForge(kind, remote);
    }
    await this.store.saveProject(await attachProjectForge(project, kind));
    this.notice = {
      kind: "info",
      text: forge
        ? `This project will use the ${forge === "github" ? "GitHub" : "Gitea"} account from Settings.`
        : "Project access is public clone only.",
    };
    return this.getState();
  }

  /**
   * Let this project use another folder, read-only or writable. The manager
   * still cannot write anywhere: only workers do, and only in a write root.
   */
  async grantRoot(
    projectId: string,
    path: string,
    mode: AccessRoot["mode"],
  ): Promise<AppStateView> {
    return this.withBusy(async () => {
      const project = await this.store.getProject(projectId);
      if (!project) throw new Error("Project not found.");
      project.policy.roots = await grantAccessRoot(project, path, mode, {
        projectRoot: projectWorkingRoot(this.store.layout.root, project),
        dataRoot: this.store.layout.root,
      });
      await this.store.saveProject(project);
      this.notice = {
        kind: "info",
        text: `The ${mode === "write" ? "workers may write in" : "manager may read"} ${path}.`,
      };
      return this.getState();
    }, projectId);
  }

  /**
   * Add a folder the owner picked in the native dialog. Like read grants, a
   * folder comes only from the picker, never from a path the renderer sends.
   */
  async grantFolderPicked(projectId: string, mode: AccessRoot["mode"]): Promise<AppStateView> {
    if (mode !== "read" && mode !== "write") throw new Error("Choose read or write.");
    const chosen = await this.facilities.chooseFolder?.({
      title:
        mode === "write"
          ? "Let this project read and change a folder"
          : "Let this project read a folder",
    });
    if (!chosen) return this.getState();
    return this.grantRoot(projectId, chosen, mode);
  }

  /** The owner allowed a folder the manager asked for: save it before the manager hears. */
  private async grantRequestedFolder(projectId: string, choiceId: string): Promise<void> {
    const project = await this.store.getProject(projectId);
    if (!project) return;
    const roots = await rootsForFolderChoice(project, choiceId.trim(), {
      projectRoot: projectWorkingRoot(this.store.layout.root, project),
      dataRoot: this.store.layout.root,
    });
    if (!roots) return;
    project.policy.roots = roots;
    await this.store.saveProject(project);
  }

  async revokeRoot(projectId: string, path: string): Promise<AppStateView> {
    return this.withBusy(async () => {
      const project = await this.store.getProject(projectId);
      if (!project) throw new Error("Project not found.");
      project.policy.roots = (project.policy.roots ?? []).filter((root) => root.path !== path);
      await this.store.saveProject(project);
      this.notice = { kind: "info", text: `No longer using ${path}.` };
      return this.getState();
    }, projectId);
  }

  /** Grant the manager one exact file it would otherwise be refused. */
  async grantReadFile(id: string): Promise<AppStateView> {
    const project = await this.store.getProject(id);
    if (!project) throw new Error("Project not found.");
    const chosen = await this.facilities.chooseFile?.({
      title: "Allow the manager to read this exact excluded file",
    });
    if (chosen) {
      // Grants name the selected target, not a symlink that can later be
      // redirected, matching authorizedReadPath's rule.
      project.policy.readGrants = [
        ...new Set([...(project.policy.readGrants ?? []), await realpath(chosen)]),
      ];
      await this.store.saveProject(project);
    }
    return this.getState();
  }

  // ----------------------------------------------------------------- settings

  async getConnection() {
    const connection = await this.store.getConnection();
    return {
      url: connection.url,
      example: EXAMPLE_CONTROLLER_URL,
      tokenConfigured: Boolean(connection.token),
      roles: connection.roles,
      rolesReady: roleMapReady(connection.roles),
    };
  }

  async saveConnection(settings: ConnectionSettings): Promise<AppStateView> {
    await this.orchestrator.shutdown();
    this.approvals.clear();
    const existing = await this.store.getConnection();
    const changed = settings.url.trim().replace(/\/+$/, "") !== existing.url.replace(/\/+$/, "");
    await this.store.saveConnection({
      url: settings.url.trim(),
      token: settings.token,
      roles: changed ? {} : (settings.roles ?? existing.roles),
      profiles: changed ? {} : existing.profiles,
    });
    this.managerProvider.clear();
    if (connectionDiscoveryChanged(existing, settings)) {
      this.discovery.invalidate();
      void this.refreshServerInfo();
    }
    this.notice = {
      kind: "info",
      text: changed
        ? "New connection saved. Verify its token and choose roles before starting work."
        : "Connection and role map saved on this computer.",
    };
    return this.getState();
  }

  async clearConnection(): Promise<AppStateView> {
    await this.orchestrator.shutdown();
    this.approvals.clear();
    this.managerProvider.clear();
    await this.store.clearConnection();
    this.discovery.invalidate();
    return this.getState();
  }

  testConnection(): Promise<AppStateView> {
    return this.withBusy(async () => {
      const connection = await this.store.getConnection();
      if (!connection.url.trim())
        throw new Error("Enter the Poundlock controller address, then test the connection.");
      if (!connection.token)
        throw new Error(
          "Paste an application token from Poundlock Access, then test the connection.",
        );
      // Not tied to any project — never attribute it to whatever project the
      // user happens to have open in another pane.
      this.recordActivity("Testing the Poundlock connection…", GLOBAL_LIVE_WORK);
      await this.emitState();
      await this.refreshServerInfo();
      const lastProbe = this.discovery.probe;
      const current = await this.store.getConnection();
      if (current.url !== connection.url || current.token !== connection.token)
        return this.getState();
      if (lastProbe?.ok) {
        const latest = await this.store.getConnection();
        if (!roleMapReady(latest.roles))
          await this.store.saveConnection({
            ...latest,
            roles: { ...guessRoleMap(lastProbe), ...latest.roles },
          });
      }
      return this.getState();
    });
  }

  async refreshServerInfo(): Promise<void> {
    await this.discovery.refresh(await this.store.getConnection());
  }

  private async refreshGatewayUsage(): Promise<void> {
    await this.discovery.refreshUsage(await this.store.getConnection());
  }

  async refreshServer(): Promise<AppStateView> {
    await this.refreshServerInfo();
    return this.getState();
  }

  async saveModels(roles: RoleMap): Promise<AppStateView> {
    if (!roleMapReady(roles)) throw new Error("Choose default manager and worker models.");
    await this.orchestrator.shutdown();
    this.approvals.clear();
    this.managerProvider.clear();
    const connection = await this.store.getConnection();
    const catalog = this.discovery.probe ? catalogFromProbe(this.discovery.probe) : [];
    const effectiveCatalog = catalog.map((profile) => ({
      ...profile,
      dataDestination: effectiveDestination(
        profile.dataDestination,
        connection.profiles?.[profile.profileId ?? profile.id]?.approvedDestination,
      ) as typeof profile.dataDestination,
    }));
    // A binding that matches nothing Poundlock serves would be saved,
    // approved, and reported as ready — and fail on the first turn, minutes
    // later, as "no longer advertised". Only checked against a catalog that
    // was actually fetched: offline, there is nothing to check against.
    //
    // Only a binding this save introduces or changes is refused. The terminal
    // rebinds one role at a time, so refusing any stale binding would make a
    // map with two of them impossible to repair: fixing the first would be
    // refused because of the second.
    if (catalog.length) {
      const stale = Object.entries(roles).find(
        ([role, binding]) =>
          binding &&
          binding.profileId !== connection.roles?.[role as keyof RoleMap]?.profileId &&
          !catalogMatchesBinding(effectiveCatalog, binding),
      );
      if (stale)
        throw new Error(
          `The ${stale[0]} model ${stale[1]?.profileName ?? stale[1]?.profileId} is no longer served by Poundlock. Choose another before saving.`,
        );
    }
    for (const [role, binding] of Object.entries(roles)) {
      if (!binding?.reasoning) continue;
      if (!isReasoningChoice(binding.reasoning))
        throw new Error(`The ${role} reasoning setting is not recognised.`);
      const profile = catalog.length ? catalogMatchesBinding(effectiveCatalog, binding) : undefined;
      if (profile && !offeredReasoning(profile).includes(binding.reasoning))
        throw new Error(
          `Reasoning "${reasoningLabel(binding.reasoning)}" is not verified for ${profile.name}. Choose one it offers.`,
        );
    }
    const selectsExternal = Object.values(roles).some(
      (binding) =>
        Boolean(binding) &&
        catalogMatchesBinding(effectiveCatalog, binding)?.dataDestination === "external",
    );
    if (
      selectsExternal &&
      this.discovery.probe &&
      !this.discovery.probe.permissions.includes("external:invoke")
    )
      throw new Error(
        "The current application token cannot use an external default. In Poundlock Access, create a replacement token with Call external providers, save it under Connection, then test again.",
      );
    await this.store.saveConnection({
      ...connection,
      roles: canonicalRoleMap(roles, effectiveCatalog, { approve: true }),
    });
    this.notice = {
      kind: "info",
      text: "Default models and their current destinations saved. Projects using defaults will follow them. Active work is paused; resume when ready.",
    };
    return this.getState();
  }

  async saveProfile(id: string, value: ProfilePreference): Promise<AppStateView> {
    await this.orchestrator.shutdown();
    this.approvals.clear();
    this.managerProvider.clear();
    const connection = await this.store.getConnection();
    // Merged, not replaced: this form edits one field, and anything else saved
    // for the profile must survive it.
    const preference: ProfilePreference = {
      ...connection.profiles?.[id],
      approvedDestination: ["operator_network", "external", "unknown"].includes(
        value.approvedDestination ?? "",
      )
        ? value.approvedDestination
        : undefined,
    };
    await this.store.saveConnection({
      ...connection,
      profiles: { ...connection.profiles, [id]: preference },
    });
    return this.getState();
  }

  async saveEscalation(value: EscalationSettings): Promise<AppStateView> {
    const escalation = validateEscalationSettings(value);
    await this.orchestrator.shutdown();
    this.approvals.clear();
    this.managerProvider.clear();
    const connection = await this.store.getConnection();
    await this.store.saveConnection({ ...connection, escalation });
    this.notice = {
      kind: "info",
      text: "Model ladder settings saved. Active work is paused; resume when ready. Poundlock and LiteLLM remain authoritative for gateway budgets.",
    };
    return this.getState();
  }

  async testLocalManager(settings: LocalManagerSettings) {
    const existing = await this.store.getConnection();
    return probeLocalManager({
      ...settings,
      token: settings.token.trim() || existing.localManager?.token || "",
    });
  }

  async saveLocalManager(settings: LocalManagerSettings): Promise<AppStateView> {
    const existing = await this.store.getConnection();
    const normalized = normalizeLocalManager({
      ...settings,
      token: settings.token.trim() || existing.localManager?.token || "",
    });
    await this.orchestrator.shutdown();
    this.approvals.clear();
    this.managerProvider.clear();
    await this.store.saveConnection({ ...existing, localManager: normalized });
    this.notice = {
      kind: "info",
      text: normalized.enabled
        ? `The Project Manager will use ${normalized.model} on this computer. Workers still use Poundlock.`
        : "The Project Manager will use the default Poundlock model.",
    };
    return this.getState();
  }

  /** Set or clear the SearXNG instance; the manager picks it up at its next session. */
  async saveWebSearch(url: string | null): Promise<AppStateView> {
    await this.store.saveWebSearch(url?.trim() ? { url } : null);
    this.managerProvider.clear();
    this.notice = {
      kind: "info",
      text: url?.trim()
        ? "Search engine saved. Projects with Web search on will use it."
        : "Web search is off: no search engine is set.",
    };
    return this.getState();
  }

  async savePermissions(settings: Partial<PermissionSettings>): Promise<AppStateView> {
    const next = normalizePermissions({ ...(await this.store.getPermissions()), ...settings });
    await this.store.savePermissions(next);
    await this.releaseBashCardsNowAutoAllowed(next);
    this.notice = { kind: "info", text: "Permission default saved on this computer." };
    return this.getState();
  }

  async saveUiPreferences(settings: Partial<UiPreferences>): Promise<AppStateView> {
    const next = normalizeUiPreferences({ ...(await this.store.getUiPreferences()), ...settings });
    await this.store.saveUiPreferences(next);
    this.notice = { kind: "info", text: "Appearance saved on this computer." };
    return this.getState();
  }

  /**
   * The theme choice is machine-wide, like the connection: every Dispatch
   * client reads the same `appearance.json`, so saving it here changes the
   * TUI's colours too, not just this window's.
   */
  async saveAppearance(settings: Partial<AppearanceSettings>): Promise<AppStateView> {
    const next = normalizeAppearance({ ...(await this.store.getAppearance()), ...settings });
    await this.store.saveAppearance(next);
    this.notice = { kind: "info", text: "Theme saved on this computer." };
    return this.getState();
  }

  async saveGithub(payload: {
    host: string;
    username: string;
    token: string;
  }): Promise<AppStateView> {
    await this.store.saveGithub({
      host: normalizeHttpsOrigin(payload.host.trim() || "https://github.com", "GitHub host"),
      username: payload.username,
      token: payload.token,
    });
    this.notice = { kind: "info", text: "GitHub account saved on this computer." };
    return this.getState();
  }

  async saveGitea(payload: {
    host: string;
    username: string;
    token: string;
  }): Promise<AppStateView> {
    await this.store.saveGitea({
      host: normalizeHttpsOrigin(payload.host, "Gitea base URL", true),
      username: payload.username,
      token: payload.token,
    });
    this.notice = { kind: "info", text: "Gitea account saved on this computer." };
    return this.getState();
  }

  async removeForge(kind: ForgeKind): Promise<AppStateView> {
    await this.store.removeForge(kind);
    this.notice = {
      kind: "info",
      text: kind === "github" ? "GitHub account removed." : "Gitea account removed.",
    };
    return this.getState();
  }

  private async credentialsForForge(
    forge: ForgeKind | undefined,
    repository: string,
  ): Promise<{ username: string; token: string } | undefined> {
    if (!forge) return undefined;
    const account = await this.store.getForgeCredentials(forge);
    const label = forge === "github" ? "GitHub" : "Gitea";
    if (!account) throw new Error(`Add a ${label} account in Settings → Integrations first.`);
    if (!forgeHostMatches(repository, account.host))
      throw new Error(
        `This repository host does not match the saved ${label} account (${account.host}).`,
      );
    return { username: account.username, token: account.token };
  }

  /** Surface a message the host itself produced, such as a failed boot step. */
  setNotice(notice: AppStateView["notice"]): void {
    this.notice = notice;
  }
}

function normalizeHttpsOrigin(value: string, label: string, allowHttp = false): string {
  const raw = value.trim();
  if (!raw) throw new Error(`Enter the ${label}.`);
  let parsed: URL;
  try {
    parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error(`${label} must be a URL.`);
  }
  if (parsed.protocol === "https:") return `${parsed.protocol}//${parsed.host}`;
  if (allowHttp && parsed.protocol === "http:") return `${parsed.protocol}//${parsed.host}`;
  throw new Error(`${label} must be HTTPS.`);
}
