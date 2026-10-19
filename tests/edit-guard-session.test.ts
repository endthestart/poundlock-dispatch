/**
 * The edit guard inside a real Pi session, the way a Dispatch worker loads it:
 * Dispatch's file tools, the policy extension, then the guard, with
 * sequential tools. A scripted model on loopback replays a re-sent edit; the
 * guard's answer must be what the model receives on its next request, and
 * the attempt must carry the guard's evidence.
 */
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import type { EditGuardEvidence, WorkerPort } from "@core/interactive-worker";
import { MemoryPoundlock } from "@core/memory-poundlock";
import { type ManagerPort, ProjectOrchestrator } from "@core/orchestration";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import * as pi from "@earendil-works/pi-coding-agent";
import { EditGuard, editGuardExtension } from "@runtime/edit-guard";
import { hostCommandPort } from "@runtime/host-command";
import { lockedPiResources } from "@runtime/pi-resources";
import {
  type PolicyExtensionOptions,
  projectFileToolDefinitions,
  projectPolicyExtension,
  readProjectBuffer,
} from "@runtime/policy-extension";
import { describe, expect, it } from "vitest";
import { fixtureProject } from "./support/edit-guard-harness";
import { tempDir } from "./support/temp-dir";

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return `data: ${JSON.stringify({
    id: "fixture",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } } : {}),
  })}\n\n`;
}

describe("edit guard in a Pi session", () => {
  it("answers a re-sent edit with already applied", async () => {
    const root = await realpath(await tempDir("dispatch-edit-guard-session-"));
    const path = join(root, "app.py");
    await writeFile(path, "def greet(name):\n    return 'hello ' + name\n");
    const edit = { oldText: "'hello ' + name", newText: "f'hello {name}'" };
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      bodies.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (bodies.length <= 2) {
        const call = {
          index: 0,
          id: `edit-${bodies.length}`,
          type: "function",
          function: { name: "edit", arguments: JSON.stringify({ path: "app.py", edits: [edit] }) },
        };
        res.write(chunk({ role: "assistant", tool_calls: [call] }, null));
        res.end(`${chunk({}, "tool_calls")}data: [DONE]\n\n`);
        return;
      }
      res.write(chunk({ role: "assistant", content: "done" }, null));
      res.end(`${chunk({}, "stop")}data: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const runtime = await pi.ModelRuntime.create({
        authPath: join(root, "empty-auth.json"),
        modelsPath: null,
        modelsStorePath: join(root, "model-cache"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      runtime.registerProvider("dispatch-edit-guard", {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        authHeader: true,
        models: [
          {
            id: "fixture",
            name: "fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 8192,
            maxTokens: 256,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      });
      await runtime.setRuntimeApiKey("dispatch-edit-guard", "synthetic");
      const policy: PolicyExtensionOptions = {
        projectRoot: root,
        cwd: root,
        project: fixtureProject(root),
        trust: "full",
        bashEnabled: false,
      };
      const guard = new EditGuard({
        cwd: root,
        projectRoot: root,
        readFile: (file) => readProjectBuffer(policy, file),
      });
      policy.fileViews = guard;
      const settings = pi.SettingsManager.inMemory(
        { retry: { enabled: false } },
        { projectTrusted: false },
      );
      const agentDir = join(root, "agent");
      await mkdir(agentDir);
      const loader = new pi.DefaultResourceLoader({
        ...lockedPiResources,
        cwd: root,
        agentDir,
        settingsManager: settings,
        noExtensions: true,
        extensionFactories: [projectPolicyExtension(policy), editGuardExtension(guard)],
      });
      await loader.reload();
      const { session } = await pi.createAgentSession({
        cwd: root,
        agentDir,
        model: runtime.getModel("dispatch-edit-guard", "fixture")!,
        modelRuntime: runtime,
        resourceLoader: loader,
        settingsManager: settings,
        sessionManager: pi.SessionManager.inMemory(root),
        tools: ["read", "write", "edit"],
        customTools: projectFileToolDefinitions(pi, policy) as never,
      });
      session.agent.toolExecution = "sequential";
      await session.prompt("Use an f-string in greet.");
      session.dispose();
      expect(await readFile(path, "utf8")).toBe("def greet(name):\n    return f'hello {name}'\n");
      expect(bodies).toHaveLength(3);
      const told = JSON.stringify(bodies[2].messages.filter((message) => message.role === "tool"));
      expect(told).toContain("Successfully replaced 1 block(s)");
      expect(told).toContain(
        "Already applied: the oldText is not in app.py, but the newText is, at line 2.",
      );
      expect(told).not.toContain("must match exactly");
      expect(guard.evidence()).toMatchObject({ edits: 2, failed: 1, alreadyApplied: 1 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("records the guard's evidence with the attempt", async () => {
    const base = await realpath(await tempDir("dispatch-edit-guard-attempt-"));
    const folder = join(base, "project");
    await mkdir(folder);
    const store = new FileStore(join(base, "data"));
    await store.init();
    await store.saveConnection({
      url: "http://fixture",
      token: "fixture",
      roles: {
        manager: { profileId: "coding", profileName: "coding", source: "interactive" },
        interactive: { profileId: "coding", profileName: "coding", source: "interactive" },
      },
    });
    const backend = new MemoryPoundlock();
    backend.listInteractiveModels = async () => [
      {
        id: "coding",
        context_tokens: 32768,
        max_output_tokens: 4096,
        dataDestination: "operator_network",
        workload_class: "interactive-coding",
      },
    ];
    const project = await createFolderProject({ store, folder });
    const evidence: EditGuardEvidence = {
      edits: 7,
      failed: 4,
      stale: 1,
      alreadyApplied: 1,
      noChange: 0,
      nearestMatch: 2,
      blocked: 1,
      loops: [{ path: "app.py", failures: 3, blocked: 1 }],
    };
    const worker: WorkerPort = {
      async run(ctx) {
        await writeFile(join(ctx.cwd, "app.py"), "x = 1\n");
        return {
          output: "Done",
          changedFiles: ["app.py"],
          patch: "+x = 1",
          verification: { status: "passed", commands: [] },
          editGuard: evidence,
        };
      },
    };
    const manager: ManagerPort = {
      async runTurn(ctx) {
        if (!(await store.getTasks(ctx.project.id)).length)
          await ctx.host.proposePlan({
            summary: "Write a file",
            acceptanceCriteria: ["The file exists"],
            tasks: [
              {
                title: "Write",
                objective: "Write",
                workerPrompt: "Write",
                acceptanceCriteria: "Exists",
                difficulty: "small",
                route: "interactive",
              },
            ],
          });
        return { text: "Recorded", toolTrace: [] };
      },
    };
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store,
      clientFor: async () => backend,
      manager,
      worker,
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(project.id, "Write a file");
    await engine.approvePlan(project.id);
    await engine.start(project.id);
    await engine.waitForLocal(project.id);
    const [task] = await store.getTasks(project.id);
    expect(task.attempts[0].result?.provenance?.editGuard).toEqual(evidence);
  });
});
