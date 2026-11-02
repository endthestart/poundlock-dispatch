/**
 * `/task <number> [attempt]`: a task's evidence in the terminal, the fields
 * and the outputs the app's task details open, for the attempt asked for.
 */
import type { TaskRecord } from "@shared/types";
import { PLAIN } from "@tui/colour";
import { pickTask, renderTaskEvidence } from "@tui/task-evidence";
import { describe, expect, it } from "vitest";

const PATCH = "--- a/src/survey.py\n+++ b/src/survey.py\n@@ -1 +1 @@\n-old\n+new";

const task = {
  id: "t1",
  title: "Summarise vendors",
  objective: "Print one line per vendor.",
  status: "repairing",
  repairCount: 1,
  recoveryCount: 0,
  attempts: [
    { id: "a1", number: 1, status: "failed", profileName: "orion-fast", error: "Timed out" },
    {
      id: "a2",
      number: 2,
      status: "completed",
      profileName: "orion-fast",
      execution: "interactive",
      dataDestination: "operator_network",
      result: {
        patches: [{ patch: PATCH }],
        output: "Added the vendor table.",
        verification: {
          status: "failed",
          reason: "1 test failed",
          commands: [{ command: "python -m unittest", exitCode: 1, output: "FAIL: test_order" }],
        },
      },
      review: { nextAttempt: 3, decision: "repair", reason: "Sort ties by name." },
    },
  ],
} as unknown as TaskRecord;

describe("task evidence", () => {
  it("shows the newest attempt's facts, check output, report and diff", () => {
    const text = renderTaskEvidence(pickTask([task], "1"), 2, 100, PLAIN).join("\n");
    expect(text).toContain("Print one line per vendor.");
    expect(text).toContain("1 · Failed, 2 · ");
    expect(text).toContain("showing 2");
    expect(text).toContain("src/survey.py");
    expect(text).toContain("failed — 1 test failed");
    expect(text).toContain("Requested attempt 3 (repair): Sort ties by name.");
    expect(text).toContain("1 of 2 sent back by Dispatch");
    expect(text).toContain("python -m unittest · exit 1\nFAIL: test_order");
    expect(text).toContain("Worker report\nAdded the vendor table.");
    expect(text).toContain("Diff\n--- a/src/survey.py");
    expect(text).toContain("+new");
  });

  it("opens an earlier attempt by number, and refuses one that is not there", () => {
    const text = renderTaskEvidence(pickTask([task], "1 1"), 2, 100, PLAIN).join("\n");
    expect(text).toContain("Error: Timed out");
    expect(text).not.toContain("Worker report");
    expect(() => pickTask([task], "1 7")).toThrow("Task 1 has no attempt 7; it has 2.");
    expect(() => pickTask([task], "4")).toThrow("There is no task 4; the board has 1.");
    expect(() => pickTask([task], "one")).toThrow(/^Usage: \/task/);
  });
});
