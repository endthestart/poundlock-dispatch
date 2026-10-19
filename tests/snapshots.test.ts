import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSnapshotName, keepSnapshots, SNAPSHOT_FOLDER, snapshotDataUrl } from "@core/snapshots";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

it("keeps the snapshots an attempt wrote, and only those", async () => {
  const project = await tempDir("snap-project-");
  const attempt = await tempDir("snap-attempt-");
  const folder = join(project, SNAPSHOT_FOLDER);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "old.png"), "old");
  const past = new Date(Date.now() - 3_600_000);
  await utimes(join(folder, "old.png"), past, past);
  const started = Date.now();
  await writeFile(join(folder, "grid.png"), "png bytes");
  await writeFile(join(folder, "notes.txt"), "not an image");
  expect(await keepSnapshots(project, attempt, started)).toEqual(["grid.png"]);
  expect(await readFile(join(attempt, "snapshots", "grid.png"), "utf8")).toBe("png bytes");
  expect(await snapshotDataUrl(attempt, "grid.png")).toBe(
    `data:image/png;base64,${Buffer.from("png bytes").toString("base64")}`,
  );
  await expect(snapshotDataUrl(attempt, "../grid.png")).rejects.toThrow(/Not a snapshot/);
  expect(await keepSnapshots(join(project, "missing"), attempt, started)).toEqual([]);
});

it("accepts plain image names only", () => {
  expect(isSnapshotName("adjustments-sheet.jpg")).toBe(true);
  for (const name of ["../x.png", "a/b.png", ".hidden.png", "x.svg"])
    expect(isSnapshotName(name)).toBe(false);
});
