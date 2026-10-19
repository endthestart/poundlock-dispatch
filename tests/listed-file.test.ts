/**
 * M8: a file swapped for a link after a snapshot or evidence listing is never
 * read through the link.
 */
import { execFileSync } from "node:child_process";
import { mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ListedFileChanged, openListedFile } from "@core/listed-file";
import { captureLocalEvidence } from "@core/local-evidence";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./support/temp-dir";

/** Swaps run between the listing and the reads, as a leftover process would. */
const afterListing: Array<() => Promise<void>> = [];
vi.mock("@core/snapshot", async (original) => {
  const real = await original<typeof import("@core/snapshot")>();
  return {
    ...real,
    listLiveProjectFiles: async (...args: Parameters<typeof real.listLiveProjectFiles>) => {
      const listed = await real.listLiveProjectFiles(...args);
      for (const swap of afterListing.splice(0)) await swap();
      return listed;
    },
  };
});

async function layout() {
  const base = await tempDir("dispatch-m8-");
  const root = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "src", "app.ts"), "export {};\n");
  await writeFile(join(root, "notes.txt"), "notes\n");
  await writeFile(join(outside, "app.ts"), "PRIVATE KEY\n");
  await writeFile(join(outside, "id_ed25519"), "PRIVATE KEY\n");
  return { base, root, outside };
}

describe("opening a listed file", () => {
  it("reads a file that is still what the listing found", async () => {
    const { root } = await layout();
    const { handle } = await openListedFile(root, "src/app.ts");
    try {
      expect((await handle.readFile()).toString()).toBe("export {};\n");
    } finally {
      await handle.close();
    }
  });

  it("refuses a file swapped for a link to a secret", async () => {
    const { root, outside } = await layout();
    await rename(join(root, "notes.txt"), join(root, "notes.old"));
    await symlink(join(outside, "id_ed25519"), join(root, "notes.txt"));
    await expect(openListedFile(root, "notes.txt")).rejects.toBeInstanceOf(ListedFileChanged);
  });

  it("refuses a file whose folder was swapped for a link", async () => {
    const { root, outside } = await layout();
    await rename(join(root, "src"), join(root, "src.old"));
    await symlink(outside, join(root, "src"));
    await expect(openListedFile(root, "src/app.ts")).rejects.toBeInstanceOf(ListedFileChanged);
  });

  it("refuses a FIFO without blocking", async () => {
    const { root } = await layout();
    execFileSync("mkfifo", [join(root, "pipe")]);
    await expect(openListedFile(root, "pipe")).rejects.toBeInstanceOf(ListedFileChanged);
  });
});

describe("local evidence capture", () => {
  it("leaves out files swapped for links after the listing", async () => {
    const { root, outside } = await layout();
    afterListing.push(async () => {
      await rename(join(root, "src"), join(root, "src.old"));
      await symlink(outside, join(root, "src"));
      await rename(join(root, "notes.txt"), join(root, "notes.old"));
      await symlink(join(outside, "id_ed25519"), join(root, "notes.txt"));
    });
    const evidence = await captureLocalEvidence(root, []);
    expect(evidence.manifest.map((file) => file.path)).toEqual([]);
    for (const file of evidence.files) expect(file.content.toString()).not.toContain("PRIVATE");
  });

  it("still captures files nobody touched", async () => {
    const { root } = await layout();
    const evidence = await captureLocalEvidence(root, []);
    expect(evidence.manifest.map((file) => file.path).sort()).toEqual(["notes.txt", "src/app.ts"]);
    expect(evidence.files.find((file) => file.path === "notes.txt")?.content.toString()).toBe(
      "notes\n",
    );
  });
});
