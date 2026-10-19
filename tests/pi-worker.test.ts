import { chmod, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyAttemptFailure } from "@core/failure-class";
import { parseInteractiveModels } from "@core/poundlock";
import { compileArgv } from "@runtime/argv";
import { commandApprovalAction, runHostCommand } from "@runtime/host-command";
import {
  beginSandboxedEnvironment,
  endSandboxedEnvironment,
  ranNoTests,
  runWorkerTurn,
  WORKER_SYSTEM_PROMPT,
  workerBrief,
  workerResponseError,
} from "@runtime/pi-worker";
import {
  effectiveCommandEffect,
  executeResolvedCommand,
  resolveCommand,
  workerEnvironment,
} from "@runtime/run-command";
import { defaultBudget, defaultPolicy, type ProjectRecord, type TaskRecord } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

describe("sandboxed worker environment", () => {
  it("keeps PATH/PI_OFFLINE sandboxed until the last concurrent worker finishes", () => {
    const originalPath = process.env.PATH;
    const originalOffline = process.env.PI_OFFLINE;
    try {
      process.env.PATH = "/usr/bin:/bin";
      delete process.env.PI_OFFLINE;

      beginSandboxedEnvironment("/tool/dir");
      expect(process.env.PATH).toBe("/tool/dir");
      expect(process.env.PI_OFFLINE).toBe("1");

      // A second, concurrent worker starts before the first finishes.
      beginSandboxedEnvironment("/tool/dir");
      endSandboxedEnvironment();
      // The first worker is done, but the second is still running — the real
      // original PATH must not leak back in and unsandbox it.
      expect(process.env.PATH).toBe("/tool/dir");
      expect(process.env.PI_OFFLINE).toBe("1");

      endSandboxedEnvironment();
      expect(process.env.PATH).toBe("/usr/bin:/bin");
      expect(process.env.PI_OFFLINE).toBeUndefined();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = originalOffline;
    }
  });
});

