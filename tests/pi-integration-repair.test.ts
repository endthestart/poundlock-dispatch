import {
  link,
  mkdir,
  readFile,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { PythonUvAdapter, selectProjectEnvironment } from "@core/python-uv";
import { ToolJournal } from "@core/tool-journal";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { runHostCommand } from "@runtime/host-command";
import {
  evaluateWorkerToolCall,
  filterSearchToolOutput,
  projectFileToolDefinitions,
} from "@runtime/policy-extension";
import { buildSandboxRequest } from "@runtime/sandbox-policy";
import { defaultBudget, defaultPolicy, type ProjectRecord } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

function project(root: string, extra: Partial<ProjectRecord> = {}): ProjectRecord {
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
    ...extra,
  };
}

describe("Ask-mode Pi tool authorization", () => {
  it("approves exact Bash, and denied calls have zero side effects", async () => {
    const root = await realpath(await tempDir("dispatch-ask-"));
    const target = join(root, "secret.txt");
    await writeFile(target, "keep");
    const record = project(root);
    let executed = 0;
    const bash = await evaluateWorkerToolCall(
      {
        projectRoot: root,
        cwd: root,
        project: record,
        trust: "ask",
        bashEnabled: true,
        authorizeBash: async () => "deny",
      },
      { toolName: "bash", toolCallId: "bash-1", input: { command: "rm secret.txt" } },
    );
    expect(bash.block).toBe(true);
    expect(await readFile(target, "utf8")).toBe("keep");

    const write = await evaluateWorkerToolCall(
      {
        projectRoot: root,
        cwd: root,
        project: record,
        trust: "ask",
        bashEnabled: true,
        authorizeMutation: async () => "deny",
      },
      {
        toolName: "write",
        toolCallId: "write-1",
        input: { path: "new.txt", content: "nope" },
      },
    );
    expect(write.block).toBeUndefined();

    await expect(
      runHostCommand(
        {
          program: "git",
          arguments: ["--version"],
          capability: "inspect",
          effect: "inspect",
        },
        {
          projectRoot: root,
          extraPath: [],
          privateHome: join(root, "home"),
          trust: "ask",
          allowDependencyNetwork: false,
          sandboxRequest: await buildSandboxRequest({
            projectRoot: root,
            project: record,
            privateHome: join(root, "home"),
            network: "deny",
          }),
          signal: new AbortController().signal,
          authorize: async () => "deny",
          execute: async () => {
            executed += 1;
            return { exitCode: 0, output: "ran" };
          },
        },
      ),
    ).rejects.toThrow(/denied/);
    expect(executed).toBe(0);

    let asked = 0;
    await writeFile(join(root, "granted.txt"), "seed");
    const grantedPath = await realpath(join(root, "granted.txt"));
    const granted = await evaluateWorkerToolCall(
      {
        projectRoot: root,
        cwd: root,
        project: record,
        trust: "ask",
        bashEnabled: true,
        getPermissions: async () => ({
          defaultMode: "ask",
          grants: {
            project: [{ kind: "write", action: grantedPath, cwd: root }],
          },
        }),
        authorizeMutation: async () => {
          asked += 1;
          return "deny";
        },
      },
      {
        toolName: "write",
        toolCallId: "write-grant",
        input: { path: grantedPath, content: "ok" },
      },
    );
    expect(granted.block).toBeUndefined();
    expect(asked).toBe(0);
  });

  it("disables raw Bash in Approve for me", async () => {
    const root = await tempDir("dispatch-assist-bash-");
    const result = await evaluateWorkerToolCall(
      {
        projectRoot: root,
        cwd: root,
        project: project(root),
        trust: "assist",
        bashEnabled: false,
      },
      { toolName: "bash", toolCallId: "bash-2", input: { command: "echo hi" } },
    );
    expect(result.block).toBe(true);
    expect(result.reason).toMatch(/Raw Bash is disabled/);
  });

  it("applies a permission downgrade to an already-running worker", async () => {
    const root = await realpath(await tempDir("dispatch-live-policy-"));
    let asked = 0;
    const result = await evaluateWorkerToolCall(
      {
        projectRoot: root,
        cwd: root,
        project: project(root),
        trust: "full",
        bashEnabled: true,
        getPolicy: async () => ({
          project: project(root),
          trust: "ask",
          permissions: { defaultMode: "ask" },
        }),
        authorizeBash: async () => {
          asked += 1;
          return "deny";
        },
      },
      { toolName: "bash", toolCallId: "live-bash", input: { command: "echo hi" } },
    );
    expect(asked).toBe(1);
    expect(result.block).toBe(true);
  });
});

