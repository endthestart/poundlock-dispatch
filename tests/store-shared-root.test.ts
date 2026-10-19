import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

/** Two stores on one root stand in for two processes: the app and an Autopilot runner. */
async function twoStores() {
  const root = await realpath(await tempDir("shared-root-"));
  const first = new FileStore(join(root, "data"));
  const second = new FileStore(join(root, "data"));
  await first.init();
  await second.init();
  const folders = await Promise.all(
    ["a", "b"].map(async (name) => {
      const folder = join(root, name);
      await mkdir(folder);
      return folder;
    }),
  );
  return { first, second, folders };
}

it("keeps both processes' saves of different projects", async () => {
  const { first, second, folders } = await twoStores();
  const a = await createFolderProject({ store: first, folder: folders[0] });
  const b = await createFolderProject({ store: first, folder: folders[1] });
  // Each process read both projects earlier; each now saves only its own.
  const staleA = (await first.getProject(a.id))!;
  const staleB = (await second.getProject(b.id))!;
  staleA.name = "renamed by the app";
  staleB.name = "renamed by the runner";
  await Promise.all([first.saveProject(staleA), second.saveProject(staleB)]);
  expect((await first.getProject(a.id))?.name).toBe("renamed by the app");
  expect((await first.getProject(b.id))?.name).toBe("renamed by the runner");
  expect((await second.listProjects()).map((project) => project.name).sort()).toEqual([
    "renamed by the app",
    "renamed by the runner",
  ]);
  // The legacy index is still written for older clients.
  const index = JSON.parse(await readFile(first.layout.projectsIndex, "utf8")) as unknown[];
  expect(index).toHaveLength(2);
});

it("never turns an id from a caller into a path outside the project data", async () => {
  const { first } = await twoStores();
  expect(await first.getProject("../config")).toBeUndefined();
  expect(await first.getProject("proj_../../etc")).toBeUndefined();
});
