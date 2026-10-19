/**
 * A goal end to end in the runner (ADR 016): the manager's M1 task runs, the
 * Planner reviews M1, plans M2, its task runs, the Planner reviews M2, and
 * the run ends with every milestone verified, the board and ledger updated.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AutoLedger } from "@core/auto/ledger";
import { AutoPaths, readRunFile } from "@core/auto/runs";
import { startAutoRun } from "@core/auto/start";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import type { PlanRecord, TaskRecord } from "@shared/types";
import { afterAll, expect, it } from "vitest";
import { runAuto } from "../src/tui/auto";
import { fakeDocker } from "./support/fake-docker";
import {
  type ChatRequest,
  callsSinceLastUser,
  fakePoundlock,
  messageText,
  type ScriptedTurn,
} from "./support/fake-poundlock";
import { tempDir } from "./support/temp-dir";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

const servers: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

const lastUser = (request: ChatRequest) =>
  messageText(request.messages.filter((m) => m.role === "user").at(-1) ?? {});
const firstUser = (request: ChatRequest) =>
  messageText(request.messages.find((m) => m.role === "user") ?? {});

/** The Planner answers through submit; a worker writes one file and finishes. */
function script(request: ChatRequest): ScriptedTurn {
  const calls = callsSinceLastUser(request);
  if (messageText(request.messages[0]).includes("You are the Planner")) {
    if (calls.includes("submit")) return { text: "Submitted." };
    const ask = firstUser(request);
    const verdict = (id: string) => ({
      requirementId: id,
      result: "shown",
      note: `test for ${id}`,
    });
    const answer = ask.includes("Plan milestone M2")
      ? {
          tasks: [
            {
              title: "Stars",
              objective: "Rate photos",
              acceptanceCriteria: "A test rates a photo and sees its stars",
              requirementIds: ["R2"],
            },
          ],
          verdicts: [],
          complete: false,
        }
      : ask.includes("Review milestone M1")
        ? { tasks: [], verdicts: [verdict("R1")], complete: true }
        : { tasks: [], verdicts: [verdict("R2")], complete: true };
    return { toolCalls: [{ name: "submit", arguments: answer }] };
  }
  const file = /Stars/.test(lastUser(request)) ? "stars.txt" : "import.txt";
  return calls.length === 0
    ? { toolCalls: [{ name: "write", arguments: { path: file, content: "ok\n" } }] }
    : { toolCalls: [{ name: "finish_case", arguments: { status: "done", summary: "done" } }] };
}

it("works a goal milestone by milestone until every one is verified", async () => {
  const source = await realpath(await tempDir("goal-src-"));
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "README.md"), "base\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  const store = new FileStore(await tempDir("goal-store-"), await tempDir("goal-config-"));
  await store.init();
  const project = await createFolderProject({ store, folder: source });
  const plan: PlanRecord = {
    revision: 1,
    summary: "A photo library",
    acceptanceCriteria: ["Import and rate"],
    authority: "",
    approved: true,
    createdAt: new Date().toISOString(),
    verificationCommands: ["true"],
    requirements: [
      { id: "R1", text: "Import", scenarios: ["the grid shows photos"], status: "open" },
      { id: "R2", text: "Rate", scenarios: ["stars stick"], status: "open" },
    ],
    milestones: [
      { id: "M1", title: "Skeleton", goal: "import", requirementIds: ["R1"] },
      { id: "M2", title: "Rate", goal: "rate", requirementIds: ["R2"] },
    ],
  };
  await store.savePlan(project.id, plan);
  await store.saveTasks(project.id, [
    {
      id: "T1",
      title: "Import",
      objective: "Import a folder",
      workerPrompt: "Import a folder",
      acceptanceCriteria: "A test imports and sees the grid",
      dependsOn: [],
      difficulty: "small",
      contextNote: "",
      status: "ready",
      repairCount: 0,
      attempts: [],
      requirementIds: ["R1"],
      milestoneId: "M1",
    } as TaskRecord,
  ]);
  const server = await fakePoundlock({ respond: script });
  servers.push(server);
  const docker = await fakeDocker(["toolchain:test"]);
  const paths = new AutoPaths(await realpath(await tempDir("goal-data-")));
  const home = await tempDir("goal-home-");
  await mkdir(paths.root, { recursive: true });
  const connection = async () => ({
    url: server.url,
    token: server.token,
    // A bound Verifier on the operator's network: the Planner, and its verdicts gate.
    roles: {
      verifier: { profileId: "p-gate", profileName: "gate-model", source: "interactive" as const },
    },
    profiles: {},
  });
  const spawned: string[] = [];
  const { runDir, run } = await startAutoRun(
    { dir: source, image: "toolchain:test", profile: "gate-model", goal: { checkpoint: "notify" } },
    {
      paths,
      connection,
      project: async () => ({ project, store }),
      spawnRunner: (dir) => void spawned.push(dir),
      docker: docker.docker,
      dockerEnv: docker.env,
      freeBytes: async () => 100 * 1024 ** 3,
      home,
    },
  );
  expect(run.goal).toEqual({
    checkpoint: "notify",
    planner: {
      model: "gate-model",
      profileId: "p-gate",
      routingRevision: "r1",
      destination: "operator_network",
    },
    advisory: false,
  });
  // A repository with only a README: nothing to check at the base.
  expect(run.greenfield).toBe(true);
  const output: string[] = [];
  const code = await runAuto(["run", runDir], {
    paths,
    connection,
    project: async () => undefined,
    entry: "unused",
    io: { out: (text) => output.push(text), err: (text) => output.push(text) },
    docker: docker.docker,
    dockerEnv: docker.env,
    runner: { keepAwake: false, heartbeatMs: 50, controlPollMs: 20 },
    home,
  });
  const state = await new AutoLedger(runDir).state();
  expect({ code, outcome: state.outcome, reason: state.endReason }).toEqual({
    code: 0,
    outcome: "objective_met",
    reason: "every milestone verified (M1, M2)",
  });
  expect(state.milestones?.map((item) => [item.id, item.stage, item.reviews])).toEqual([
    ["M1", "done", 1],
    ["M2", "done", 1],
  ]);
  // The Planner's task joined the board under M2, and the ledger holds both verdicts.
  const tasks = await store.getTasks(project.id);
  expect(tasks.map((task) => [task.title, task.milestoneId])).toEqual([
    ["Import", "M1"],
    ["Stars", "M2"],
  ]);
  expect(tasks[1].workerPrompt).toContain("Owner requirements this task serves:\n- R2: Rate");
  const ledger = (await store.getPlan(project.id))?.requirements;
  expect(ledger?.map((item) => [item.id, item.verdict?.result])).toEqual([
    ["R1", "shown"],
    ["R2", "shown"],
  ]);
  expect(state.cases.map((item) => [item.title, item.stage])).toEqual([
    ["Import", "accepted"],
    ["Stars", "accepted"],
  ]);
  expect((await readRunFile(runDir)).limits.maxCases).toBe(400);
  const report = await readFile(join(runDir, "report.md"), "utf8");
  expect(report).toContain(`# Autopilot run ${run.runId}: every case verified (not reviewed)`);
  expect(report).toContain("- **R2** Rate — shown: test for R2");
  expect(report).toContain("- **M2 Rate**: verified");
  expect(report).toContain("None of this work was reviewed by a person.");
}, 60_000);
