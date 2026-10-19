import { collectPipeTable, isPipeTableLine } from "@shared/markdown-table";
import { resolveTaskRoute } from "@shared/types";
import { describe, expect, it } from "vitest";

describe("markdown pipe tables", () => {
  it("keeps rows instead of joining them into one line", () => {
    const lines = [
      "| # | Task | Difficulty |",
      "|---|------|------------|",
      "| 1 | Scaffold Django | small |",
      "| 2 | Build 4 pages | medium |",
    ];
    const table = collectPipeTable(lines, 0);
    expect(table?.headers).toEqual(["#", "Task", "Difficulty"]);
    expect(table?.rows).toEqual([
      ["1", "Scaffold Django", "small"],
      ["2", "Build 4 pages", "medium"],
    ]);
    expect(table?.end).toBe(4);
  });

  it("does not treat ordinary paragraphs as tables", () => {
    expect(isPipeTableLine("Routing: Interactive local sub-agent")).toBe(false);
  });
});

describe("task route defaults", () => {
  it("defaults every task to interactive unless the plan asks for a snippet", () => {
    expect(resolveTaskRoute({ difficulty: "small" })).toBe("interactive");
    expect(resolveTaskRoute({ difficulty: "medium" })).toBe("interactive");
    expect(resolveTaskRoute({ difficulty: "large" })).toBe("interactive");
    expect(resolveTaskRoute({ difficulty: "small", route: "snippet" })).toBe("snippet");
    // A task saved by a version that ran Poundlock jobs runs interactively now.
    expect(resolveTaskRoute({ difficulty: "small", route: "durable" as never })).toBe(
      "interactive",
    );
  });
});
