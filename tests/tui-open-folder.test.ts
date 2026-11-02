/**
 * Opening a folder whose project is archived: restore it when asked to, else
 * start a new project, and never ask when the folder has an active one. A
 * folder reached through a link is the same folder.
 */
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { openFolder } from "@tui/open-folder";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./support/temp-dir";

async function archivedFolder() {
  const root = await tempDir("tui-open-folder-");
  const store = new FileStore(join(root, "data"));
  await store.init();
  const folder = await tempDir("tui-open-folder-project-");
  const project = await createFolderProject({ store, folder });
  await store.saveProject({ ...project, archived: true });
  return { store, folder, project };
}

describe("openFolder", () => {
  it("restores the archived project when the answer is yes", async () => {
    const { store, folder, project } = await archivedFolder();
    const ask = vi.fn(async () => true);
    const opened = await openFolder(store, folder, ask);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ id: project.id }));
    expect(opened.id).toBe(project.id);
    expect((await store.getProject(project.id))?.archived).toBe(false);
    const again = vi.fn(async () => true);
    expect((await openFolder(store, folder, again)).id).toBe(project.id);
    expect(again).not.toHaveBeenCalled();
  });

  it("opens the same project through a link to its folder", async () => {
    const { store, folder, project } = await archivedFolder();
    await store.saveProject({ ...project, archived: false });
    const link = join(await tempDir("tui-open-folder-link-"), "link");
    await symlink(folder, link);
    expect((await openFolder(store, link)).id).toBe(project.id);
  });

  it("starts a new project when the answer is no, and keeps the archived one", async () => {
    const { store, folder, project } = await archivedFolder();
    const opened = await openFolder(store, folder, async () => false);
    expect(opened.id).not.toBe(project.id);
    expect((await store.getProject(project.id))?.archived).toBe(true);
  });
});
