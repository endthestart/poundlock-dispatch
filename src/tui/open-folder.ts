/**
 * The project a folder opens, keyed by the folder's path: renaming the folder
 * starts a new project rather than carrying the old history into it. An
 * active project opens as it is. When the folder's project is archived,
 * `restore` is asked once, before the screen starts, whether to bring it
 * back; otherwise a new project starts for the folder.
 */
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createFolderProject } from "@core/projects";
import type { FileStore } from "@core/store";
import type { ProjectRecord } from "@shared/types";

export type RestoreQuestion = (archived: ProjectRecord) => Promise<boolean>;

export async function openFolder(
  store: FileStore,
  folder: string,
  restore?: RestoreQuestion,
): Promise<ProjectRecord> {
  // Projects keep the real path, so a folder opened through a link is the same folder.
  const root = await realpath(resolve(folder));
  const mine = (await store.listProjects()).filter(
    (project) =>
      project.source.kind === "local_folder" &&
      project.source.originalPath === root &&
      !project.removing,
  );
  const active = mine.find((project) => !project.archived);
  if (active) return active;
  const archived = mine.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (archived && restore && (await restore(archived))) {
    const restored = { ...archived, archived: false };
    await store.saveProject(restored);
    return restored;
  }
  return createFolderProject({ store, folder: root });
}

/** The question on the line the shell left, answered with Enter (yes) or n. */
export function askRestoreInTerminal(): RestoreQuestion {
  return async (archived) => {
    const line = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await line.question(
        `${archived.name} is archived (last active ${archived.updatedAt.slice(0, 10)}). Restore it, with its conversation and history? Enter restores it, n starts a new project. [Y/n] `,
      );
      return !/^n/i.test(answer.trim());
    } finally {
      line.close();
    }
  };
}
