/**
 * The check after a passing task: its tests against its criteria, on the run's local model.
 * Scoped so: asked to judge facts too, a local model called correct coordinates wrong.
 */

import { createTaskCheck, parseGaps, taskCheckPrompt } from "@runtime/task-check";
import { describe, expect, it } from "vitest";

const input = {
  title: "Night planner",
  acceptanceCriteria: "London on 2024-06-21 has no dark span.",
  changed: ["src/night.ts", "tests/night.test.ts"],
  tests: [{ path: "tests/night.test.ts", text: "expect(plan.darkStart).not.toBeNull();" }],
};

describe("the task check", () => {
  it("puts the criteria and the tests in front of the model, and nothing to fetch", () => {
    const prompt = taskCheckPrompt(input);
    expect(prompt).toContain("has no dark span");
    expect(prompt).toContain("expect(plan.darkStart).not.toBeNull();");
    expect(prompt).toContain("src/night.ts");
    expect(taskCheckPrompt({ ...input, tests: [] })).toContain("as they now stand: none");
  });

  it("reads the gaps from a reply, at most four, and refuses a reply without them", () => {
    expect(parseGaps('{"gaps": []}')).toEqual([]);
    expect(parseGaps('Here: {"gaps": ["a", "", "b", "c", "d", "e"]}')).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(() => parseGaps("I'll start by exploring the project.")).toThrow();
    expect(() => parseGaps('{"verdict": "ok"}')).toThrow();
  });

  it("never sends a task to a model off the operator's network", async () => {
    const offsite = { id: "frontier", dataDestination: "external" as const };
    expect(
      createTaskCheck({ controllerUrl: "http://x", token: "t", model: offsite }),
    ).toBeUndefined();
    const asked: Array<{ model: string }> = [];
    const check = createTaskCheck({
      controllerUrl: "http://x/",
      token: "t",
      model: { id: "local", dataDestination: "operator_network" },
      fetch: (async (_url: string, init: RequestInit) => {
        asked.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"gaps": ["no dark span test"]}' } }],
          }),
        );
      }) as unknown as typeof fetch,
    });
    expect(await check?.(input, new AbortController().signal)).toEqual(["no dark span test"]);
    expect(asked[0].model).toBe("local");
  });
});
