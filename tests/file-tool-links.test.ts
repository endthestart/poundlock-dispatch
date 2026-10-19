/**
 * L34: the worker's write path never creates anything outside the project
 * through a folder swapped for a link after the path was checked.
 */
import { constants, existsSync } from "node:fs";
import { mkdir, readdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createProjectDirectories, openProjectPath } from "@runtime/policy-extension";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

async function layout() {
  const root = await realpath(await tempDir("dispatch-l34-"));
  const outside = await realpath(await tempDir("dispatch-l34-out-"));
  await mkdir(join(root, "src"));
  // What a swap leaves behind: a folder of the project that is now a link out of it.
  await symlink(outside, join(root, "swapped"));
  return { root, outside };
}

describe("worker writes through a swapped folder", () => {
  it.skipIf(process.platform !== "darwin")(
    "refuse to create a file through a link anywhere in its path",
    async () => {
      const { root, outside } = await layout();
      await expect(
        openProjectPath(join(root, "swapped", "new.txt"), constants.O_WRONLY | constants.O_CREAT),
      ).rejects.toThrow();
      expect(await readdir(outside)).toEqual([]);
    },
  );

  it("create folders one at a time and stop at a link", async () => {
    const { root, outside } = await layout();
    await expect(createProjectDirectories(root, join(root, "swapped", "a", "b"))).rejects.toThrow(
      /changed/,
    );
    expect(existsSync(join(outside, "a", "b"))).toBe(false);
    await createProjectDirectories(root, join(root, "src", "deep", "er"));
    expect(existsSync(join(root, "src", "deep", "er"))).toBe(true);
  });

  it("still opens an ordinary project file", async () => {
    const { root } = await layout();
    const handle = await openProjectPath(
      join(root, "src", "ok.txt"),
      constants.O_WRONLY | constants.O_CREAT,
      0o644,
    );
    await handle.close();
    expect(existsSync(join(root, "src", "ok.txt"))).toBe(true);
  });
});
