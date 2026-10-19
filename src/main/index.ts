/**
 * The Electron adapter. It owns the application lifecycle, the window, and the
 * trusted IPC boundary — nothing else. Every action and all state assembly
 * lives in `DispatchHost` so a second front end runs the same code rather than
 * a second copy of it.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import { migrateLegacyData } from "@core/brand-migration";
import { migrateSharedConfig } from "@core/config-migration";
import { exists } from "@core/file-access";
import { FolderLock } from "@core/folder-lock";
import { DispatchHost, type HostFacilities } from "@core/host/dispatch-host";
import { ProjectOrchestrator } from "@core/orchestration";
import { defaultConfigRoot } from "@core/paths";
import { ProjectLifecycle } from "@core/project-lifecycle";
import { FileStore } from "@core/store";
import { createApprovalReviewer } from "@runtime/approval-reviewer";
import { hostCommandPort } from "@runtime/host-command";
import { createManagerProvider } from "@runtime/manager-provider";
import { createPiWorker } from "@runtime/pi-worker";
import { configureSystemCertificateAuthorities } from "@runtime/system-ca";
import { type AppearanceTheme, DEFAULT_APPEARANCE } from "@shared/appearance";
import { type IpcChannel, ipcChannels } from "@shared/ipc";
// Vendored from Poundlock (see scripts/sync-theme.sh) — the hex roles resolved
// per flavour, used here only to pick a matching window backgroundColor
// before the page paints.
import themeRoles from "@shared/theme.json";
import { trayView } from "@shared/tray-view";
import { APP_NAME } from "@shared/types";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  session,
  shell,
  Tray,
} from "electron";
import { autopilotFacilities } from "./autopilot-runner";
import { denyPermissionRequests } from "./permissions";

process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";
configureSystemCertificateAuthorities();

// Legacy launch flags remain accepted during the branding migration.
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("LOCKKEEP_"))
    process.env[key.replace("LOCKKEEP_", "POUNDLOCK_DISPATCH_")] ??= value;
}
app.setName(APP_NAME);
const dispatchData =
  process.env.POUNDLOCK_DISPATCH_DATA_DIR || join(app.getPath("appData"), APP_NAME);
if (!process.env.POUNDLOCK_DISPATCH_DATA_DIR) {
  migrateLegacyData(join(app.getPath("appData"), "Lockkeep"), dispatchData);
}
app.setPath("userData", dispatchData);

let mainWindow: BrowserWindow | undefined;
let host: DispatchHost | undefined;
let startupDiscovery: Promise<void> | undefined;

export function dataRoot(): string {
  return process.env.POUNDLOCK_DISPATCH_DATA_DIR || app.getPath("userData");
}

const facilities: HostFacilities = {
  dataRoot: dataRoot(),
  chooseFolder: async ({ title, hidden }) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title,
      properties: hidden ? ["openDirectory", "showHiddenFiles"] : ["openDirectory"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  },
  chooseFile: async ({ title }) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title,
      properties: ["openFile", "showHiddenFiles"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  },
  chooseSaveTarget: async ({ title, defaultName }) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title,
      defaultPath: join(app.getPath("downloads"), defaultName),
      filters: [{ name: "Patch", extensions: ["patch", "diff"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    return result.canceled ? undefined : result.filePath;
  },
  autopilot: autopilotFacilities(app.getVersion()),
  openPath: async (path) => {
    const failed = await shell.openPath(path);
    if (failed) throw new Error(failed);
  },
  notifyNeedsYou: (count, preferences, alert) => {
    if (alert && preferences.desktopNotifications && Notification.isSupported())
      new Notification({
        title: "Poundlock Dispatch",
        body: "A project needs your decision.",
      }).show();
    app.dock?.setBadge(count > 0 ? String(count) : "");
  },
};

async function boot(): Promise<void> {
  // The desktop app shares this machine's Poundlock connection, role map and
  // default trust mode with every other Dispatch client; its projects stay its
  // own.
  const store = new FileStore(dataRoot(), defaultConfigRoot());
  await store.init();
  migrateSharedConfig(store.layout);
  const approvals = new ApprovalBroker(() => {
    void host?.emitState();
  });
  host = new DispatchHost(facilities, store, approvals, {
    worker: () => createPiWorker(),
    // One writer per folder across clients: the desktop app and a terminal
    // session must not dispatch workers into the same tree at once.
    folderLock: new FolderLock(join(defaultConfigRoot(), "locks"), {
      hostApp: "gui",
      dataRoot: dataRoot(),
    }),
    reviewAction: (created) => createApprovalReviewer(created),
    managerProvider: (wiring) =>
      createManagerProvider(
        wiring.getStore,
        wiring.approvals,
        async (text, projectId) => {
          wiring.recordActivity(text, projectId);
        },
        wiring.onSelection,
        wiring.capabilities,
      ),
    orchestrator: (deps) => new ProjectOrchestrator({ ...deps, hostCommands: hostCommandPort }),
    lifecycle: (deps) => new ProjectLifecycle(deps),
  });
  let lastAppearanceTheme: AppearanceTheme | undefined;
  host.onState((state) => {
    mainWindow?.webContents.send(ipcChannels.subscribe, state);
    void refreshTray();
    // Live-switch: keep the window's own background in step with a theme
    // changed from Settings, so a resize or a new window doesn't flash the
    // old flavour before the page repaints.
    if (state.appearance.theme !== lastAppearanceTheme) {
      lastAppearanceTheme = state.appearance.theme;
      const flavour =
        state.appearance.theme === "system" ? resolveSystemFlavour() : state.appearance.theme;
      mainWindow?.setBackgroundColor(themeRoles.flavours[flavour].roles.canvas);
    }
  });
  await host.start();
  // The renderer already follows the OS scheme through theme.css's
  // prefers-color-scheme block; this just keeps the native window background
  // from lagging behind when appearance is "system" and macOS switches.
  nativeTheme.on("updated", () => {
    if (lastAppearanceTheme !== "system" && lastAppearanceTheme !== undefined) return;
    mainWindow?.setBackgroundColor(themeRoles.flavours[resolveSystemFlavour()].roles.canvas);
  });
}

let tray: Tray | undefined;
let trayRefreshing = false;

function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "tray", "trayTemplate.png")
    : join(app.getAppPath(), "assets", "tray", "trayTemplate.png");
}

/**
 * The menu bar icon. Autopilot runs keep building in their own processes
 * after the window closes, so the app stays in the menu bar and says what is
 * running, as the owner's photo importer does; quitting is explicit.
 */
