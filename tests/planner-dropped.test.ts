/**
 * A dropped connection does not end a Planner call: it only reads, so it is asked again in the
 * same session. A reset connection ended a replay of BM-D's review four minutes in (2 Nov), and
 * in a run the same error stops planning for the night.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlannerSpec } from "@core/goal/planner-prompts";
import { autoProject } from "@runtime/auto-session";
import { createPlanner, isDroppedConnection, PlannerError } from "@runtime/planner";
import type { Milestone } from "@shared/types";
import { afterAll, expect, it } from "vitest";
import { callsSinceLastUser, fakePoundlock, type ScriptedTurn } from "./support/fake-poundlock";
import { tempDir } from "./support/temp-dir";

const servers: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

const M1: Milestone = { id: "M1", title: "Skeleton", goal: "import", requirementIds: ["R1"] };
const spec: PlannerSpec = {
  summary: "A photo library",
  checks: ["npm test"],
  milestones: [M1],
  requirements: [{ id: "R1", text: "Import", scenarios: ["the grid fills"], status: "open" }],
};
const planned = {
  tasks: [
    {
      title: "Import",
      objective: "Import a folder",
      acceptanceCriteria: "A test imports a folder and the grid shows its photos",
      requirementIds: ["R1"],
    },
  ],
  verdicts: [],
  complete: false,
};

async function plannerAfter(drops: number) {
  const worktree = await tempDir("dropped-work-");
  await writeFile(join(worktree, "README.md"), "# Library\n");
  let dropped = 0;
  const server = await fakePoundlock({
    respond: (request): ScriptedTurn => {
      const calls = callsSinceLastUser(request);
      if (calls.includes("submit")) return { text: "Submitted." };
      if (!JSON.stringify(request.messages).includes("# Library"))
        return { toolCalls: [{ name: "read", arguments: { path: "README.md" } }] };
      if (dropped++ < drops) return { drop: true };
      return { toolCalls: [{ name: "submit", arguments: planned }] };
    },
  });
  servers.push(server);
  const activity: string[] = [];
  const planner = createPlanner({
    controllerUrl: server.url,
    token: server.token,
    model: {
      id: "gate-model",
      profileId: "p-gate",
      context_tokens: 131_072,
      max_output_tokens: 8192,
      dataDestination: "operator_network",
      routingRevision: "r1",
    },
    worktree,
    project: autoProject({
      runId: "r",
      worktree,
      baseCommit: "0",
      createdAt: new Date().toISOString(),
      checks: [],
      protectedPaths: [],
    }),
    dir: await tempDir("dropped-dir-"),
    onActivity: (text) => activity.push(text),
  });
  return { planner, server, activity };
}

it("asks again in the same session when the connection drops, keeping what it read", async () => {
  const { planner, server, activity } = await plannerAfter(2);
  const answer = await planner.planMilestone({ spec, milestone: M1, done: [] });
  expect(answer.tasks.map((task) => task.title)).toEqual(["Import"]);
  expect(activity.filter((text) => text.includes("dropped the connection"))).toHaveLength(2);
  const last = server.requests.at(-1);
  expect(JSON.stringify(last?.messages)).toContain("The connection dropped before your reply");
});

it("gives up after two drops in one call, as a provider that stays down must stop", async () => {
  const { planner } = await plannerAfter(3);
  const failure = await planner.planMilestone({ spec, milestone: M1, done: [] }).catch((e) => e);
  expect(failure).toBeInstanceOf(PlannerError);
  expect(isDroppedConnection(failure.message)).toBe(true);
});

it("knows a dropped connection from a refusal", () => {
  expect(
    isDroppedConnection(
      `ambiguous_inference: The provider stream ended after execution may have started (500: {"type":"upstream_error"}).`,
    ),
  ).toBe(true);
  expect(isDroppedConnection("Connection error.")).toBe(true);
  expect(isDroppedConnection("403: Budget limit exceeded (weekly limit).")).toBe(false);
  expect(isDroppedConnection("The worker model returned an error.")).toBe(false);
});
