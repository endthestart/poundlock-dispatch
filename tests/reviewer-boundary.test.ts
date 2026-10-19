/**
 * M6: the approval reviewer answers only for a command that will run inside
 * the sandbox and is not destructive. Anything else goes to the user, even
 * when the reviewer would allow it.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApprovalBroker } from "@core/approval-broker";
import type { WorkerContext } from "@core/interactive-worker";
import type { ReviewRequest } from "@core/permission-review";
import { runHostCommand } from "@runtime/host-command";
import { workerHostContext } from "@runtime/pi-worker";
import type { SandboxQualification } from "@runtime/sandbox";
import type { ToolApproval } from "@shared/permissions";
import { defaultBudget, defaultPolicy, type ProjectRecord } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

function project(root: string): ProjectRecord {
  return {
    id: "project",
    name: "Example",
    archived: false,
    createdAt: "now",
    updatedAt: "now",
    status: "draft",
    source: {
      kind: "local_folder",
      originalPath: root,
      capturedAt: "now",
      snapshotSha256: "",
      baseRevision: "",
      includedFiles: 0,
      includedBytes: 0,
      excludedPatterns: [],
      includedUncommitted: true,
      originalFingerprint: "",
    },
    policy: defaultPolicy(),
    budget: defaultBudget(),
    integration: { headRevision: "", expectedBase: "", appliedPatchSha256: [] },
    planRevision: 1,
    managerSessionId: "manager",
    eventCursor: 0,
  };
}

async function setup(sandbox: SandboxQualification, userAnswer: boolean) {
  const root = await tempDir("dispatch-m6-");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, "scratch.txt"), "x");
  const reviewed: ReviewRequest[] = [];
  const asked: ToolApproval[] = [];
  const ran: string[][] = [];
  const context = {
    project: project(projectRoot),
    task: {
      id: "task_1",
      title: "Task",
      objective: "Tidy the project",
      workerPrompt: "Tidy.",
      acceptanceCriteria: "",
      dependsOn: [],
      difficulty: "small",
      contextNote: "",
      status: "ready",
      repairCount: 0,
      attempts: [],
    },
    cwd: projectRoot,
    projectRoot,
    dataDir: join(root, "data"),
    privateHome: join(root, "home"),
    trust: "assist",
    allowDependencyDownloads: false,
    signal: new AbortController().signal,
    reviewAction: async (request: ReviewRequest) => {
      reviewed.push(request);
      return { decision: "allow" as const, reason: "Looks like ordinary development." };
    },
    approvals: {
      request: async (view: ToolApproval) => {
        asked.push(view);
        return userAnswer;
      },
    } as unknown as ApprovalBroker,
  } as unknown as WorkerContext;
  const host = await workerHostContext(context, {
    qualifySandbox: async () => sandbox,
    execute: async (command) => {
      ran.push([command.executable, ...command.arguments]);
      return { exitCode: 0, output: "ok" };
    },
  });
  return { root, projectRoot, host, reviewed, asked, ran };
}

const SANDBOX: SandboxQualification = { available: true, runtime: "sandbox-exec" };
const NO_SANDBOX: SandboxQualification = {
  available: false,
  runtime: "sandbox-exec",
  reason: "The sandbox network probe is unavailable because /usr/bin/nc is missing.",
};

describe("approval reviewer boundary", () => {
  it("ignores the reviewer when no sandbox is in force, and asks the user", async () => {
    const { host, reviewed, asked, ran } = await setup(NO_SANDBOX, false);
    await expect(
      runHostCommand(
        { program: "true", arguments: [], capability: "test", effect: "inspect" },
        host,
      ),
    ).rejects.toThrow(/denied/);
    expect(reviewed).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0].reason).toContain("/usr/bin/nc is missing");
    expect(ran).toEqual([]);
  });

  it("runs an unsandboxed command only when the user allows it", async () => {
    const { host, reviewed, asked, ran } = await setup(NO_SANDBOX, true);
    await runHostCommand(
      { program: "true", arguments: [], capability: "test", effect: "inspect" },
      host,
    );
    expect(reviewed).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(ran).toHaveLength(1);
    expect(ran[0][0]).not.toBe("/usr/bin/sandbox-exec");
  });

  it("ignores the reviewer for a destructive command, even inside the sandbox", async () => {
    const { host, reviewed, asked, ran } = await setup(SANDBOX, false);
    await expect(
      runHostCommand(
        {
          program: "rm",
          arguments: ["scratch.txt"],
          capability: "arbitrary",
          effect: "project_change",
        },
        host,
      ),
    ).rejects.toThrow(/denied/);
    expect(reviewed).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(ran).toEqual([]);
  });

  it("lets the reviewer decide a sandboxed command, and tells it why it was asked", async () => {
    const { root, host, reviewed, asked, ran } = await setup(SANDBOX, false);
    const tools = join(root, "tools");
    await mkdir(tools);
    const tool = join(tools, "format");
    await writeFile(tool, "#!/bin/sh\nexit 0\n");
    await chmod(tool, 0o700);
    await runHostCommand(
      { program: tool, arguments: [], capability: "build", effect: "project_change" },
      host,
    );
    expect(asked).toEqual([]);
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0].boundary).toEqual({
      sandboxed: true,
      reason:
        "The executable is outside the selected project environment and sanitized host tool paths.",
    });
    expect(ran).toHaveLength(1);
    expect(ran[0][0]).toBe("/usr/bin/sandbox-exec");
  });
});
