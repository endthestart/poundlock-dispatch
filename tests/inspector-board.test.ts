import { classifyAttemptFailure, isInterruptAttempt } from "@core/failure-class";
import {
  classifyBoardWrite,
  mergeSectionItems,
  retainTaskIdentity,
  taskIdentity,
  tasksSectionState,
  upsertSectionItems,
} from "@core/inspector-board";
import type { TaskRecord } from "@shared/types";
import { describe, expect, it } from "vitest";

function task(title: string, extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: `task-${title}`,
    title,
    objective: title,
    workerPrompt: title,
    acceptanceCriteria: title,
    dependsOn: [],
    difficulty: "small",
    contextNote: "",
    status: "ready",
    repairCount: 0,
    attempts: [],
    ...extra,
  };
}

describe("inspector board writes", () => {
  it("publishes into an empty section and stages manager replacements of a live section", () => {
    expect(
      classifyBoardWrite({
        source: "manager",
        kind: "replace",
        published: { empty: true, terminal: false },
      }),
    ).toBe("publish");
    expect(
      classifyBoardWrite({
        source: "manager",
        kind: "replace",
        published: { empty: false, terminal: false },
      }),
    ).toBe("amend");
    expect(
      classifyBoardWrite({
        source: "manager",
        kind: "replace",
        published: { empty: false, terminal: true },
      }),
    ).toBe("publish");
  });

  it("merges user upserts and never treats progress as a replacement", () => {
    expect(
      classifyBoardWrite({
        source: "user",
        kind: "upsert",
        published: { empty: false, terminal: false },
      }),
    ).toBe("merge");
    expect(
      classifyBoardWrite({
        source: "runtime",
        kind: "progress",
        published: { empty: false, terminal: false },
      }),
    ).toBe("progress");
  });

  it("treats a finished run as terminal so a new plan can publish", () => {
    expect(tasksSectionState([{ status: "applied" }, { status: "cancelled" }], "running")).toEqual({
      empty: false,
      terminal: true,
    });
    expect(tasksSectionState([{ status: "ready" }], "cancelled").terminal).toBe(true);
    expect(tasksSectionState([{ status: "needs_review" }], "planning", true).terminal).toBe(true);
    expect(tasksSectionState([{ status: "ready" }], "running").terminal).toBe(false);
  });

  it("keeps published identity when a proposed section is applied or upserted", () => {
    const published = [
      task("One", {
        attempts: [{ id: "a1" } as TaskRecord["attempts"][number]],
        status: "needs_review",
      }),
      task("Two"),
    ];
    const proposed = [task("One", { id: "new-one" }), task("Three", { id: "new-three" })];
    const merged = mergeSectionItems(published, proposed, taskIdentity, retainTaskIdentity);
    expect(merged.map((item) => item.id)).toEqual(["task-One", "new-three"]);
    expect(merged[0].attempts).toHaveLength(1);
    expect(merged[0].status).toBe("needs_review");
    const upserted = upsertSectionItems(
      published,
      [task("Three")],
      taskIdentity,
      retainTaskIdentity,
    );
    expect(upserted.map((item) => item.title)).toEqual(["One", "Two", "Three"]);
  });

  it("keeps a task's test flags when a proposal restates it without them", () => {
    const published = [task("Tests", { writesTests: true, filesToTouch: ["tests/a.rs"] })];
    const [kept] = mergeSectionItems(published, [task("Tests")], taskIdentity, retainTaskIdentity);
    expect(kept.writesTests).toBe(true);
    expect(kept.filesToTouch).toEqual(["tests/a.rs"]);
    const [changed] = mergeSectionItems(
      published,
      [task("Tests", { writesTests: false, changesFrozenTests: true })],
      taskIdentity,
      retainTaskIdentity,
    );
    expect(changed).toMatchObject({ writesTests: false, changesFrozenTests: true });
  });
});

describe("interrupt classification", () => {
  it("does not treat pause or abort as implementation failure", () => {
    expect(classifyAttemptFailure({ error: "Worker interrupted." })).toBe("infrastructure");
    expect(classifyAttemptFailure({ error: "Request was aborted" })).toBe("infrastructure");
    expect(isInterruptAttempt({ status: "paused", error: "Worker interrupted." })).toBe(true);
    expect(
      classifyAttemptFailure({ error: "Tool approval denied or cancelled. Worker stopped." }),
    ).toBe("policy");
    expect(
      classifyAttemptFailure({
        error:
          "Interactive worker reached the 45-minute attempt limit. Folder changes are retained. Request a recovery to continue this worker session.",
      }),
    ).toBe("infrastructure");
    expect(
      isInterruptAttempt({
        error:
          "Interactive worker reached the 45-minute attempt limit. Folder changes are retained. Request a recovery to continue this worker session.",
      }),
    ).toBe(true);
    expect(
      isInterruptAttempt({
        error: "Tool approval denied or cancelled. Worker stopped.",
      }),
    ).toBe(false);
  });
});