function createTray(): void {
  const image = nativeImage.createFromPath(trayIconPath());
  if (image.isEmpty()) return;
  image.setTemplateImage(true);
  tray = new Tray(image);
  void refreshTray();
  setInterval(() => void refreshTray(), 15_000).unref();
}

async function refreshTray(): Promise<void> {
  if (!tray || !host || trayRefreshing) return;
  trayRefreshing = true;
  try {
    const view = trayView(await host.autopilotRuns());
    tray.setToolTip(view.tooltip);
    tray.setTitle(view.title);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Autopilot", enabled: false },
        ...(view.runs.length
          ? view.runs.map((run) => ({
              label: run.label,
              click: () => void showProject(run.projectId),
            }))
          : [{ label: "Nothing building", enabled: false }]),
        { type: "separator" },
        { label: "Show Poundlock Dispatch", click: () => void showWindow() },
        { label: "Quit Poundlock Dispatch", click: () => app.quit() },
      ]),
    );
  } catch {
    // The next refresh tries again; the menu keeps what it last showed.
  } finally {
    trayRefreshing = false;
  }
}

async function showWindow(): Promise<void> {
  app.dock?.show();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  await createWindow();
  host?.resumePolling();
  void host?.refreshServerInfo();
}

async function showProject(id: string): Promise<void> {
  await showWindow();
  await host?.selectProject(id);
}

function revealWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    mainWindow.show();
  }
}

function resolvePreloadPath(): string {
  const bundled = join(__dirname, "../preload/index.cjs");
  const unpacked = bundled.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
  if (unpacked !== bundled && existsSync(unpacked)) return unpacked;
  return bundled;
}

function fail(text: string): void {
  host?.setNotice({ kind: "error", text });
}

/** "system" resolves through nativeTheme, the same rule the TUI uses when `COLORFGBG` is absent. */
function resolveSystemFlavour(): "mocha" | "latte" {
  return nativeTheme.shouldUseDarkColors ? "mocha" : "latte";
}

/**
 * Reads the saved theme before the window exists, so the very first paint —
 * the window's own background and the page's first frame — is already
 * themed instead of flashing the old dark default and then switching.
 */