describe("tool journal lifecycle", () => {
  it("records pending immediately before execution and never replays unresolved work", async () => {
    const root = await tempDir("dispatch-journal-order-");
    const journal = new ToolJournal(join(root, "journal"));
    const order: string[] = [];
    await runHostCommand(
      {
        program: "/bin/echo",
        arguments: ["ok"],
        capability: "inspect",
        effect: "inspect",
      },
      {
        projectRoot: root,
        extraPath: [],
        privateHome: join(root, "home"),
        trust: "full",
        allowDependencyNetwork: false,
        sandboxRequest: await buildSandboxRequest({
          projectRoot: root,
          project: project(root),
          privateHome: join(root, "home"),
          network: "deny",
        }),
        signal: new AbortController().signal,
        journal,
        execute: async (command, signal) => {
          const open = await journal.unresolved();
          order.push(open[0]?.status ?? "missing");
          return {
            exitCode: 0,
            output: `${command.program} ${signal.aborted ? "aborted" : "ran"}`,
          };
        },
      },
    );
    expect(order).toEqual(["pending"]);
    const after = await journal.reconcileOnStart();
    expect(after).toEqual([]);
    const crash = await journal.begin({
      toolCallId: "call-1",
      workflowId: "wf",
      planRevision: 1,
      taskId: "task",
      attemptId: "att",
      action: { tool: "write", path: "a.txt" },
      authorization: "ask",
      sideEffectScope: ["a.txt"],
    });
    const unresolved = await journal.reconcileOnStart();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].status).toBe("needs_reconciliation");
    expect(unresolved[0].toolCallId).toBe("call-1");
    expect(unresolved[0].eventId).toBe(crash.eventId);
  });
});

