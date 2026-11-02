/**
 * `dispatch [folder]`: open the folder (or `--git` repository) as a project,
 * start the same host the desktop app runs, and hand it to the screen.
 */
import { basename, resolve } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import { AutoPaths } from "@core/auto/runs";
import { autoBaseRoot, autoDockerContext } from "@core/data-root";
import type { DispatchHost, HostFacilities } from "@core/host/dispatch-host";
import { defaultConfigRoot } from "@core/paths";
import { FileStore } from "@core/store";
import { createDispatchHost } from "@runtime/host-factory";
import type { ProjectRecord } from "@shared/types";
import { terminalAlerts } from "./alerts.js";
import { spawnDetachedRunner } from "./auto-launch.js";
import { autoDeps, tuiDataRoot } from "./cli-commands.js";
import { askRestoreInTerminal, openFolder, type RestoreQuestion } from "./open-folder.js";
import { type GitOpen, openGitProject, parseGitOpen, withoutGitFlags } from "./open-git.js";
import { tuiPreferencesFile } from "./preferences.js";
import { renderConversation } from "./render.js";

export interface StartOptions {
  folder: string;
  /** A Git repository project instead of a folder (`--git`). */
  git?: GitOpen;
  /** Print one state and exit, for scripts and for checking on a run. */
  json?: boolean;
}

function parseArgs(argv: string[]): StartOptions {
  const args = argv.filter((value) => value !== "--");
  const json = args.includes("--json");
  const git = parseGitOpen(args);
  // `npm --prefix <dispatch> run tui` runs from the package folder; npm keeps
  // the folder it was started in as INIT_CWD, and that is the one meant.
  const folder =
    withoutGitFlags(args).find((value) => !value.startsWith("-")) ??
    process.env.INIT_CWD ??
    process.cwd();
  return { folder, json, ...(git ? { git } : {}) };
}

async function buildHost(
  folder: string,
  restore?: RestoreQuestion,
  git?: GitOpen,
): Promise<{ host: DispatchHost; project: ProjectRecord }> {
  const store = new FileStore(tuiDataRoot(), defaultConfigRoot());
  await store.init();
  const approvals = new ApprovalBroker(() => {
    void host.emitState();
  });
  const facilities: HostFacilities = {
    dataRoot: tuiDataRoot(),
    // A terminal has no dialogs. Folders are named on the command line and
    // files are granted with a path, so nothing here needs a picker.
    ...terminalAlerts(
      () => host,
      (text) => void process.stdout.write(text),
      tuiPreferencesFile(tuiDataRoot()),
    ),
    // This program is the runner, so it needs no version check; the host uses
    // these to keep interactive work off a project Autopilot is building.
    autopilot: {
      paths: new AutoPaths(autoBaseRoot()),
      dockerContext: autoDockerContext(),
      checkRunner: async () => undefined,
      spawnRunner: (runDir) => spawnDetachedRunner(process.argv[1], runDir),
    },
  };
  const host: DispatchHost = createDispatchHost(facilities, store, approvals, {
    hostApp: "tui",
    dataRoot: tuiDataRoot(),
  });
  // A folder's project exists before the host starts; a repository is cloned by the started host.
  const local = git ? undefined : await openFolder(store, folder, restore);
  await host.start();
  const project = local ?? (await openGitProject(host, store, git!));
  await host.selectProject(project.id);
  return { host, project };
}

/**
 * Leave the way the second Ctrl+C does. SIGHUP is the terminal window closing:
 * without it the client died holding the folder lock, and the next client
 * opened in that folder only watched. The terminal is gone by then, so a
 * failed write to it must not end the process before the host shuts down.
 */
export function closeOnSignals(
  close: () => void,
  target: Pick<NodeJS.Process, "on" | "stdout"> = process,
): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) target.on(signal, close);
  target.on("SIGHUP", () => {
    target.stdout.on("error", () => {});
    close();
  });
}

export async function openClient(argv: string[]): Promise<void> {
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";
  const options = parseArgs(argv);
  // Opening a folder reads the store and starts the host, which is not
  // instant. Say so on the line the shell left us, and wipe it before the
  // screen takes over, so a slow start looks like a start and not a hang.
  const interactive = Boolean(process.stdout.isTTY) && !options.json;
  const clearOpening = () => {
    if (interactive) process.stdout.write("\r\x1b[2K");
  };
  if (interactive)
    process.stdout.write(
      `Opening ${options.git ? options.git.repository : basename(resolve(options.folder))}…`,
    );
  const restore: RestoreQuestion | undefined = interactive
    ? async (archived) => {
        clearOpening();
        return askRestoreInTerminal()(archived);
      }
    : undefined;
  const { host } = await buildHost(options.folder, restore, options.git).catch((error: unknown) => {
    clearOpening();
    throw error;
  });
  clearOpening();

  if (options.json) {
    // A non-interactive read, so a script can see what a run is doing without
    // driving it. Reading never needs the folder lock.
    process.stdout.write(`${JSON.stringify(await host.getState(), null, 2)}\n`);
    await host.shutdown();
    return;
  }

  if (!process.stdout.isTTY) {
    const state = await host.getState();
    process.stdout.write(`${renderConversation(state, 100).lines.join("\n")}\n`);
    await host.shutdown();
    return;
  }

  // The screen and its libraries load only for a terminal; --json and a pipe never draw one.
  const { TuiApp } = await import("./app.js");
  const app = new TuiApp(
    host,
    undefined,
    undefined,
    undefined,
    autoDeps(),
    tuiPreferencesFile(tuiDataRoot()),
  );
  closeOnSignals(() => {
    void app.stop().then(() => process.exit(0));
  });
  await app.start();
}