describe("controlled host commands", () => {
  it("does not pass app credentials or shell startup configuration to project code", async () => {
    process.env.LOCKKEEP_TEST_SECRET = "must-not-leak";
    const home = await tempDir("dispatch-env-");
    expect(workerEnvironment(home).LOCKKEEP_TEST_SECRET).toBeUndefined();
    const resolved = await resolveCommand(
      {
        program: "/bin/sh",
        arguments: ["-c", 'printf "%s" "${LOCKKEEP_TEST_SECRET-unset}"; exit 7'],
        capability: "inspect",
        effect: "inspect",
      },
      home,
      [],
      home,
    );
    const result = await executeResolvedCommand(resolved, new AbortController().signal);
    expect(result.exitCode).toBe(7);
    expect(result.output).toBe("unset");
    delete process.env.LOCKKEEP_TEST_SECRET;
  });

  it("uses the project virtual environment for unqualified Python", async () => {
    const cwd = await tempDir("dispatch-python-path-");
    await mkdir(join(cwd, ".venv/bin"), { recursive: true });
    const python = join(cwd, ".venv/bin/python");
    await writeFile(python, "#!/bin/sh\nprintf project-python");
    await chmod(python, 0o700);
    const result = await runHostCommand(
      { program: "python", arguments: ["--version"], capability: "inspect", effect: "inspect" },
      {
        projectRoot: cwd,
        extraPath: [join(cwd, ".venv/bin")],
        privateHome: join(cwd, "home"),
        trust: "full",
        allowDependencyNetwork: false,
        sandboxRequest: {
          projectRoot: cwd,
          writable: [cwd],
          deniedRead: [],
          network: "deny",
          tmp: join(cwd, "home"),
        },
        signal: new AbortController().signal,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("project-python");
  });

  it("terminates a command process group and retains the interrupted outcome", async () => {
    const home = await tempDir("dispatch-cancel-");
    const controller = new AbortController();
    const resolved = await resolveCommand(
      {
        program: "/bin/sh",
        arguments: ["-c", "sleep 30"],
        capability: "inspect",
        effect: "inspect",
      },
      home,
      [],
      home,
    );
    const pending = executeResolvedCommand(resolved, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.exitCode).toBeNull();
    expect(result.error).toBe("Cancelled");
  });

  it("rejects unsupported shell syntax instead of whitespace-splitting verification", () => {
    expect(() => compileArgv("node --test; rm -rf x")).toThrow(/Unsupported shell syntax/);
    expect(() => compileArgv("cat *.json")).toThrow(/Unsupported shell syntax/);
    expect(compileArgv("node --test proof.test.js")).toEqual({
      program: "node",
      arguments: ["--test", "proof.test.js"],
    });
  });

  it("records recognized deletion commands as destructive regardless of declared effect", async () => {
    const cwd = await tempDir("dispatch-destructive-effect-");
    const resolved = await resolveCommand(
      {
        program: "rm",
        arguments: ["-rf", "venv"],
        capability: "inspect",
        effect: "inspect",
      },
      cwd,
      [],
      join(cwd, "home"),
    );
    const audited = { ...resolved, effect: effectiveCommandEffect(resolved) };
    expect(audited.effect).toBe("destructive");
    expect(commandApprovalAction(audited)).toContain("effect=destructive");
  });

  it("treats a terminated provider stream as recoverable inference state", () => {
    expect(workerResponseError({ stopReason: "error", errorMessage: "terminated" })).toMatch(
      /^ambiguous_inference:/,
    );
    expect(workerResponseError({ stopReason: "length" })).toContain("output limit");
    expect(workerResponseError({ stopReason: "toolUse" })).toMatch(/^ambiguous_inference:/);
    // A full context is not an ambiguous reply: it needs a smaller question.
    expect(workerResponseError({ stopReason: "length", usage: { output: 1 } })).toMatch(
      /^context_limit:/,
    );
    expect(workerResponseError({ stopReason: "toolUse" }, { percent: 96 })).toMatch(
      /^context_limit:/,
    );
    expect(workerResponseError({ stopReason: "toolUse" }, { percent: 40 })).toMatch(
      /^ambiguous_inference:/,
    );
    expect(
      classifyAttemptFailure({
        error: workerResponseError({ stopReason: "toolUse" }, { percent: 96 }),
      }),
    ).toBe("context_limit");
    expect(workerResponseError({ stopReason: "stop" })).toBeUndefined();
  });

  it("makes Dispatch's prepared Python environment authoritative for workers", () => {
    expect(WORKER_SYSTEM_PROMPT).toContain("use the existing .venv");
    expect(WORKER_SYSTEM_PROMPT).toContain("install approved packages with uv");
    expect(WORKER_SYSTEM_PROMPT).toContain("do not create, replace, or delete .venv");
  });
});

describe("discovery contract", () => {
  it("retains destination and actual limits from either catalog metadata shape", () => {
    const [model] = parseInteractiveModels([
      {
        id: "coding",
        context_tokens: 131072,
        max_output_tokens: 8192,
        endpoint_kind: "litellm",
        data_destination: "operator_network",
        busy: false,
        poundlock: { profile_id: "id", canonical_name: "main", aliases: ["coding"] },
      },
    ]);
    expect(model).toMatchObject({
      id: "main",
      profileId: "id",
      aliases: ["coding"],
      context_tokens: 131072,
      max_output_tokens: 8192,
      dataDestination: "operator_network",
      endpointKind: "litellm",
      busy: false,
    });
    expect(
      parseInteractiveModels([{ id: "other", data_destination: "future-value" }])[0]
        .dataDestination,
    ).toBe("unknown");
  });
});

describe("local change evidence", () => {
  it("tracks assets larger than the durable upload cap without copying their contents", async () => {
    const { captureLocalEvidence } = await import("@core/local-evidence");
    const root = await tempDir("dispatch-large-evidence-");
    const file = await open(join(root, "asset.bin"), "w");
    await file.truncate(51 * 1024 * 1024);
    await file.close();
    const result = await captureLocalEvidence(root, []);
    expect(result.manifest[0]).toMatchObject({
      path: "asset.bin",
      bytes: 51 * 1024 * 1024,
      patchAvailable: false,
    });
    expect(result.manifest[0].sha256).toHaveLength(64);
    expect(result.files).toEqual([]);
  });
});

describe("worker turns", () => {
  it("prompts a restored session and returns only a new assistant message", async () => {
    const messages: Array<{ role: string; text?: string }> = [
      { role: "user", text: "task" },
      { role: "assistant", text: "first attempt" },
    ];
    const prompted: string[] = [];
    const session = {
      messages,
      async prompt(text: string) {
        prompted.push(text);
        messages.push({ role: "user", text }, { role: "assistant", text: "repaired" });
      },
    };
    expect(await runWorkerTurn(session, "repair")).toEqual({ role: "assistant", text: "repaired" });
    expect(prompted).toEqual(["repair"]);
  });

  it("never returns the previous turn's answer when no new reply was produced", async () => {
    const messages = [{ role: "assistant", text: "first attempt" }];
    const session = { messages, prompt: async () => undefined };
    expect(await runWorkerTurn(session, "repair")).toBeUndefined();
    expect(workerResponseError(undefined)).toBe("Incomplete model response");
  });
});

describe("vacuous test runs", () => {
  it("recognizes runners that exit 0 without running any test", () => {
    expect(ranNoTests("Found 0 test(s).\nSystem check identified no issues.\nNO TESTS RAN")).toBe(
      true,
    );
    expect(ranNoTests("\nRan 0 tests in 0.000s\n\nOK")).toBe(true);
    expect(ranNoTests("collected 0 items")).toBe(true);
    expect(ranNoTests("Found 3 test(s).\nRan 3 tests in 0.01s\n\nOK")).toBe(false);
    expect(ranNoTests("System check identified no issues (0 silenced).")).toBe(false);
  });
});

describe("the interactive worker's brief", () => {
  const project: ProjectRecord = {
    id: "project",
    name: "Example",
    archived: false,
    createdAt: "now",
    updatedAt: "now",
    status: "draft",
    source: {
      kind: "local_folder",
      originalPath: "/tmp/example",
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
    managerSessionId: "manager",
    eventCursor: 0,
  };
  const task = (extra: Partial<TaskRecord> = {}): TaskRecord => ({
    id: "task_1",
    title: "Add slugs",
    objective: "Add URL slugs",
    workerPrompt: "Implement slugs.",
    acceptanceCriteria: "Slugs are unique",
    dependsOn: [],
    difficulty: "small",
    contextNote: "",
    status: "ready",
    repairCount: 0,
    attempts: [],
    ...extra,
  });
  const brief = (value: TaskRecord, extra: { readOnly?: boolean } = {}) =>
    JSON.parse(
      workerBrief({
        task: value,
        project,
        cwd: "/tmp/example",
        allowDependencyDownloads: false,
        files: ["src/a.ts", "src/b.ts"],
        ...extra,
      }),
    ) as Record<string, unknown>;

  it("sends the stored context note, the files to change and the code to reuse", () => {
    const sent = brief(
      task({
        contextNote: "Slugs are lowercase ASCII; the router already strips accents.",
        filesToTouch: ["src/core/slug.ts", "tests/slug.test.ts"],
        reuse: ["slugify() in src/util/text.ts"],
      }),
    );
    expect(sent.contextFromManager).toBe(
      "Slugs are lowercase ASCII; the router already strips accents.",
    );
    expect(sent.filesToTouch).toEqual(["src/core/slug.ts", "tests/slug.test.ts"]);
    expect(sent.reuseExistingCode).toEqual(["slugify() in src/util/text.ts"]);
    // Still the task, the checks and where the worker is.
    expect(sent).toMatchObject({
      workingDirectory: "/tmp/example",
      objective: "Add URL slugs",
      instructions: "Implement slugs.",
      files: ["src/a.ts", "src/b.ts"],
    });
  });

  it("bounds the context note it sends", () => {
    const sent = brief(task({ contextNote: "x".repeat(50_000) }));
    expect(String(sent.contextFromManager).length).toBeLessThan(2_200);
    expect(sent.contextFromManager).toMatch(/\[note truncated: first 2,000 of 50,000 characters\]/);
  });

  it("is unchanged for a task with no hints, so stored plans behave as before", () => {
    expect(Object.keys(brief(task()))).toEqual([
      "workingDirectory",
      "objective",
      "instructions",
      "acceptanceCriteria",
      "verificationCommands",
      "dependencyDownloadsApproved",
      "environmentNeed",
      "files",
    ]);
  });

  it("keeps an investigation to its question, whatever the task carries", () => {
    const sent = brief(task({ contextNote: "note", filesToTouch: ["src/a.ts"] }), {
      readOnly: true,
    });
    expect(sent).toEqual({
      workingDirectory: "/tmp/example",
      question: "Add URL slugs",
      instructions: "Implement slugs.",
      authority: "read-only",
      files: ["src/a.ts", "src/b.ts"],
    });
  });

  it("tells the worker what the hint fields mean", () => {
    expect(WORKER_SYSTEM_PROMPT).toContain("contextFromManager");
    expect(WORKER_SYSTEM_PROMPT).toContain("filesToTouch");
    expect(WORKER_SYSTEM_PROMPT).toContain("reuseExistingCode");
    expect(WORKER_SYSTEM_PROMPT).toContain(
      "if a listed path does not exist, say so in your report",
    );
  });
});
