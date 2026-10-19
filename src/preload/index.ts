import { contextBridge, ipcRenderer } from "electron";
import { type AppearanceTheme, isAppearanceTheme } from "../shared/appearance";
import { ipcChannels } from "../shared/ipc";
import type { PermissionSettings } from "../shared/permissions";

/**
 * The main process resolves the saved theme before creating the window (see
 * `resolveAppearance` in `src/main/index.ts`) and passes it as an
 * `--pd-appearance-theme=<flavour>` argument on `webPreferences.additionalArguments`.
 * A sandboxed preload script still gets `process.argv`, so this reads
 * synchronously — no round trip — letting the renderer set
 * `document.documentElement.dataset.theme` before its first paint.
 */
function readInitialAppearanceTheme(): AppearanceTheme {
  const flag = process.argv.find((arg) => arg.startsWith("--pd-appearance-theme="));
  const value = flag?.slice("--pd-appearance-theme=".length);
  return isAppearanceTheme(value) ? value : "system";
}

import type {
  AppStateView,
  ConnectionSettings,
  ExportOutcome,
  ForgeKind,
  ProjectActionTarget,
  ProjectPolicy,
} from "../shared/types";

const api = {
  decideApproval: (id: string, decision: import("../shared/permissions").ToolApprovalDecision) =>
    ipcRenderer.invoke(ipcChannels.approvalDecide, id, decision) as Promise<AppStateView>,
  saveEscalation: (settings: import("../shared/escalation").EscalationSettings) =>
    ipcRenderer.invoke(ipcChannels.escalationSave, settings),
  saveProfile: (id: string, preference: import("../shared/types").ProfilePreference) =>
    ipcRenderer.invoke(ipcChannels.profileSave, id, preference) as Promise<AppStateView>,
  grantRead: (id: string) => ipcRenderer.invoke(ipcChannels.grantRead, id) as Promise<AppStateView>,
  grantFolder: (id: string, mode: "read" | "write") =>
    ipcRenderer.invoke(ipcChannels.grantFolder, id, mode) as Promise<AppStateView>,
  revokeFolder: (id: string, path: string) =>
    ipcRenderer.invoke(ipcChannels.revokeFolder, id, path) as Promise<AppStateView>,
  state: () => ipcRenderer.invoke(ipcChannels.state) as Promise<AppStateView>,
  onState: (listener: (state: AppStateView) => void) => {
    const wrapped = (_event: unknown, state: AppStateView) => listener(state);
    ipcRenderer.on(ipcChannels.subscribe, wrapped);
    return () => {
      ipcRenderer.removeListener(ipcChannels.subscribe, wrapped);
    };
  },
  connectionGet: () => ipcRenderer.invoke(ipcChannels.connectionGet),
  connectionSave: (settings: ConnectionSettings) =>
    ipcRenderer.invoke(ipcChannels.connectionSave, settings),
  connectionClear: () => ipcRenderer.invoke(ipcChannels.connectionClear),
  saveLocalManager: (settings: import("../shared/types").LocalManagerSettings) =>
    ipcRenderer.invoke(ipcChannels.localManagerSave, settings) as Promise<AppStateView>,
  saveWebSearch: (url: string | null) =>
    ipcRenderer.invoke(ipcChannels.webSearchSave, url) as Promise<AppStateView>,
  testLocalManager: (settings: import("../shared/types").LocalManagerSettings) =>
    ipcRenderer.invoke(ipcChannels.localManagerTest, settings) as Promise<{
      ok: boolean;
      url: string;
      model: string;
      reportedContextTokens?: number;
      reportedMaxOutputTokens?: number;
    }>,
  refreshServerInfo: () => ipcRenderer.invoke(ipcChannels.serverRefresh) as Promise<AppStateView>,
  saveModels: (roles: import("../shared/roles").RoleMap) =>
    ipcRenderer.invoke(ipcChannels.modelsSave, roles) as Promise<AppStateView>,
  connectionTest: () => ipcRenderer.invoke(ipcChannels.connectionTest),
  chooseFolder: () => ipcRenderer.invoke(ipcChannels.chooseFolder) as Promise<string | undefined>,
  previewFolder: (folder: string) => ipcRenderer.invoke(ipcChannels.projectPreview, folder),
  createFolderProject: (payload: {
    folder: string;
    name: string;
    include?: string[];
    extraExclusions?: string[];
    policy?: Partial<ProjectPolicy>;
  }) => ipcRenderer.invoke(ipcChannels.projectCreateFolder, payload),
  createGitProject: (payload: {
    repository: string;
    revision: string;
    name?: string;
    forge?: ForgeKind;
  }) => ipcRenderer.invoke(ipcChannels.projectCreateGit, payload),
  openProject: (id: string) => ipcRenderer.invoke(ipcChannels.projectOpen, id),
  archiveProject: (id: string, workflowId?: string) =>
    ipcRenderer.invoke(ipcChannels.projectArchive, id, workflowId) as Promise<AppStateView>,
  removeProject: (id: string, workflowId?: string) =>
    ipcRenderer.invoke(ipcChannels.projectRemove, id, workflowId) as Promise<AppStateView>,
  /**
   * Run a guarded lifecycle action bound to a stable project/run identity.
   * Use projectLifecycleActions() from @shared/project-status to decide which
   * actions to show; the main process re-checks the same guard.
   */
  projectLifecycle: (
    action: import("../shared/project-status").LifecycleActionId,
    target: ProjectActionTarget,
  ) => ipcRenderer.invoke(ipcChannels.projectLifecycle, action, target) as Promise<AppStateView>,
  updatePolicy: (id: string, policy: ProjectPolicy) =>
    ipcRenderer.invoke(ipcChannels.projectUpdatePolicy, id, policy),
  /** This conversation's manager reasoning; `undefined` returns to the Manager default. */
  setConversationReasoning: (
    id: string,
    choice: import("../shared/types").ReasoningChoice | undefined,
  ) => ipcRenderer.invoke(ipcChannels.projectSetReasoning, id, choice) as Promise<AppStateView>,
  attachForge: (id: string, forge?: ForgeKind) =>
    ipcRenderer.invoke(ipcChannels.projectAttachForge, id, forge),
  /** NVM-installed Node runtimes found on this Mac, newest first. */
  runtimeCandidates: () =>
    ipcRenderer.invoke(ipcChannels.runtimeCandidates) as Promise<
      import("../shared/types").RuntimeCandidate[]
    >,
  /**
   * Select (or clear with null) a trusted runtime directory for one project.
   * Omit `directory` to choose one with a native folder dialog.
   */
  setProjectRuntime: (id: string, kind: "node", directory?: string | null) =>
    ipcRenderer.invoke(ipcChannels.projectSetRuntime, id, kind, directory) as Promise<AppStateView>,
  saveGithub: (payload: { host: string; username: string; token: string }) =>
    ipcRenderer.invoke(ipcChannels.saveGithub, payload),
  saveGitea: (payload: { host: string; username: string; token: string }) =>
    ipcRenderer.invoke(ipcChannels.saveGitea, payload),
  removeForge: (kind: ForgeKind) => ipcRenderer.invoke(ipcChannels.removeForge, kind),
  savePermissions: (settings: PermissionSettings) =>
    ipcRenderer.invoke(ipcChannels.permissionsSave, settings),
  saveUiPreferences: (settings: import("../shared/ui-preferences").UiPreferences) =>
    ipcRenderer.invoke(ipcChannels.uiSave, settings) as Promise<AppStateView>,
  saveAppearance: (settings: import("../shared/appearance").AppearanceSettings) =>
    ipcRenderer.invoke(ipcChannels.appearanceSave, settings) as Promise<AppStateView>,
  /** The flavour resolved before this window was created; see `readInitialAppearanceTheme`. */
  initialAppearanceTheme: readInitialAppearanceTheme(),
  // Run controls take an optional target captured by the renderer. Without one,
  // the main process binds to the project selected when the request arrives.
  sendMessage: (text: string, target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.sendMessage, text, target) as Promise<AppStateView>,
  approvePlan: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.approvePlan, target) as Promise<AppStateView>,
  startRun: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.startRun, target) as Promise<AppStateView>,
  pauseRun: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.pauseRun, target) as Promise<AppStateView>,
  cancelRun: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.cancelRun, target) as Promise<AppStateView>,
  replyInput: (text: string, target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.replyInput, text, target) as Promise<AppStateView>,
  startFresh: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.startFresh, target) as Promise<AppStateView>,
  clearCurrentRun: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.clearCurrentRun, target) as Promise<AppStateView>,
  /** Summarise the manager's older messages now; optional instructions focus the summary. */
  compactConversation: (instructions?: string, target?: ProjectActionTarget) =>
    ipcRenderer.invoke(
      ipcChannels.compactConversation,
      instructions,
      target,
    ) as Promise<AppStateView>,
  acceptReviewed: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.acceptReviewed, target) as Promise<AppStateView>,
  reopenRun: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.reopenRun, target) as Promise<AppStateView>,
  overrideRun: (reason: string, target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.overrideRun, reason, target) as Promise<AppStateView>,
  retryTask: (taskId: string, target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.retryTask, taskId, target) as Promise<AppStateView>,
  /** A UI snapshot an attempt's tests wrote, as a data URL. */
  attemptSnapshot: (attemptId: string, name: string, target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.attemptSnapshot, attemptId, name, target) as Promise<string>,
  runHistory: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.runHistory, target) as Promise<
      import("../shared/types").RunHistoryRecord[]
    >,
  autopilotStart: (
    options: import("../shared/auto-run").AutopilotStartOptions,
    target?: ProjectActionTarget,
  ) => ipcRenderer.invoke(ipcChannels.autopilotStart, options, target) as Promise<AppStateView>,
  autopilotStop: (mode: "after_case" | "now", target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.autopilotStop, mode, target) as Promise<AppStateView>,
  autopilotResume: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.autopilotResume, target) as Promise<AppStateView>,
  autopilotExport: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.autopilotExport, target) as Promise<ExportOutcome>,
  autopilotMergePreview: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.autopilotMergePreview, target) as Promise<
      import("../shared/auto-run").AutopilotMergePreview
    >,
  autopilotMerge: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.autopilotMerge, target) as Promise<AppStateView>,
  autopilotReport: (target?: ProjectActionTarget) =>
    ipcRenderer.invoke(ipcChannels.autopilotReport, target) as Promise<AppStateView>,
};

contextBridge.exposeInMainWorld("poundlockDispatch", api);

export type DispatchApi = typeof api;
