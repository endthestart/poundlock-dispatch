/** What every `dispatch autopilot` command is given: the client's dependencies and its output. */

import type { AutoPaths } from "@core/auto/runs";
import type { AutoStartDeps } from "@core/auto/start";
import type { FileStore } from "@core/store";
import type { AutoRunnerDeps } from "@runtime/auto-runner";
import type { ConnectionSettings, ProjectRecord } from "@shared/types";

export interface AutoCliDeps {
  paths: AutoPaths;
  connection(): Promise<ConnectionSettings>;
  /** The Dispatch project for a folder, if this client has one. */
  project(source: string): Promise<{ project: ProjectRecord; store: FileStore } | undefined>;
  /** The script the runner is started with: this program's entry. */
  entry: string;
  io: { out(text: string): void; err(text: string): void };
  fetch?: typeof fetch;
  docker?: string;
  dockerEnv?: NodeJS.ProcessEnv;
  spawnRunner?: (runDir: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Where Ctrl+C is heard while watching; returns how to stop listening. */
  onInterrupt?: (handler: () => void) => () => void;
  runner?: Partial<AutoRunnerDeps>;
  freeBytes?: AutoStartDeps["freeBytes"];
  /** The owner's home folder, which the container VM must not mount. */
  home?: string;
}

export interface AutoContext {
  deps: AutoCliDeps;
  say(text: string): void;
  warn(text: string): void;
  sleep(ms: number): Promise<void>;
  spawnRunner(runDir: string): void;
  progress(runDir: string): Promise<string[]>;
}
