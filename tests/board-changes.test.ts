import { retainTaskIdentity } from "@core/inspector-board";
import { boardChanges, isPlaceholderText } from "@shared/board-changes";
import type { TaskRecord } from "@shared/types";
import { describe, expect, it } from "vitest";

const task = (title: string, overrides: Partial<TaskRecord> = {}): TaskRecord =>
  ({
    id: `id-${title}`,
    title,
    objective: `Build ${title}`,
    workerPrompt: `Implement ${title}`,
    acceptanceCriteria: `${title} works for the user`,
    difficulty: "small",
    dependsOn: [],
    status: "ready",
    repairCount: 0,
    attempts: [],
    ...overrides,
  }) as TaskRecord;

describe("placeholder text", () => {
  it("is told apart from a short real statement", () => {
    for (const text of ["placeholder", "TBD", " unchanged ", "same as before", "...", ""])
      expect(isPlaceholderText(text)).toBe(true);
    for (const text of ["Tests pass", "Import a folder", "o"])
      expect(isPlaceholderText(text)).toBe(false);
  });

  it("never replaces a published task's specification", () => {
    const current = task("Shell", {
      objective: "Deliver an AppKit browser with import and review",
    });
    const kept = retainTaskIdentity(
      current,
      task("Shell", {
        objective: "placeholder",
        acceptanceCriteria: "placeholder",
        workerPrompt: "Update board: mark another task",
        changesFrozenTests: true,
      }),
    );
    expect(kept.objective).toBe(current.objective);
    expect(kept.acceptanceCriteria).toBe(current.acceptanceCriteria);
    expect(kept.workerPrompt).toBe(current.workerPrompt);
    expect(kept.changesFrozenTests).toBe(true);
  });
});

describe("board changes", () => {
  it("names what an update adds, removes and rewrites", () => {
    const current = [task("Core"), task("Shell", { dependsOn: ["id-Core"] }), task("Docs")];
    const next = [
      task("Core"),
      task("shell ", {
        id: "new-shell",
        objective: "Deliver a browser without import",
        acceptanceCriteria: "Shell works for the user",
        workerPrompt: "Implement Shell",
        dependsOn: ["id-Core"],
      }),
      task("Import UI"),
    ];
    expect(boardChanges(current, next)).toEqual([
      { title: "shell ", change: "changed", fields: ["objective"] },
      { title: "Import UI", change: "added", fields: [] },
      { title: "Docs", change: "removed", fields: [] },
    ]);
  });

  it("ignores repair findings appended to a brief", () => {
    const current = [
      task("Core", { workerPrompt: "Implement Core\n\nRepair findings from review:\nFix x" }),
    ];
    expect(boardChanges(current, [task("Core")])).toEqual([]);
  });
});
