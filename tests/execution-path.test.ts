import { taskExecutionView } from "@shared/project-status";
import { describe, expect, it } from "vitest";

const connection = {
  roles: {
    interactive: {
      profileId: "interactive-id",
      profileName: "vega-general",
      source: "interactive" as const,
    },
    snippet: {
      profileId: "snippet-id",
      profileName: "tiny-fim",
      source: "interactive" as const,
    },
  },
};

describe("execution path contract", () => {
  it("shows the route and mapped profile before approval", () => {
    expect(taskExecutionView({ difficulty: "large" }, connection)).toEqual({
      title: "Interactive — vega-general",
      detail: "Edits the active project workspace locally. Source is not uploaded.",
    });
    expect(taskExecutionView({ difficulty: "small", route: "snippet" }, connection)).toEqual({
      title: "Snippet — tiny-fim",
      detail: "Uses the snippet/FIM role for a tiny completion.",
    });
  });

  it("shows a task saved by a version that ran Poundlock jobs as interactive", () => {
    expect(
      taskExecutionView({ difficulty: "small", route: "durable" as never }, connection),
    ).toMatchObject({ title: "Interactive — vega-general" });
  });
});
