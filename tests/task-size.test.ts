import { isTestPath, oversizeReason, taskSizeNotes } from "@core/task-size";
import { describe, expect, it } from "vitest";

const task = (overrides: Record<string, unknown> = {}) => ({
  title: "Build the importer",
  difficulty: "medium",
  taskKind: "closed_implementation",
  filesToTouch: ["src/import.rs", "src/catalog.rs"],
  ...overrides,
});

describe("soft task size", () => {
  it("leaves a named, modest task alone", () => {
    expect(oversizeReason(task())).toBeUndefined();
    expect(taskSizeNotes([task()])).toBe("");
  });

  it("counts only files with new logic", () => {
    const files = [
      "a.rs",
      "b.rs",
      "c.rs",
      "d.rs",
      "e.rs",
      "tests/a.rs",
      "src/x.test.ts",
      "test_y.py",
    ];
    expect(oversizeReason(task({ filesToTouch: files }))).toBeUndefined();
    expect(isTestPath("crates/core/tests/import.rs")).toBe(true);
    expect(isTestPath("src/contest.rs")).toBe(false);
  });

  it("notes large tasks, too many files, and tasks that name no files, without blocking", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((name) => `src/${name}.rs`);
    expect(oversizeReason(task({ difficulty: "large" }))).toBe("is marked large");
    expect(oversizeReason(task({ filesToTouch: six }))).toMatch(/names 6 files with new logic/);
    // Naming no files earns a note when proposed, never a split.
    expect(oversizeReason(task({ filesToTouch: [] }))).toBeUndefined();
    const notes = taskSizeNotes([
      task({ title: "Big", difficulty: "large" }),
      task({ title: "Vague", filesToTouch: undefined }),
    ]);
    expect(notes).toMatch(/not blocking/);
    expect(notes).toContain("“Big” is marked large");
    expect(notes).toContain("“Vague” names no files");
  });

  it("never sizes investigations, plans or snippets", () => {
    expect(taskSizeNotes([task({ taskKind: "open_investigation", difficulty: "large" })])).toBe("");
    expect(taskSizeNotes([task({ route: "snippet", filesToTouch: [] })])).toBe("");
  });
});
