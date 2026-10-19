import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { importTerminalProjects } from "@core/data-root";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

async function setup() {
  const root = await realpath(await tempDir("data-root-"));
  const legacy = new FileStore(join(root, "terminal"));
  const app = new FileStore(join(root, "app"));
  await legacy.init();
  await app.init();
  const folder = async (name: string) => {
    const path = join(root, name);
    await mkdir(path);
    return path;
  };
  return { root, legacy, app, folder };
}

it("copies the terminal's projects once, archiving a folder the app already has", async () => {
  const { legacy, app, folder } = await setup();
  const shared = await folder("shared");
  const onlyTerminal = await createFolderProject({ store: legacy, folder: await folder("solo") });
  const duplicate = await createFolderProject({ store: legacy, folder: shared });
  await createFolderProject({ store: app, folder: shared });
  await writeFile(
    join(legacy.layout.root, "permissions.json"),
    JSON.stringify({
      defaultMode: "ask",
      grants: { [onlyTerminal.id]: [{ kind: "bash", action: "npm test", cwd: "/tmp" }] },
    }),
  );

  const record = await importTerminalProjects(app, legacy.layout.root);
  expect(record?.imported.sort()).toEqual([onlyTerminal.id, duplicate.id].sort());
  expect(record?.archived).toEqual([duplicate.id]);
  expect((await app.getProject(onlyTerminal.id))?.archived).toBeFalsy();
  expect((await app.getProject(duplicate.id))?.archived).toBe(true);
  expect((await app.getPermissions()).grants?.[onlyTerminal.id]).toBeDefined();
  // Copied, never moved: the terminal's own records are still there.
  expect(await readdir(legacy.layout.projectsDir)).toHaveLength(2);
  // Once per target.
  expect(await importTerminalProjects(app, legacy.layout.root)).toBeUndefined();
  expect(await app.listProjects()).toHaveLength(3);
});

it("does nothing when the terminal has no projects", async () => {
  const { root, app } = await setup();
  expect(await importTerminalProjects(app, join(root, "missing"))).toBeUndefined();
});
