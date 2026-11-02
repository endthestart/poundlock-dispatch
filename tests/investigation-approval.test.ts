/**
 * One approval per investigation. An interview's read-only investigation
 * asked separately for `node --version` and `npm --version`, and waited an hour
 * for its owner. Its sandbox keeps every command read-only, so the first
 * approval covers the rest; a worker that can change files still asks each time.
 */

import type { WorkerContext } from "@core/interactive-worker";
import { runHostCommand } from "@runtime/host-command";
import { INVESTIGATION_APPROVAL, workerHostContext } from "@runtime/pi-worker";
import type { RunCommandInput } from "@runtime/run-command";
import { defaultBudget, defaultPolicy, type ProjectRecord } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

async function worker(readOnly: boolean) {
  const root = await tempDir("investigation-approval-");
  const project = {
    id: "project",
    name: "Example",
    archived: false,
    createdAt: "now",
    updatedAt: "now",
    status: "draft",
    source: { kind: "local_folder", originalPath: root, baseRevision: "", excludedPatterns: [] },
    policy: defaultPolicy(),
    budget: defaultBudget(),
    integration: {},
    planRevision: 0,
    workflowId: "wf",
    managerSessionId: "mgr",
  } as ProjectRecord;
  const reasons: string[] = [];
  const ctx = {
    project,
    task: { id: "task", objective: "Which Node is installed?" },
    cwd: root,
    dataDir: `${root}-data`,
    trust: "ask",
    allowDependencyDownloads: false,
    signal: new AbortController().signal,
    readOnly,
    approvals: {
      request: async (input: { reason: string }) => {
        reasons.push(input.reason);
        return true;
      },
    },
  } as unknown as WorkerContext;
  const host = await workerHostContext(ctx);
  const ran: string[] = [];
  const run = (input: RunCommandInput) =>
    runHostCommand(input, {
      ...host,
      qualifySandbox: async () => ({ available: true, runtime: "sandbox-exec" }),
      execute: async (command) => {
        ran.push(command.requestedProgram);
        return { exitCode: 0, output: "ok" };
      },
    });
  return { reasons, ran, run };
}

const version = (program: string): RunCommandInput => ({
  program,
  arguments: ["--version"],
  capability: "inspect",
  effect: "inspect",
});

describe("an investigation's command approvals", () => {
  it("asks once, saying the approval covers the investigation's other commands", async () => {
    const investigation = await worker(true);
    await investigation.run(version("ls"));
    await investigation.run(version("cat"));
    expect(investigation.ran).toEqual(["ls", "cat"]);
    expect(investigation.reasons).toHaveLength(1);
    expect(investigation.reasons[0]).toContain(INVESTIGATION_APPROVAL);
  });

  it("still asks for each command of a worker that can change files", async () => {
    const task = await worker(false);
    await task.run(version("ls"));
    await task.run(version("cat"));
    expect(task.ran).toEqual(["ls", "cat"]);
    expect(task.reasons).toHaveLength(2);
    expect(task.reasons.join(" ")).not.toContain(INVESTIGATION_APPROVAL);
  });
});
