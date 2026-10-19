import { homedir } from "node:os";
import { join } from "node:path";
import { APP_NAME } from "@shared/types";

/**
 * How this machine reaches Poundlock: the controller, its token, the profiles
 * bound to each execution role, the model ladder, and the default trust mode.
 * None of it describes a workspace, so every Dispatch client on this machine
 * shares one copy rather than asking for the same token again.
 */
export interface ConfigLayout {
  root: string;
  connection: string;
  secret: string;
  integrations: string;
  integrationsSecret: string;
  /** Default trust mode and reviewer profile — the machine-wide half of permissions. */
  defaults: string;
  /** The theme flavour every Dispatch client on this machine paints with. */
  appearance: string;
}

/**
 * What one client is working on: its projects, the per-project grants those
 * projects carry, and how it looks. Separate per client, so opening a folder
 * in a terminal does not fill the desktop app's project list.
 */
export interface DataLayout {
  root: string;
  config: ConfigLayout;
  /** Per-project saved approvals. Keyed by project id, so it follows the projects. */
  permissions: string;
  ui: string;
  projectsIndex: string;
  projectsDir: string;
}

/** Where the desktop app keeps its own projects. */
export function defaultDataRoot(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_NAME);
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), APP_NAME);
}

/**
 * The one config directory every Dispatch client on this machine reads.
 * Nested under `poundlock/` rather than owning it, because that directory is
 * the Poundlock ecosystem's and other tools already keep files there.
 */
export function defaultConfigRoot(): string {
  if (process.env.POUNDLOCK_CONFIG_DIR) return process.env.POUNDLOCK_CONFIG_DIR;
  const base =
    process.platform === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "poundlock")
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "poundlock");
  return join(base, "dispatch");
}

export function configLayoutFor(root: string): ConfigLayout {
  return {
    root,
    connection: join(root, "connection.json"),
    secret: join(root, "connection.secret.json"),
    integrations: join(root, "integrations.json"),
    integrationsSecret: join(root, "integrations.secret.json"),
    defaults: join(root, "defaults.json"),
    appearance: join(root, "appearance.json"),
  };
}

/**
 * `configRoot` defaults to a directory inside `root`, so a store is
 * self-contained unless a client deliberately opts into the machine-wide
 * config. Each client does that at its composition root by passing
 * `defaultConfigRoot()`, which keeps the sharing visible in one place instead
 * of hidden in a default.
 */
export function layoutFor(root: string, configRoot: string = join(root, "config")): DataLayout {
  return {
    root,
    config: configLayoutFor(configRoot),
    permissions: join(root, "permissions.json"),
    ui: join(root, "ui.json"),
    projectsIndex: join(root, "projects.json"),
    projectsDir: join(root, "projects"),
  };
}

export function projectDir(root: string, projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("Invalid project identifier.");
  return join(root, "projects", projectId);
}

export function projectFiles(root: string, projectId: string) {
  const dir = projectDir(root, projectId);
  return {
    dir,
    record: join(dir, "project.json"),
    /** Every web search and fetch the manager made for this project. */
    webCalls: join(dir, "web-calls.jsonl"),
    plan: join(dir, "plan.json"),
    tasks: join(dir, "tasks.json"),
    pendingBoard: join(dir, "pending-board.json"),
    messages: join(dir, "messages.json"),
    notes: join(dir, "notes"),
    workspace: join(dir, "workspace"),
    snapshot: join(dir, "snapshot"),
    piHome: join(dir, "pi-home"),
    piAgent: join(dir, "pi-home", ".pi", "agent"),
    sessions: join(dir, "sessions"),
    journal: join(dir, "journal"),
    exports: join(dir, "exports"),
  };
}
