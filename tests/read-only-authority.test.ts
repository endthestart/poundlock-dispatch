/**
 * An investigation's read-only authority, enforced where tools run rather than
 * asked for in a prompt. A reviewing worker once requested `rm -rf .git/tmp`;
 * in an investigation that is refused, not put to the user.
 */

import { join } from "node:path";
import { type HostCommandContext, runHostCommand } from "@runtime/host-command";
import {
  bashTimeoutSeconds,
  contextBudgetNote,
  evaluateWorkerToolCall,
  INVESTIGATION_TOOL_CALLS,
  projectPolicyExtension,
} from "@runtime/policy-extension";
import type { RunCommandInput } from "@runtime/run-command";
import { buildSandboxRequest } from "@runtime/sandbox-policy";
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
    planRevision: 0,
    workflowId: "wf",
    managerSessionId: "mgr",
    eventCursor: 0,
  } as ProjectRecord;
}

async function context(
  trust: HostCommandContext["trust"],
  overrides: Partial<HostCommandContext> = {},
): Promise<HostCommandContext & { asked: boolean[]; ran: string[][] }> {
  const root = await tempDir("read-only-");
  const home = join(root, "..", `${root.split("/").pop()}-home`);
  const built = await buildSandboxRequest({
    projectRoot: root,
    project: project(root),
    privateHome: home,
    network: "deny",
  });
  const asked: boolean[] = [];
  const ran: string[][] = [];
  return {
    asked,
    ran,
    projectRoot: root,
    extraPath: [],
    privateHome: home,
    trust,
    readOnly: true,
    allowDependencyNetwork: false,
    sandboxRequest: { ...built, writable: [] },
    signal: new AbortController().signal,
    qualifySandbox: async () => ({ available: true, runtime: "sandbox-exec" }),
    authorize: async (_command, { requireUserApproval }) => {
      asked.push(requireUserApproval);
      return "allow";
    },
    execute: async (command) => {
      ran.push([command.executable, ...command.arguments]);
      return { exitCode: 0, output: "ok" };
    },
    ...overrides,
  };
}

const inspect: RunCommandInput = {
  program: "ls",
  arguments: ["-la"],
  capability: "inspect",
  effect: "inspect",
};

describe("read-only commands", () => {
  it("refuses anything but passive inspection without asking, in every mode", async () => {
    for (const trust of ["ask", "assist", "full"] as const)
      for (const input of [
        { ...inspect, capability: "test", effect: "inspect" },
        { ...inspect, effect: "project_change" },
        { program: "rm", arguments: ["-rf", ".git/tmp"], capability: "inspect", effect: "inspect" },
        { program: "sh", arguments: ["-c", "ls"], capability: "inspect", effect: "inspect" },
        {
          program: "npm",
          arguments: ["install"],
          capability: "install_deps",
          effect: "project_change",
        },
      ] as RunCommandInput[]) {
        const ctx = await context(trust);
        await expect(runHostCommand(input, ctx), `${trust} ${input.program}`).rejects.toThrow();
        expect(ctx.asked).toEqual([]);
        expect(ctx.ran).toEqual([]);
      }
  });

  it("runs inspection in a sandbox that cannot write the project, even in Full access", async () => {
    for (const trust of ["assist", "full"] as const) {
      const ctx = await context(trust);
      // Asking for the project's network still gets none in an investigation.
      await runHostCommand({ ...inspect, networkMode: "allow" }, ctx);
      expect(ctx.asked).toEqual([false]);
      const [program, flag, profile] = ctx.ran[0];
      expect([program, flag]).toEqual(["/usr/bin/sandbox-exec", "-p"]);
      expect(profile).not.toContain(`(allow file-write* (subpath "${ctx.projectRoot}"))`);
      expect(profile).toContain("(deny network*)");
    }
  });

  it("points git at git_inspect when the command would be sandboxed", async () => {
    // The sandbox cannot read .git, and Apple's git fails there with an xcrun
    // cache error that a worker read as a broken machine.
    const ctx = await context("assist");
    await expect(
      runHostCommand({ ...inspect, program: "git", arguments: ["log", "-5"] }, ctx),
    ).rejects.toThrow(/Use git_inspect/);
    expect(ctx.ran).toEqual([]);
  });

  it("still asks in Ask mode, which governs shell commands", async () => {
    const ctx = await context("ask");
    await runHostCommand(inspect, ctx);
    expect(ctx.asked).toEqual([true]);
  });

  it("refuses when no sandbox can keep a command from writing", async () => {
    const ctx = await context("full", {
      qualifySandbox: async () => ({
        available: false,
        runtime: "none",
        reason: "no sandbox here",
      }),
    });
    await expect(runHostCommand(inspect, ctx)).rejects.toThrow(/no sandbox can keep/);
    expect(ctx.ran).toEqual([]);
  });
});

