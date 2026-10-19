/**
 * Poundlock Dispatch in a terminal. A folder is the project.
 *
 * This is a composition root and nothing else: it builds the same
 * `DispatchHost` the desktop app builds, points it at this folder, and hands
 * it to the screens. The workflow — planning, delegation, review, repair,
 * approvals — is the code the desktop app runs, not a second copy of it.
 */
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import { AutoPaths } from "@core/auto/runs";
import { migrateSharedConfig } from "@core/config-migration";
import { autoBaseRoot, importTerminalProjects, terminalLegacyRoot } from "@core/data-root";
import { FolderLock } from "@core/folder-lock";
import { DispatchHost, type HostFacilities } from "@core/host/dispatch-host";
import { ProjectOrchestrator } from "@core/orchestration";
import { defaultConfigRoot, defaultDataRoot } from "@core/paths";
import { ProjectLifecycle } from "@core/project-lifecycle";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { createApprovalReviewer } from "@runtime/approval-reviewer";
import { hostCommandPort } from "@runtime/host-command";
import { createManagerProvider } from "@runtime/manager-provider";
import { createPiWorker } from "@runtime/pi-worker";
import { configureSystemCertificateAuthorities } from "@runtime/system-ca";
import { PI_VERSION, type ProjectRecord } from "@shared/types";
import { TuiApp } from "./app.js";
import { type AutoCliDeps, runAuto, spawnDetachedRunner } from "./auto.js";
import { runJobs } from "./jobs.js";
import { renderConversation } from "./render.js";

/** ASCII BEL, written as a code point so it is visible in source. */
const BELL = String.fromCharCode(7);

/**
 * Projects, sessions and manager notes: the desktop app's root, shared by both
 * clients since 0.3.0 (ADR 016). Never the project folder.
 */
function tuiDataRoot(): string {
  return process.env.POUNDLOCK_DISPATCH_DATA_DIR || defaultDataRoot();
}

/** Auto-mode and Autopilot runs stay where the auto VM mounts them. */
/**
 * The project for this folder, created on first use. Identity stays an opaque
 * id keyed by the folder's real path, so renaming the folder loses the
 * manager's history rather than silently starting a new project under it.
 */
async function openFolder(store: FileStore, folder: string): Promise<ProjectRecord> {
  const root = resolve(folder);
  const existing = (await store.listProjects()).find(
    (project) =>
      project.source.kind === "local_folder" &&
      project.source.originalPath === root &&
      !project.archived &&
      !project.removing,
  );
  if (existing) return existing;
  return createFolderProject({ store, folder: root });
}

export interface StartOptions {
  folder: string;
  /** Print one state and exit, for scripts and for checking on a run. */
  json?: boolean;
}

function parseArgs(argv: string[]): StartOptions {
  const args = argv.filter((value) => value !== "--");
  const json = args.includes("--json");
  // `npm --prefix <dispatch> run tui` runs from the package folder; npm keeps
  // the folder it was started in as INIT_CWD, and that is the one meant.
  const folder =
    args.find((value) => !value.startsWith("-")) ?? process.env.INIT_CWD ?? process.cwd();
  return { folder, json };
}

