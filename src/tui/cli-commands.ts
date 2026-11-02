/**
 * The commands that need no screen: `dispatch jobs …` talks to the controller
 * and nothing else, and `dispatch autopilot …` works on runs in their own
 * clones. Neither needs a host or a folder lock.
 */
import { realpath } from "node:fs/promises";
import { AutoPaths } from "@core/auto/runs";
import { autoBaseRoot } from "@core/data-root";
import { defaultConfigRoot, defaultDataRoot } from "@core/paths";
import { FileStore } from "@core/store";
import { runAuto } from "./auto.js";
import type { AutoCliDeps } from "./auto-context.js";
import { runJobs } from "./jobs.js";

/**
 * Projects, sessions and manager notes: the desktop app's root, shared by both
 * clients since 0.3.0 (ADR 016). Never the project folder.
 */
export function tuiDataRoot(): string {
  return process.env.POUNDLOCK_DISPATCH_DATA_DIR || defaultDataRoot();
}

/**
 * `jobs` names the job commands, so a folder called `jobs` is opened as `./jobs`.
 * They talk to the controller and nothing else: no project, no folder lock, no host.
 */
export async function jobsCommand(args: string[]): Promise<number> {
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
 * started again as `autopilot run`.
 */
export function autoDeps(): Omit<AutoCliDeps, "io"> {
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

export async function autoCommand(args: string[]): Promise<number> {
  return runAuto(args, {
    ...autoDeps(),
    io: {
      out: (text) => void process.stdout.write(text),
      err: (text) => void process.stderr.write(text),
    },
  });
}
