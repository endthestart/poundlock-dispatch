import {
  boundedNote,
  compileTaskHints,
  MAX_CONTEXT_NOTE_CHARS,
  MAX_FILES_TO_TOUCH,
  MAX_REUSE_HINTS,
  taskHintIssue,
} from "@core/task-hints";
import { composeWorkerInstructions } from "@core/workflow-support";
import { defaultBudget, defaultPolicy, type ProjectRecord, type TaskRecord } from "@shared/types";
import { describe, expect, it } from "vitest";

function project(): ProjectRecord {
  return {
    id: "project",
    name: "Example",
    archived: false,
    createdAt: "now",
    updatedAt: "now",
    status: "draft",
    source: {
      kind: "local_folder",
      originalPath: "/tmp/example",
      capturedAt: "now",
      snapshotSha256: "",
      baseRevision: "",
      includedFiles: 0,
      includedBytes: 0,
      excludedPatterns: [],
      includedUncommitted: true,
      originalFingerprint: "",
    },
    policy: { ...defaultPolicy(), verification: { commands: ["npm test"], protectedPaths: [] } },
    budget: defaultBudget(),
    integration: { headRevision: "", expectedBase: "", appliedPatchSha256: [] },
    planRevision: 0,
    managerSessionId: "manager",
    eventCursor: 0,
  };
}

function task(extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    title: "Add slugs",
    objective: "Add URL slugs",
    workerPrompt: "Implement slugs and test them.",
    acceptanceCriteria: "Slugs are unique",
    dependsOn: [],
    difficulty: "small",
    contextNote: "",
    status: "ready",
    repairCount: 0,
    attempts: [],
    ...extra,
  };
}

describe("task hint validation", () => {
  it("accepts project-relative paths and globs, and free-text reuse entries", () => {
    expect(
      taskHintIssue({
        filesToTouch: ["src/core/slug.ts", "tests/**/*.test.ts", "docs/adr/0012-slugs.md"],
        reuse: ["slugify() in src/util/text.ts", "the retry pattern in src/net/retry.ts"],
      }),
    ).toBeUndefined();
    expect(taskHintIssue({})).toBeUndefined();
  });

  it.each([
    ["an absolute path", { filesToTouch: ["/etc/passwd"] }, /must be relative/],
    ["a home path", { filesToTouch: ["~/.ssh/config"] }, /must be relative/],
    ["a drive path", { filesToTouch: ["C:\\Users\\me\\a.ts"] }, /must be relative/],
    ["a parent segment", { filesToTouch: ["src/../../outside.ts"] }, /inside the project/],
    ["a non-array", { filesToTouch: "src/a.ts" }, /JSON array/],
    ["a non-string entry", { reuse: [{ path: "src/a.ts" }] }, /non-empty string/],
    ["a blank entry", { reuse: ["  "] }, /non-empty string/],
    ["a control character", { filesToTouch: ["src/a\u0000.ts"] }, /control character/],
    ["a very long entry", { reuse: ["x".repeat(301)] }, /longer than 300/],
    [
      "too many files",
      { filesToTouch: Array.from({ length: MAX_FILES_TO_TOUCH + 1 }, (_, i) => `f${i}.ts`) },
      /at most 20/,
    ],
    [
      "too much reuse",
      { reuse: Array.from({ length: MAX_REUSE_HINTS + 1 }, (_, i) => `helper${i} in a.ts`) },
      /at most 12/,
    ],
  ])("rejects %s and names the field", (_label, value, reason) => {
    const issue = taskHintIssue(value);
    expect(issue?.reason).toMatch(reason);
    expect(issue?.field).toBe("filesToTouch" in value ? "filesToTouch" : "reuse");
  });

  it("trims and de-duplicates, and leaves out an empty or absent list", () => {
    expect(
      compileTaskHints({
        title: "T",
        filesToTouch: [" src/a.ts ", "src/a.ts", "src/b.ts"],
        reuse: [],
      }),
    ).toEqual({ filesToTouch: ["src/a.ts", "src/b.ts"] });
    expect("reuse" in compileTaskHints({ title: "T" })).toBe(false);
  });

  it("refuses an invalid task with its title", () => {
    expect(() => compileTaskHints({ title: "Add slugs", filesToTouch: ["../x"] })).toThrow(
      /Task “Add slugs”: filesToTouch entry "\.\.\/x" must stay inside the project folder/,
    );
  });
});

describe("what a worker receives from the manager", () => {
  it("clips a long context note and says so", () => {
    const note = boundedNote("n".repeat(MAX_CONTEXT_NOTE_CHARS + 500), MAX_CONTEXT_NOTE_CHARS);
    expect(note.startsWith("n".repeat(MAX_CONTEXT_NOTE_CHARS))).toBe(true);
    expect(note).toContain("[note truncated: first 2,000 of 2,500 characters]");
    expect(boundedNote(" short ", MAX_CONTEXT_NOTE_CHARS)).toBe("short");
  });

  it("labels the note, files and reuse in an interactive brief, after the instructions", () => {
    const brief = JSON.parse(
      composeWorkerInstructions(
        task({
          contextNote: "Slugs are lowercase ASCII.",
          filesToTouch: ["src/core/slug.ts"],
          reuse: ["slugify() in src/util/text.ts"],
        }),
        project(),
      ),
    ) as Record<string, unknown>;
    expect(Object.keys(brief)).toEqual([
      "objective",
      "instructions",
      "contextFromManager",
      "filesToTouch",
      "reuseExistingCode",
      "acceptanceCriteria",
      "verificationCommands",
    ]);
    expect(brief.contextFromManager).toBe("Slugs are lowercase ASCII.");
    expect(brief.filesToTouch).toEqual(["src/core/slug.ts"]);
    expect(brief.reuseExistingCode).toEqual(["slugify() in src/util/text.ts"]);
  });

  it("bounds the note in the brief without touching the stored task", () => {
    const stored = task({ contextNote: "n".repeat(10_000) });
    const brief = JSON.parse(composeWorkerInstructions(stored, project())) as {
      contextFromManager: string;
    };
    expect(brief.contextFromManager.length).toBeLessThan(2_200);
    expect(brief.contextFromManager).toContain("[note truncated");
    expect(stored.contextNote).toHaveLength(10_000);
  });

  it("gives a task from a plan stored before these fields the brief it always had", () => {
    const legacy = task();
    expect("filesToTouch" in legacy).toBe(false);
    expect(Object.keys(JSON.parse(composeWorkerInstructions(legacy, project())))).toEqual([
      "objective",
      "instructions",
      "acceptanceCriteria",
      "verificationCommands",
    ]);
  });
});