describe("read-only tools", () => {
  it("blocks writes, edits and Bash, and allows reads", async () => {
    const root = await tempDir("read-only-tools-");
    const options = {
      projectRoot: root,
      cwd: root,
      project: project(root),
      trust: "full" as const,
      bashEnabled: false,
      readOnly: true,
    };
    for (const [toolName, input] of [
      ["write", { path: "a.txt", content: "x" }],
      ["edit", { path: "a.txt", edits: [] }],
      ["bash", { command: "ls" }],
    ] as const) {
      const result = await evaluateWorkerToolCall(options, {
        toolName,
        toolCallId: toolName,
        input,
      });
      expect(result.block, toolName).toBe(true);
      expect(result.reason).toMatch(/read-only investigation/);
    }
    const read = await evaluateWorkerToolCall(options, {
      toolName: "ls",
      toolCallId: "ls",
      input: { path: "." },
    });
    expect(read.block).toBeFalsy();
  });
});

describe("an investigation's context budget", () => {
  it("says how full the context is once it passes 60%, and to report at 80%", () => {
    const at = (percent: number) => contextBudgetNote({ tokens: 1, contextWindow: 65536, percent });
    expect(at(40)).toBeUndefined();
    expect(at(65)).toMatch(/Context 65% of 65536 tokens used\. Stop gathering soon/);
    expect(at(85)).toMatch(/Write your report now/);
    expect(contextBudgetNote(undefined)).toBeUndefined();
  });
});