describe("sandbox policy", () => {
  it("sandboxes an existing virtual-environment interpreter without another prompt", async () => {
    const root = await tempDir("dispatch-sandbox-venv-command-");
    const home = join(root, "home");
    const bin = join(root, ".venv", "bin");
    await mkdir(home);
    await mkdir(bin, { recursive: true });
    await symlink(process.execPath, join(bin, "python"));
    let prompted = true;
    await runHostCommand(
      {
        program: join(bin, "python"),
        arguments: ["manage.py", "check"],
        capability: "test",
        effect: "project_change",
      },
      {
        projectRoot: root,
        extraPath: [bin],
        privateHome: home,
        trust: "assist",
        allowDependencyNetwork: false,
        sandboxRequest: await buildSandboxRequest({
          projectRoot: root,
          project: project(root),
          privateHome: home,
          network: "deny",
          virtualenv: join(root, ".venv"),
        }),
        signal: new AbortController().signal,
        qualifySandbox: async () => ({ available: true, runtime: "sandbox-exec" }),
        authorize: async (command, context) => {
          expect(command.executableSource).toBe("project_environment");
          prompted = context.requireUserApproval;
          return "allow";
        },
        execute: async (command) => {
          expect(command.arguments).toContain(join(bin, "python"));
          expect(command.arguments).not.toContain(process.execPath);
          return { exitCode: 0, output: "ok" };
        },
      },
    );
    expect(prompted).toBe(false);
  });

  it("treats any bare tool on the sanitized PATH generically and sandboxes it", async () => {
    const root = await tempDir("dispatch-generic-host-tool-");
    const home = join(root, "home");
    await mkdir(home);
    let source = "";
    await runHostCommand(
      { program: "true", arguments: [], capability: "build", effect: "project_change" },
      {
        projectRoot: root,
        extraPath: [],
        privateHome: home,
        trust: "assist",
        allowDependencyNetwork: false,
        sandboxRequest: await buildSandboxRequest({
          projectRoot: root,
          project: project(root),
          privateHome: home,
          network: "deny",
        }),
        signal: new AbortController().signal,
        qualifySandbox: async () => ({ available: true, runtime: "sandbox-exec" }),
        execute: async (command) => {
          source = command.executableSource;
          return { exitCode: 0, output: "ok" };
        },
      },
    );
    expect(source).toBe("approved_host_tool");
  });

  it("re-evaluates authority if project permissions change during command authorization", async () => {
    const root = await tempDir("dispatch-command-policy-change-");
    const home = join(root, "home");
    await mkdir(home);
    const request = await buildSandboxRequest({
      projectRoot: root,
      project: project(root),
      privateHome: home,
      network: "deny",
    });
    let mode: "assist" | "ask" = "assist";
    let approvals = 0;
    let executed = 0;
    await runHostCommand(
      { program: "true", arguments: [], capability: "inspect", effect: "inspect" },
      {
        projectRoot: root,
        extraPath: [],
        privateHome: home,
        trust: "assist",
        allowDependencyNetwork: false,
        sandboxRequest: request,
        signal: new AbortController().signal,
        refreshPolicy: async () => ({
          trust: mode,
          allowDependencyNetwork: false,
          sandboxRequest: request,
        }),
        qualifySandbox: async () => ({ available: true, runtime: "sandbox-exec" }),
        authorize: async (_command, context) => {
          approvals += 1;
          if (approvals === 1) {
            expect(context.requireUserApproval).toBe(false);
            mode = "ask";
          } else {
            expect(context.requireUserApproval).toBe(true);
          }
          return "allow";
        },
        execute: async () => {
          executed += 1;
          return { exitCode: 0, output: "ok" };
        },
      },
    );
    expect(approvals).toBe(2);
    expect(executed).toBe(1);
  });

  it("denies excluded project secrets while keeping the project root writable", async () => {
    const root = await tempDir("dispatch-sandbox-policy-");
    await writeFile(join(root, ".env"), "SECRET=1");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "auth.json"), "{}");
    const record = project(root);
    record.policy.verification.protectedPaths = ["secrets"];
    const request = await buildSandboxRequest({
      projectRoot: root,
      cwd: root,
      project: record,
      privateHome: join(root, "home"),
      network: "deny",
    });
    expect(request.deniedRead).toEqual(
      expect.arrayContaining([join(root, ".env"), join(root, ".git"), join(root, "auth.json")]),
    );
    expect(request.writable).toContain(root);
  });

  it("denies shell environments, Terraform state and service-account keys in the sandbox", async () => {
    const root = await tempDir("dispatch-sandbox-l24-");
    await mkdir(join(root, "infra"));
    for (const path of [
      ".envrc",
      ".vault-token",
      "infra/terraform.tfstate",
      "infra/prod.tfvars",
      "infra/gke-service-account.json",
    ])
      await writeFile(join(root, path), "secret");
    await writeFile(join(root, "infra", "main.tf"), "resource {}");
    const request = await buildSandboxRequest({
      projectRoot: root,
      cwd: root,
      project: project(root),
      privateHome: join(root, "home"),
      network: "deny",
    });
    const real = await realpath(root);
    expect(request.deniedRead).toEqual(
      expect.arrayContaining([
        join(root, ".envrc"),
        join(root, ".vault-token"),
        join(real, "infra", "terraform.tfstate"),
        join(real, "infra", "prod.tfvars"),
        join(real, "infra", "gke-service-account.json"),
      ]),
    );
    expect(request.deniedRead).not.toContain(join(real, "infra", "main.tf"));
  });

  it("keeps the selected project environment usable while excluding it from model context", async () => {
    const root = await tempDir("dispatch-sandbox-venv-");
    const virtualenv = join(root, ".venv");
    await mkdir(join(virtualenv, "bin"), { recursive: true });
    await writeFile(join(virtualenv, "bin", "python"), "#!/bin/sh\n");
    const request = await buildSandboxRequest({
      projectRoot: root,
      project: project(root),
      privateHome: join(root, "home"),
      network: "deny",
      virtualenv,
    });
    expect(request.writable).toContain(virtualenv);
    expect(
      request.deniedRead.some((path) => path === virtualenv || path.startsWith(`${virtualenv}/`)),
    ).toBe(false);
  });

  it("allows generated and dependency paths while keeping them out of model-facing file tools", async () => {
    const root = await realpath(await tempDir("dispatch-sandbox-generated-"));
    await mkdir(join(root, "node_modules", "package"), { recursive: true });
    await writeFile(join(root, "node_modules", "package", "index.js"), "module.exports = 1;");
    await writeFile(join(root, "db.sqlite3"), "db");
    const request = await buildSandboxRequest({
      projectRoot: root,
      project: project(root),
      privateHome: join(root, "home"),
      network: "deny",
    });
    expect(request.deniedRead.some((path) => path.startsWith(join(root, "node_modules")))).toBe(
      false,
    );
    expect(request.deniedRead).not.toContain(join(root, "db.sqlite3"));
  });

  it("asks rather than executing on the host when Approve for me cannot sandbox", async () => {
    const root = await tempDir("dispatch-unsandboxed-");
    let executed = 0;
    await expect(
      runHostCommand(
        {
          program: "git",
          arguments: ["--version"],
          capability: "test",
          effect: "project_change",
        },
        {
          projectRoot: root,
          extraPath: [],
          privateHome: join(root, "home"),
          trust: "assist",
          allowDependencyNetwork: false,
          sandboxRequest: await buildSandboxRequest({
            projectRoot: root,
            project: project(root),
            privateHome: join(root, "home"),
            network: "deny",
          }),
          signal: new AbortController().signal,
          qualifySandbox: async () => ({
            available: false,
            runtime: "none",
            reason: "fixture",
          }),
          authorize: async (_command, context) => {
            expect(context.requireUserApproval).toBe(true);
            return "deny";
          },
          execute: async () => {
            executed += 1;
            return { exitCode: 0, output: "host" };
          },
        },
      ),
    ).rejects.toThrow(/denied/);
    expect(executed).toBe(0);
  });

  it("expands wildcard exclusions and symlinks into concrete command denies", async () => {
    const root = await realpath(await tempDir("dispatch-sandbox-expanded-"));
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested", ".env.private"), "SECRET=1");
    await writeFile(join(root, "nested", "ignored.txt"), "private");
    const outside = join(await realpath(await tempDir("dispatch-link-target-")), "outside.txt");
    await writeFile(outside, "outside");
    await symlink(outside, join(root, "linked.txt"));
    const record = project(root);
    if (record.source.kind === "local_folder") {
      record.source.excludedPatterns = ["**/ignored.*"];
    }
    const request = await buildSandboxRequest({
      projectRoot: root,
      project: record,
      privateHome: join(root, "home"),
      network: "deny",
    });
    expect(request.deniedRead).toEqual(
      expect.arrayContaining([
        join(root, "nested", ".env.private"),
        join(root, "nested", "ignored.txt"),
        join(root, "linked.txt"),
        outside,
      ]),
    );
  });

  it("uses each command's network mode and rejects dependency network on other capabilities", async () => {
    const root = await tempDir("dispatch-command-network-");
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const request = await buildSandboxRequest({
      projectRoot: root,
      project: project(root),
      privateHome: home,
      network: "dependency",
    });
    let profile = "";
    await runHostCommand(
      {
        program: "true",
        arguments: [],
        capability: "test",
        effect: "inspect",
        networkMode: "deny",
      },
      {
        projectRoot: root,
        extraPath: [],
        privateHome: home,
        trust: "assist",
        allowDependencyNetwork: true,
        sandboxRequest: request,
        signal: new AbortController().signal,
        qualifySandbox: async () => ({ available: true, runtime: "sandbox-exec" }),
        execute: async (command) => {
          expect(command.arguments[0]).toBe("-p");
          profile = command.arguments[1];
          return { exitCode: 0, output: "ok" };
        },
      },
    );
    expect(profile).toContain("(deny network*)");
    await expect(
      runHostCommand(
        {
          program: "true",
          arguments: [],
          capability: "test",
          effect: "inspect",
          networkMode: "dependency",
        },
        {
          projectRoot: root,
          extraPath: [],
          privateHome: home,
          trust: "assist",
          allowDependencyNetwork: true,
          sandboxRequest: request,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow(/typed dependency-install/);
  });
});

describe("Pi file and search boundaries", () => {
  it("revalidates a file path when the actual Pi write begins", async () => {
    const root = await realpath(await tempDir("dispatch-write-race-"));
    const target = join(root, "target.txt");
    const outside = join(await realpath(await tempDir("dispatch-write-outside-")), "outside.txt");
    await writeFile(target, "inside");
    await writeFile(outside, "outside");
    const options = {
      projectRoot: root,
      cwd: root,
      project: project(root),
      trust: "assist" as const,
      bashEnabled: false,
    };
    const authorized = await evaluateWorkerToolCall(options, {
      toolName: "write",
      toolCallId: "write-race",
      input: { path: "target.txt", content: "changed" },
    });
    expect(authorized.block).toBeUndefined();
    await unlink(target);
    await symlink(outside, target);
    const definitions = projectFileToolDefinitions(
      { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition },
      options,
    );
    const write = definitions.find((item) => item.name === "write") as ReturnType<
      typeof createWriteToolDefinition
    >;
    await expect(
      write.execute(
        "write-race",
        { path: "target.txt", content: "changed" },
        new AbortController().signal,
        undefined,
        { cwd: root } as Parameters<typeof write.execute>[4],
      ),
    ).rejects.toThrow(/Symbolic link|outside/);
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("rejects hard-linked project files at the actual read and write operation", async () => {
    const root = await realpath(await tempDir("dispatch-hardlink-"));
    const outsideRoot = await realpath(await tempDir("dispatch-hardlink-outside-"));
    const outside = join(outsideRoot, "shared.txt");
    const inside = join(root, "shared.txt");
    await writeFile(outside, "outside");
    await link(outside, inside);
    const options = {
      projectRoot: root,
      cwd: root,
      project: project(root),
      trust: "assist" as const,
      bashEnabled: false,
    };
    const definitions = projectFileToolDefinitions(
      { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition },
      options,
    );
    const read = definitions.find((item) => item.name === "read") as ReturnType<
      typeof createReadToolDefinition
    >;
    const write = definitions.find((item) => item.name === "write") as ReturnType<
      typeof createWriteToolDefinition
    >;
    const context = { cwd: root } as Parameters<typeof write.execute>[4];
    await expect(
      read.execute(
        "read-hardlink",
        { path: inside },
        new AbortController().signal,
        undefined,
        context,
      ),
    ).rejects.toThrow(/Hard-linked/);
    await expect(
      write.execute(
        "write-hardlink",
        { path: inside, content: "changed" },
        new AbortController().signal,
        undefined,
        context,
      ),
    ).rejects.toThrow(/Hard-linked/);
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("rejects an ancestor directory swap after a file mutation is authorized", async () => {
    const root = await realpath(await tempDir("dispatch-parent-race-"));
    const directory = join(root, "nested");
    const moved = join(root, "nested-original");
    const outsideRoot = await realpath(await tempDir("dispatch-parent-race-outside-"));
    await mkdir(directory);
    await writeFile(join(directory, "target.txt"), "inside");
    await writeFile(join(outsideRoot, "target.txt"), "outside");
    const options = {
      projectRoot: root,
      cwd: root,
      project: project(root),
      trust: "assist" as const,
      bashEnabled: false,
    };
    const authorized = await evaluateWorkerToolCall(options, {
      toolName: "write",
      toolCallId: "parent-race",
      input: { path: "nested/target.txt", content: "changed" },
    });
    expect(authorized.block).toBeUndefined();
    await rename(directory, moved);
    await symlink(outsideRoot, directory);
    const definitions = projectFileToolDefinitions(
      { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition },
      options,
    );
    const write = definitions.find((item) => item.name === "write") as ReturnType<
      typeof createWriteToolDefinition
    >;
    await expect(
      write.execute(
        "parent-race",
        { path: "nested/target.txt", content: "changed" },
        new AbortController().signal,
        undefined,
        { cwd: root } as Parameters<typeof write.execute>[4],
      ),
    ).rejects.toThrow(/outside|changed|Symbolic link/);
    expect(await readFile(join(outsideRoot, "target.txt"), "utf8")).toBe("outside");
  });

  it("removes excluded files from Pi grep, find, and ls results", () => {
    const root = "/project";
    const included = new Set([join(root, "src"), join(root, "src", "app.ts")]);
    expect(
      filterSearchToolOutput(
        { tool: "grep", searchRoot: root, included },
        "src/app.ts:2: safe\nnested/.env:1: SECRET=value\n[secret]/.env:1: ALSO_SECRET=value\n[100 matches limit reached]",
      ),
    ).toBe("src/app.ts:2: safe");
    expect(
      filterSearchToolOutput(
        { tool: "find", searchRoot: root, included },
        "src/app.ts\nnested/.env",
      ),
    ).toBe("src/app.ts");
    expect(filterSearchToolOutput({ tool: "ls", searchRoot: root, included }, "src/\n.env")).toBe(
      "src/",
    );
  });
});

async function fakeVenv(root: string) {
  await mkdir(join(root, ".venv", "bin"), { recursive: true });
  await writeFile(join(root, ".venv", "bin", "python"), "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(join(root, ".venv", "pyvenv.cfg"), "version = 3.14.0\n");
}

describe("python/uv environment", () => {
  it("creates .venv on a clean folder when Python is requested and honors the Internet switch", async () => {
    const root = await tempDir("dispatch-uv-empty-");
    const adapter = new PythonUvAdapter();
    const detected = await adapter.detect(root, { requested: true });
    if (!detected || detected.blocked) {
      const selected = await selectProjectEnvironment(root, { need: "python" });
      expect(selected?.blocked ?? detected?.blocked).toMatch(/environment_blocked|uv/);
      return;
    }
    const commands: string[] = [];
    // Follow detection: uv when installed, otherwise the stdlib venv fallback.
    const prepared = await adapter.prepare(root, detected, {
      signal: new AbortController().signal,
      allowDownloads: false,
      run: async (input) => {
        commands.push(`${input.program} ${input.arguments.join(" ")}`);
        expect(input.networkMode).toBe("deny");
        if (input.arguments.includes("venv")) await fakeVenv(root);
        return {};
      },
    });
    expect(commands.some((item) => item.includes("venv"))).toBe(true);
    expect(commands.some((item) => item.includes("sync") || item.includes("pip install"))).toBe(
      false,
    );
    expect(prepared.kind === "configured" || prepared.blocked).toBeTruthy();

    await writeFile(join(root, "requirements.txt"), "django\n");
    const blocked = await adapter.prepare(root, detected, {
      signal: new AbortController().signal,
      allowDownloads: false,
      run: async () => ({}),
    });
    expect(blocked.blocked).toMatch(/Internet is off/);

    const downloaded = await adapter.prepare(root, detected, {
      signal: new AbortController().signal,
      allowDownloads: true,
      run: async (input) => {
        expect(["deny", "dependency"]).toContain(input.networkMode);
        return {};
      },
    });
    expect(downloaded.blocked).toBeUndefined();
  });
});

describe("session restoration", () => {
  it("does not replay journaled tools after restart", async () => {
    const root = await tempDir("dispatch-no-replay-");
    const journal = new ToolJournal(join(root, "journal"));
    await journal.begin({
      toolCallId: "restored",
      workflowId: "wf",
      action: { tool: "write", path: "restored.txt" },
      authorization: "allow",
      sideEffectScope: ["restored.txt"],
    });
    const unresolved = await journal.reconcileOnStart();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].status).toBe("needs_reconciliation");
    expect(unresolved[0].toolCallId).toBe("restored");
    expect(Reflect.get(journal, "replay")).toBeUndefined();
  });
});