async function resolveAppearance(): Promise<{ theme: AppearanceTheme; canvas: string }> {
  const appearance = (await host?.store.getAppearance()) ?? DEFAULT_APPEARANCE;
  const flavour = appearance.theme === "system" ? resolveSystemFlavour() : appearance.theme;
  return { theme: appearance.theme, canvas: themeRoles.flavours[flavour].roles.canvas };
}

async function createWindow(): Promise<void> {
  const preloadPath = resolvePreloadPath();
  if (!existsSync(preloadPath)) {
    fail(`Missing desktop bridge at ${preloadPath}. Rebuild with npm run package:dir.`);
  }
  const appearance = await resolveAppearance();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: "Poundlock Dispatch",
    backgroundColor: appearance.canvas,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--pd-appearance-theme=${appearance.theme}`],
    },
  });
  let smokeWritten = false;
  const writeSmoke = async (payload: Record<string, unknown>): Promise<void> => {
    if (process.env.POUNDLOCK_DISPATCH_SMOKE !== "1" || smokeWritten) return;
    smokeWritten = true;
    await mkdir(dataRoot(), { recursive: true });
    await writeFile(join(dataRoot(), "smoke.json"), `${JSON.stringify(payload, null, 2)}\n`);
    app.quit();
  };
  mainWindow.once("ready-to-show", () => revealWindow());
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    const text = `The window failed to load (${code}): ${description} (${url}).`;
    fail(text);
    revealWindow();
    void writeSmoke({ ok: false, error: text, preloadPath });
  });
  mainWindow.webContents.on("preload-error", (_event, path, error) => {
    const text = `Desktop bridge failed (${path}): ${error.message}`;
    fail(text);
    void writeSmoke({ ok: false, error: text, preloadPath });
  });
  mainWindow.webContents.once("did-finish-load", () => {
    void (async () => {
      if (process.env.POUNDLOCK_DISPATCH_SMOKE === "1") {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      const hasApi = await mainWindow?.webContents
        .executeJavaScript("Boolean(window.poundlockDispatch)")
        .catch(() => false);
      if (!hasApi) {
        fail(
          "Poundlock Dispatch could not start its desktop bridge. The preload script did not load.",
        );
        await mainWindow?.webContents.executeJavaScript(
          `document.documentElement.style.cssText='background:#1d1f27;color:#e6e8e9;font:15px system-ui,sans-serif';document.body.textContent=${JSON.stringify(
            "Poundlock Dispatch could not start its desktop bridge. Quit the app and rebuild with npm run package:dir. The packaged preload must be CommonJS.",
          )};`,
        );
      }
      revealWindow();
      const text = await mainWindow?.webContents
        .executeJavaScript("document.body.innerText")
        .catch(() => "");
      let startupProbeOk: boolean | undefined;
      let roleSaveKeptCatalog: boolean | undefined;
      if (process.env.POUNDLOCK_DISPATCH_SMOKE_REFRESH === "1") {
        if (!startupDiscovery) throw new Error("Startup discovery was not scheduled.");
        await startupDiscovery;
        startupProbeOk = Boolean(
          host?.discovery.probe?.ok && host.discovery.probe.interactiveModels.length,
        );
        roleSaveKeptCatalog = await mainWindow?.webContents.executeJavaScript(`(async () => {
          const before = await window.poundlockDispatch.state();
          const model = before.probe.interactiveModels[0];
          const roles = {manager: {profileId:model.id,profileName:model.name,source:'interactive'},interactive: {profileId:model.id,profileName:model.name,source:'interactive'}};
          const after = await window.poundlockDispatch.saveModels(roles);
          return JSON.stringify(before.probe) === JSON.stringify(after.probe);
        })()`);
      }
      let probeOk = true;
      if (process.env.POUNDLOCK_DISPATCH_SMOKE_PROBE === "1") {
        const state = await mainWindow?.webContents.executeJavaScript(
          "window.poundlockDispatch.connectionTest()",
        );
        probeOk = Boolean(state?.probe?.ok);
      }
      let localManagerOk: boolean | undefined;
      if (process.env.POUNDLOCK_DISPATCH_SMOKE_LOCAL_MANAGER === "1") {
        localManagerOk = await mainWindow?.webContents.executeJavaScript(`(async () => {
          const before = await window.poundlockDispatch.state();
          const settings = {
            enabled: true,
            url: before.connection.url,
            token: 'synthetic-smoke-token',
            model: 'fixture-interactive',
            contextTokens: 32768,
            maxOutputTokens: 4096
          };
          const tested = await window.poundlockDispatch.testLocalManager(settings);
          const saved = await window.poundlockDispatch.saveLocalManager(settings);
          return tested.ok === true &&
            saved.connection.localManager.enabled === true &&
            saved.connection.localManager.tokenConfigured === true &&
            !('token' in saved.connection.localManager);
        })()`);
      }
      await writeSmoke({
        ok:
          Boolean(hasApi) &&
          Boolean(text?.includes("Poundlock Dispatch")) &&
          probeOk &&
          localManagerOk !== false,
        probeOk,
        startupProbeOk,
        roleSaveKeptCatalog,
        localManagerOk,
        hasApi: Boolean(hasApi),
        text,
        preloadPath,
      });
    })();
  });
  setTimeout(() => revealWindow(), 4000);
  if (process.env.POUNDLOCK_DISPATCH_SMOKE === "1") {
    setTimeout(() => {
      void writeSmoke({
        ok: false,
        error: "Timed out waiting for the window to load.",
        preloadPath,
      });
    }, 20_000);
  }
  if (process.env.POUNDLOCK_DISPATCH_DEBUG === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function handleTrusted(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (
      !mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error("Untrusted desktop request.");
    }
    return listener(event, ...args);
  });
}

/**
 * Every request channel, bound to the host method that serves it. Written as an
 * exhaustive record so a host method cannot gain a front end without the other
 * noticing: omit a channel and this stops compiling. `subscribe` is push-only
 * and has no handler.
 */
type RequestChannel = Exclude<IpcChannel, typeof ipcChannels.subscribe>;

function routes(target: DispatchHost): Record<RequestChannel, (...args: any[]) => unknown> {
  return {
    [ipcChannels.state]: () => target.getState(),
    [ipcChannels.approvalDecide]: (id, decision) => target.decideApproval(id, decision),
    [ipcChannels.profileSave]: (id, value) => target.saveProfile(id, value),
    [ipcChannels.escalationSave]: (value) => target.saveEscalation(value),
    [ipcChannels.grantRead]: (id) => target.grantReadFile(id),
    [ipcChannels.grantFolder]: (id, mode) => target.grantFolderPicked(id, mode),
    [ipcChannels.revokeFolder]: (id, path) => target.revokeRoot(id, path),
    [ipcChannels.connectionGet]: () => target.getConnection(),
    [ipcChannels.connectionSave]: (settings) => target.saveConnection(settings),
    [ipcChannels.connectionClear]: () => target.clearConnection(),
    [ipcChannels.connectionTest]: () => target.testConnection(),
    [ipcChannels.modelsSave]: (roles) => target.saveModels(roles),
    [ipcChannels.serverRefresh]: () => target.refreshServer(),
    [ipcChannels.localManagerSave]: (settings) => target.saveLocalManager(settings),
    [ipcChannels.localManagerTest]: (settings) => target.testLocalManager(settings),
    [ipcChannels.webSearchSave]: (url) => target.saveWebSearch(url),
    [ipcChannels.projectPreview]: (folder) => target.previewFolder(folder),
    [ipcChannels.projectCreateFolder]: (payload) => target.createProjectFromFolder(payload),
    [ipcChannels.projectCreateGit]: (payload) => target.createProjectFromGit(payload),
    [ipcChannels.projectOpen]: (id) => target.selectProject(id),
    [ipcChannels.projectArchive]: (id, workflowId) =>
      target.projectLifecycle("archive", { projectId: id, workflowId }),
    [ipcChannels.projectRemove]: (id, workflowId) =>
      target.projectLifecycle("remove", { projectId: id, workflowId }),
    [ipcChannels.projectLifecycle]: (action, targetRef) =>
      target.projectLifecycle(action, targetRef),
    [ipcChannels.projectUpdatePolicy]: (id, policy) => target.updateProjectPolicy(id, policy),
    [ipcChannels.projectSetReasoning]: (id, choice) => target.setConversationReasoning(id, choice),
    [ipcChannels.projectAttachForge]: (id, forge) => target.attachForge(id, forge),
    [ipcChannels.runtimeCandidates]: () => target.runtimeCandidates(),
    [ipcChannels.projectSetRuntime]: (id, kind, directory) =>
      target.setProjectRuntime(id, kind, directory),
    [ipcChannels.saveGithub]: (payload) => target.saveGithub(payload),
    [ipcChannels.saveGitea]: (payload) => target.saveGitea(payload),
    [ipcChannels.removeForge]: (kind) => target.removeForge(kind),
    [ipcChannels.permissionsSave]: (settings) => target.savePermissions(settings),
    [ipcChannels.uiSave]: (settings) => target.saveUiPreferences(settings),
    [ipcChannels.appearanceSave]: (settings) => target.saveAppearance(settings),
    [ipcChannels.sendMessage]: (text, targetRef) => target.sendMessage(text, targetRef),
    [ipcChannels.replyInput]: (text, targetRef) => target.replyInput(text, targetRef),
    [ipcChannels.approvePlan]: (targetRef) => target.approvePlan(targetRef),
    [ipcChannels.startRun]: (targetRef) => target.startRun(targetRef),
    [ipcChannels.pauseRun]: (targetRef) => target.pauseRun(targetRef),
    [ipcChannels.cancelRun]: (targetRef) => target.cancelRun(targetRef),
    [ipcChannels.acceptReviewed]: (targetRef) => target.acceptReviewed(targetRef),
    [ipcChannels.reopenRun]: (targetRef) => target.reopenRun(targetRef),
    [ipcChannels.overrideRun]: (reason, targetRef) => target.overrideRun(reason, targetRef),
    [ipcChannels.retryTask]: (taskId, targetRef) => target.retryTask(taskId, targetRef),
    [ipcChannels.startFresh]: (targetRef) => target.startFresh(targetRef),
    [ipcChannels.clearCurrentRun]: (targetRef) => target.clearCurrentRun(targetRef),
    [ipcChannels.compactConversation]: (instructions, targetRef) =>
      target.compactConversation(instructions, targetRef),
    [ipcChannels.runHistory]: (targetRef) => target.runHistory(targetRef),
    [ipcChannels.attemptSnapshot]: (attemptId, name, targetRef) =>
      target.attemptSnapshot(attemptId, name, targetRef),
    [ipcChannels.autopilotStart]: (options, targetRef) => target.autopilotStart(options, targetRef),
    [ipcChannels.autopilotStop]: (mode, targetRef) => target.autopilotStop(mode, targetRef),
    [ipcChannels.autopilotResume]: (targetRef) => target.autopilotResume(targetRef),
    [ipcChannels.autopilotExport]: (targetRef) => target.autopilotExport(targetRef),
    [ipcChannels.autopilotMergePreview]: (targetRef) => target.autopilotMergePreview(targetRef),
    [ipcChannels.autopilotMerge]: (targetRef) => target.autopilotMerge(targetRef),
    [ipcChannels.autopilotReport]: (targetRef) => target.autopilotReport(targetRef),
    [ipcChannels.chooseFolder]: () => target.chooseFolder(),
  };
}

function registerIpc(): void {
  if (!host) throw new Error("The workflow host did not start.");
  for (const [channel, handler] of Object.entries(routes(host)))
    handleTrusted(channel, (_event, ...args: any[]) => handler(...args));
}

app.whenReady().then(async () => {
  // The packaged helper, when there is one. Without it (a development build)
  // each clone writes its own into a private folder; the current folder is
  // never searched for one.
  const packagedAskPass = process.resourcesPath
    ? join(process.resourcesPath, "git-askpass.sh")
    : undefined;
  if (
    !process.env.POUNDLOCK_DISPATCH_GIT_ASKPASS &&
    packagedAskPass &&
    (await exists(packagedAskPass))
  )
    process.env.POUNDLOCK_DISPATCH_GIT_ASKPASS = packagedAskPass;
  denyPermissionRequests(session.defaultSession);
  try {
    await boot();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (host) fail(text);
    else {
      // Boot failed before the host existed; bring up enough of it to show why.
      const store = new FileStore(dataRoot(), defaultConfigRoot());
      await store.init().catch(() => undefined);
    }
  }
  try {
    registerIpc();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  void createWindow();
  createTray();
  startupDiscovery = host?.refreshServerInfo();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      app.dock?.show();
      void createWindow();
      host?.resumePolling();
      void host?.refreshServerInfo();
    }
  });
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting || !host) return;
  event.preventDefault();
  quitting = true;
  void host.shutdown().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  // Closing the last window is not quitting: on macOS the app stays running
  // and `activate` reopens it. Shutting the host down here would pause every
  // project, abort its workers and drop the folder lock, and nothing would
  // undo that. `before-quit` is where the real shutdown belongs.
  host?.stopPolling();
  if (process.platform !== "darwin") app.quit();
  // With the menu bar icon to come back by, the Dock icon goes with the window.
  else if (tray) app.dock?.hide();
});

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
});