async function buildHost(folder: string): Promise<{ host: DispatchHost; project: ProjectRecord }> {
  const store = new FileStore(tuiDataRoot(), defaultConfigRoot());
  await store.init();
  // This machine's connection may still sit in the desktop app's data
  // directory, from before there was a second client. Move it to the shared
  // config rather than asking for a token that already exists here.
  migrateSharedConfig(store.layout) || migrateSharedConfig(store.layout, terminalLegacyRoot());
  if (!process.env.POUNDLOCK_DISPATCH_DATA_DIR) {
    const moved = await importTerminalProjects(store);
    if (moved?.imported.length)
      process.stderr.write(
        `Dispatch now keeps the terminal's projects with the desktop app's. Copied ${moved.imported.length} from ${terminalLegacyRoot()}; the originals are untouched.\n`,
      );
  }
  const approvals = new ApprovalBroker(() => {
    void host.emitState();
  });
  const facilities: HostFacilities = {
    dataRoot: tuiDataRoot(),
    // A terminal has no dialogs. Folders are named on the command line and
    // files are granted with a path, so nothing here needs a picker.
    notifyNeedsYou: () => process.stdout.write(BELL),
    // This program is the runner, so it needs no version check; the host uses
    // these to keep interactive work off a project Autopilot is building.
    autopilot: {
      paths: new AutoPaths(autoBaseRoot()),
      checkRunner: async () => undefined,
      spawnRunner: (runDir) => spawnDetachedRunner(process.argv[1], runDir),
    },
  };
  const host: DispatchHost = new DispatchHost(facilities, store, approvals, {
    worker: () => createPiWorker(),
    folderLock: new FolderLock(join(defaultConfigRoot(), "locks"), {
      hostApp: "tui",
      dataRoot: tuiDataRoot(),
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
  const project = await openFolder(store, folder);
  await host.start();
  await host.selectProject(project.id);
  return { host, project };
}

/**
 * `jobs` names the job commands, so a folder called `jobs` is opened as `./jobs`.
 * They talk to the controller and nothing else: no project, no folder lock, no host.
 */
async function jobsCommand(args: string[]): Promise<number> {
  return runJobs(args, {
    connection: () => new FileStore(tuiDataRoot(), defaultConfigRoot()).getConnection(),
    io: {
      out: (text) => void process.stdout.write(text),
      err: (text) => void process.stderr.write(text),
      outIsTty: Boolean(process.stdout.isTTY),
    },
  });
}

/**
 * `auto` names local auto mode's commands (ADR 014). They need no host and no
 * folder lock: a run works in its own clone, and its runner is this program
 * started again as `auto run`.
 */
function autoDeps(): Omit<AutoCliDeps, "io"> {
  const store = () => new FileStore(tuiDataRoot(), defaultConfigRoot());
  return {
    paths: new AutoPaths(autoBaseRoot()),
    connection: () => store().getConnection(),
    // The folder as auto mode names it is a real path; the project may keep the path as typed.
    project: async (source) => {
      const projects = store();
      for (const item of await projects.listProjects()) {
        if (item.source.kind !== "local_folder" || item.archived || item.removing) continue;
        const original = item.source.originalPath;
        if ((await realpath(original).catch(() => original)) === source)
          return { project: item, store: projects };
      }
      return undefined;
    },
    entry: process.argv[1],
  };
}

async function autoCommand(args: string[]): Promise<number> {
  return runAuto(args, {
    ...autoDeps(),
    io: {
      out: (text) => void process.stdout.write(text),
      err: (text) => void process.stderr.write(text),
    },
  });
}

const USAGE = `Usage: dispatch [folder]          Open a folder as a project (default: this folder).
       dispatch [folder] --json   Print the project's state and exit.
       dispatch autopilot <command>  Build an approved plan unattended. --help lists its commands.
                                  (dispatch auto is the same, for one more release.)
       dispatch jobs <command>    Durable Poundlock jobs. dispatch jobs --help lists them.
       dispatch --version
`;

/** This build's version, from the package.json beside the client in any install. */
function version(): string {
  try {
    return createRequire(import.meta.url)("../../package.json").version as string;
  } catch {
    return "unknown";
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`Poundlock Dispatch ${version()} (Pi ${PI_VERSION})\n`);
    return;
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  configureSystemCertificateAuthorities();
  if (argv[0] === "autopilot" || argv[0] === "auto") {
    process.exitCode = await autoCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "jobs") {
    // Left to drain rather than `process.exit`, so a patch piped to a slow reader is not cut off.
    process.exitCode = await jobsCommand(argv.slice(1));
    return;
  }
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
  if (interactive) process.stdout.write(`Opening ${basename(resolve(options.folder))}…`);
  const { host } = await buildHost(options.folder).catch((error: unknown) => {
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

  const app = new TuiApp(host, undefined, undefined, undefined, autoDeps());
  const close = () => {
    void app.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  await app.start();
}

if (process.argv[1]?.endsWith("tui/index.ts") || process.argv[1]?.endsWith("tui/index.js")) {
  main().catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
