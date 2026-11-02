/**
 * A gating review judges every requirement afresh. BM-D attempt 5's last review read 2 files,
 * passed "show when each target rises, transits and sets" on what earlier reviews had said, and
 * the product left those values blank for every event outside the night.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { milestoneReviewPrompt, type PlannerSpec } from "@core/goal/planner-prompts";
import { reviewDepthProblems } from "@core/goal/review-depth";
import { autoProject } from "@runtime/auto-session";
import { createPlanner } from "@runtime/planner";
import type { Milestone, Requirement } from "@shared/types";
import { afterAll, expect, it } from "vitest";
import {
  type ChatRequest,
  callsSinceLastUser,
  fakePoundlock,
  messageText,
} from "./support/fake-poundlock";
import { tempDir } from "./support/temp-dir";

const servers: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

const R3: Requirement = {
  id: "R3",
  text: "Show when each target rises, transits and sets",
  scenarios: ["Sirius transits at 73.3 degrees", "12 targets give a row each, inside the night"],
  status: "open",
  verdict: {
    result: "shown",
    note: "tests/events.test.ts checks Sirius",
    advisory: false,
    at: "t",
  },
};
const M1: Milestone = { id: "M1", title: "Planner", goal: "plan", requirementIds: ["R3"] };
const spec: PlannerSpec = {
  summary: "A sky planner",
  checks: ["npm test"],
  milestones: [M1],
  requirements: [R3],
  acceptanceFirst: true,
};
const earned = {
  requirementId: "R3",
  result: "shown" as const,
  note: "All checked",
  scenarios: [
    { scenario: 1, files: ["tests/events.test.ts"], finding: "expects 73.3 to 0.5" },
    { scenario: 2, files: ["e2e/night.spec.ts"], finding: "12 rows inside the night" },
  ],
  promises: [
    { promise: "rises, transits and sets", files: ["src/plan.ts"], finding: "all three, always" },
  ],
};
const answer = (verdict: object) => ({ tasks: [], verdicts: [verdict], complete: true }) as never;

it("takes a shown verdict only with this answer's own check of each scenario and promise", () => {
  const read =
    (...files: string[]) =>
    (path: string) =>
      files.includes(path);
  const all = read("tests/events.test.ts", "e2e/night.spec.ts", "src/plan.ts");
  expect(reviewDepthProblems(answer(earned), [R3], all)).toEqual([]);

  // Attempt 5's last review: a note, and nothing read.
  const noted = answer({
    requirementId: "R3",
    result: "shown",
    note: "e2e/night.spec.ts covers it",
  });
  expect(reviewDepthProblems(noted, [R3], read())).toEqual([
    "R3 is shown but gives no check of scenario 1.",
    "R3 is shown but gives no check of scenario 2.",
    "R3 is shown but lists none of its promises.",
    "Read what is missing and say what you found, or call that requirement partly.",
  ]);

  // Citing what it never opened does not count; nor does a promise it did not look into.
  expect(
    reviewDepthProblems(answer(earned), [R3], read("tests/events.test.ts", "src/plan.ts")),
  ).toContain("R3 scenario 2 cites e2e/night.spec.ts, not read in this answer.");
  const unfound = {
    ...earned,
    promises: [{ promise: "sets", files: ["src/plan.ts"], finding: " " }],
  };
  expect(reviewDepthProblems(answer(unfound), [R3], all)).toContain(
    "R3's promise “sets” does not say what you found.",
  );

  // Only a shown verdict has to earn it: partly plans the work anyway.
  expect(
    reviewDepthProblems(answer({ requirementId: "R3", result: "partly", note: "n" }), [R3], read()),
  ).toEqual([]);
});

it("asks a gating review to start over, with no earlier shown to lean on", () => {
  const prompt = milestoneReviewPrompt(spec, M1, ["Events"]);
  expect(prompt).toContain("Every review starts over.");
  expect(prompt).toContain("S2: 12 targets give a row each, inside the night");
  expect(prompt).not.toContain("Last review");
  // What an earlier review found missing still helps it check the gap was closed.
  const open = {
    ...R3,
    verdict: { result: "partly" as const, note: "no browser test", advisory: false, at: "t" },
  };
  expect(milestoneReviewPrompt({ ...spec, requirements: [open] }, M1, [])).toContain(
    "Last review: partly (no browser test)",
  );
  // A Planner whose verdicts do not gate is left as it was.
  const advisory = milestoneReviewPrompt({ ...spec, acceptanceFirst: false }, M1, []);
  expect(advisory).not.toContain("Every review starts over.");
  expect(advisory).toContain("Last review: shown");
});

it("sends back a review that passes a requirement without reading it, and takes its correction", async () => {
  const worktree = await tempDir("depth-work-");
  await promisify(execFile)("git", ["init", "-q", worktree]);
  await mkdir(join(worktree, "tests"));
  await mkdir(join(worktree, "e2e"));
  await mkdir(join(worktree, "src"));
  await writeFile(join(worktree, "tests/events.test.ts"), "// Sirius\n");
  await writeFile(join(worktree, "e2e/night.spec.ts"), "// 12 rows\n");
  await writeFile(join(worktree, "src/plan.ts"), "// inside the night only\n");
  const lastUser = (request: ChatRequest) =>
    messageText(request.messages.filter((m) => m.role === "user").at(-1) ?? {});
  const submit = (args: Record<string, unknown>) => ({
    toolCalls: [{ name: "submit", arguments: args }],
  });
  const reads = (request: ChatRequest) => JSON.stringify(request.messages).includes("night only");
  const server = await fakePoundlock({
    respond: (request) => {
      if (callsSinceLastUser(request).includes("submit")) return { text: "Submitted." };
      // First answer: what attempt 5's last review did. Told to read, it finds the blanks.
      if (!lastUser(request).includes("cannot be used"))
        return submit({
          tasks: [],
          verdicts: [{ requirementId: "R3", result: "shown", note: "e2e/night.spec.ts" }],
          complete: true,
        });
      if (!reads(request))
        return { toolCalls: [{ name: "read", arguments: { path: "src/plan.ts" } }] };
      return submit({
        tasks: [
          {
            title: "Report every event",
            objective: "Report events outside the night",
            acceptanceCriteria: "A target that rises before sunset shows its rise",
            requirementIds: ["R3"],
            acceptanceTests: [],
          },
        ],
        verdicts: [
          { requirementId: "R3", result: "partly", note: "src/plan.ts leaves them blank" },
        ],
        complete: false,
      });
    },
  });
  servers.push(server);
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
    dir: await tempDir("depth-dir-"),
  });
  const reviewed = await planner.reviewMilestone({ spec, milestone: M1, accepted: ["Events"] });
  expect(reviewed.complete).toBe(false);
  expect(reviewed.verdicts[0].result).toBe("partly");
  const corrected = server.requests.find((request) => lastUser(request).includes("cannot be used"));
  expect(lastUser(corrected!)).toContain("R3 is shown but gives no check of scenario 1.");
});
