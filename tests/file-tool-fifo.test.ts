/**
 * L33: a FIFO planted in the project is refused by the file tools at once,
 * instead of blocking them and hanging the run.
 */
import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { projectFileToolDefinitions, readProjectBuffer } from "@runtime/policy-extension";
import { defaultBudget, defaultPolicy, type ProjectRecord } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

function project(root: string): ProjectRecord {
  return {
    id: "project",
    name: "Example",
    archived: false,
    createdAt: "now",
    updatedAt: "now",
    status: "draft",
    source: {
      kind: "local_folder",
      originalPath: root,
      capturedAt: "now",
      snapshotSha256: "",
      baseRevision: "",
      includedFiles: 0,
      includedBytes: 0,
      excludedPatterns: [],
      includedUncommitted: true,
      originalFingerprint: "",
    },
    policy: defaultPolicy(),
    budget: defaultBudget(),
    integration: { headRevision: "", expectedBase: "", appliedPatchSha256: [] },
    planRevision: 1,
    managerSessionId: "manager",
    eventCursor: 0,
  };
}

describe("file tools and a FIFO", () => {
  it("refuses to read or write one without blocking", async () => {
    const root = await realpath(await tempDir("dispatch-fifo-"));
    execFileSync("mkfifo", [join(root, "notes.txt")]);
    const options = {
      projectRoot: root,
      cwd: root,
      project: project(root),
      trust: "assist" as const,
      bashEnabled: false,
    };
    const started = Date.now();
    await expect(readProjectBuffer(options, "notes.txt")).rejects.toThrow(/regular file/);
    const definitions = projectFileToolDefinitions(
      { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition },
      options,
    );
    const write = definitions.find((item) => item.name === "write") as ReturnType<
      typeof createWriteToolDefinition
    >;
    await expect(
      write.execute(
        "fifo-write",
        { path: "notes.txt", content: "x" },
        new AbortController().signal,
        undefined,
        { cwd: root } as Parameters<typeof write.execute>[4],
      ),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);
});