describe("an investigation near the end of its context", () => {
  it("gets no more tools, without ending the turn, so its next reply is the report", async () => {
    // A local model read past the 85% note and kept gathering.
    const root = await tempDir("read-only-budget-");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = { on: (name: string, handler: never) => handlers.set(name, handler) };
    const extension = (readOnly: boolean) => {
      handlers.clear();
      projectPolicyExtension({
        projectRoot: root,
        cwd: root,
        project: project(root),
        trust: "assist",
        bashEnabled: false,
        readOnly,
      })(pi as never);
      return handlers.get("tool_call")!;
    };
    const call = { toolName: "ls", toolCallId: "ls", input: { path: "." } };
    const at = (percent: number) => ({
      getContextUsage: () => ({ tokens: 1, contextWindow: 65536, percent }),
    });
    const blocked = (await extension(true)(call, at(90))) as {
      block?: boolean;
      terminate?: boolean;
      reason?: string;
    };
    expect(blocked.block).toBe(true);
    expect(blocked.terminate).toBeUndefined();
    expect(blocked.reason).toMatch(/Write your report now/);
    expect(await extension(true)(call, at(50))).toBeUndefined();
    // Implementation workers compact between turns; the budget stop is not theirs.
    expect(await extension(false)(call, at(95))).toBeUndefined();
  });

  it("lets a worker go on after a refused path, and stops it only on the owner's refusal", async () => {
    // A worker writing a helper to /tmp lost its whole attempt (13 Oct).
    const root = await tempDir("refused-path-");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = { on: (name: string, handler: never) => handlers.set(name, handler) };
    const usage = { getContextUsage: () => ({ tokens: 1, contextWindow: 65536, percent: 10 }) };
    const install = (trust: "ask" | "assist") => {
      handlers.clear();
      projectPolicyExtension({
        projectRoot: root,
        cwd: root,
        project: project(root),
        trust,
        bashEnabled: true,
        authorizeBash: async () => "deny",
      })(pi as never);
      return handlers.get("tool_call")!;
    };
    const outside = (await install("assist")(
      { toolName: "write", toolCallId: "w", input: { path: "/tmp/strip.pl", content: "x" } },
      usage,
    )) as { block?: boolean; terminate?: boolean; reason?: string };
    expect(outside.block).toBe(true);
    expect(outside.reason).toMatch(/outside the attached project/);
    expect(outside.terminate).toBeUndefined();
    // Raw Bash gets run_command's ten-minute ceiling.
    const bash = { toolName: "bash", toolCallId: "t", input: { command: "lldb -o run ./app" } };
    expect(await install("assist")(bash, usage)).toMatchObject({ block: true });
    const full = { ...bash, input: { ...bash.input } as Record<string, unknown> };
    handlers.clear();
    projectPolicyExtension({
      projectRoot: root,
      cwd: root,
      project: project(root),
      trust: "full",
      bashEnabled: true,
    })(pi as never);
    await handlers.get("tool_call")!(full, usage);
    expect(full.input.timeout).toBe(600);
    expect(bashTimeoutSeconds(30)).toBe(30);
    expect(bashTimeoutSeconds(7200)).toBe(600);
    const refused = (await install("ask")(
      { toolName: "bash", toolCallId: "b", input: { command: "make" } },
      usage,
    )) as { block?: boolean; terminate?: boolean };
    expect(refused).toMatchObject({ block: true, terminate: true });
  });

  it("tells a worker how to run SwiftPM when its own sandbox is refused", async () => {
    const root = await tempDir("nested-sandbox-");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const pi = { on: (name: string, handler: never) => handlers.set(name, handler) };
    projectPolicyExtension({
      projectRoot: root,
      cwd: root,
      project: project(root),
      trust: "full",
      bashEnabled: true,
    })(pi as never);
    const usage = { getContextUsage: () => ({ tokens: 1, contextWindow: 65536, percent: 10 }) };
    const result = (await handlers.get("tool_result")!(
      {
        toolCallId: "b",
        isError: false,
        content: [{ type: "text", text: "sandbox-exec: sandbox_apply: Operation not permitted" }],
      },
      usage,
    )) as { content: Array<{ text: string }> };
    expect(result.content.at(-1)?.text).toMatch(/--disable-sandbox -Xswiftc -disable-sandbox/);
    expect(
      await handlers.get("tool_result")!(
        { toolCallId: "c", isError: false, content: [{ type: "text", text: "ok" }] },
        usage,
      ),
    ).toBeUndefined();
  });

  it("gets no more tools once it has used its tool-call budget", async () => {
    const root = await tempDir("read-only-calls-");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    projectPolicyExtension({
      projectRoot: root,
      cwd: root,
      project: project(root),
      trust: "assist",
      bashEnabled: false,
      readOnly: true,
    })({ on: (name: string, handler: never) => handlers.set(name, handler) } as never);
    const call = { toolName: "ls", toolCallId: "ls", input: { path: "." } };
    const ctx = { getContextUsage: () => ({ tokens: 1, contextWindow: 65536, percent: 10 }) };
    const results = [];
    for (let index = 0; index <= INVESTIGATION_TOOL_CALLS; index += 1)
      results.push(
        (await handlers.get("tool_call")!(call, ctx)) as { block?: boolean } | undefined,
      );
    expect(results.slice(0, INVESTIGATION_TOOL_CALLS).every((result) => !result?.block)).toBe(true);
    expect(results.at(-1)).toMatchObject({
      block: true,
      reason: expect.stringMatching(/tool calls, so no more tools/),
    });
  });
});
