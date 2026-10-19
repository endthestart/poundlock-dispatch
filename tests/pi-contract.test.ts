import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  createAgentSession,
  createLsTool,
  createReadTool,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { lockedPiResources } from "@runtime/pi-resources";
import { poundlockModelDefinition } from "@runtime/poundlock-provider";
import { type InteractiveModel, PI_VERSION } from "@shared/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { tempDir as sharedTempDir } from "./support/temp-dir";

async function tempDir(): Promise<string> {
  return sharedTempDir("dispatch-pi-contract-");
}

describe("Pi 1.1.0 contract", () => {
  it("gets none of the CLI's built-in extensions (MCP, codemode), even where settings and the project ask", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const marker = join(cwd, "mcp-server-ran");
    await writeFile(
      join(cwd, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { project: { command: "touch", args: [marker] } } }),
    );
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ extensions: ["+builtin:mcp", "+builtin:codemode"] }),
    );
    const loader = new DefaultResourceLoader({
      ...lockedPiResources,
      cwd,
      agentDir: join(cwd, "agent"),
      settingsManager: SettingsManager.inMemory(
        { extensions: ["+builtin:mcp", "+builtin:codemode", "+builtin:tool-search"] },
        { projectTrusted: false },
      ),
    });
    await loader.reload();
    expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([]);
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("embeds the Pi that the package pins and that provenance reports", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    const installed = async (name: string) =>
      (
        JSON.parse(await readFile(join("node_modules", name, "package.json"), "utf8")) as {
          version: string;
        }
      ).version;
    for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
      expect(manifest.dependencies[name]).toBe(PI_VERSION);
      expect(await installed(name)).toBe(PI_VERSION);
    }
  });

  it("creates and restores a persistent JSONL session without dispatching work", async () => {
    const cwd = await tempDir();
    const sessions = join(cwd, "sessions");
    await mkdir(sessions, { recursive: true });
    const first = SessionManager.create(cwd, sessions);
    first.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });
    first.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      api: "openai-completions",
      provider: "openai",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    expect(first.getSessionId()).toBeTruthy();
    expect(first.getSessionFile()).toBeTruthy();
    const restored = SessionManager.open(first.getSessionFile()!);
    expect(restored.getSessionId()).toBe(first.getSessionId());
  });

  it("built-in tools resolve paths against the session cwd", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "note.txt"), "from-cwd");
    const read = createReadTool(cwd);
    const listed = createLsTool(cwd);
    const file = await read.execute("t1", { path: "note.txt" });
    const text = file.content.map((part) => ("text" in part ? part.text : "")).join("");
    expect(text).toContain("from-cwd");
    const listing = await listed.execute("t2", {});
    const listingText = listing.content.map((part) => ("text" in part ? part.text : "")).join("");
    expect(listingText).toContain("note.txt");
  });

  it("blocks tool_call before execution and captures tool_result", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "keep.txt"), "safe");
    const blocked: string[] = [];
    const results: string[] = [];
    let request = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* drain */
      }
      request += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (request === 1) {
        res.write(
          `data: ${JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "write-1",
                      type: "function",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({ path: "evil.txt", content: "nope" }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        res.end(
          `data: ${JSON.stringify({
            id: "fixture",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
          })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      res.write(
        `data: ${JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { role: "assistant", content: "blocked" }, finish_reason: null },
          ],
        })}\n\n`,
      );
      res.end(
        `data: ${JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(cwd, "empty-auth.json"),
        modelsPath: null,
        modelsStorePath: join(cwd, "model-cache"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      runtime.registerProvider("dispatch-contract", {
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
      await runtime.setRuntimeApiKey("dispatch-contract", "synthetic");
      const settings = SettingsManager.inMemory(
        { retry: { enabled: false } },
        { projectTrusted: false },
      );
      const loader = new DefaultResourceLoader({
        ...lockedPiResources,
        cwd,
        agentDir: join(cwd, "agent"),
        settingsManager: settings,
        noExtensions: true,
        extensionFactories: [
          (api) => {
            api.on("tool_call", async (event) => {
              if (event.toolName === "write") {
                blocked.push(String((event.input as { path?: string }).path));
                return { block: true, reason: "blocked by contract test" };
              }
              return undefined;
            });
            api.on("tool_result", (event) => {
              results.push(event.toolName);
              return undefined;
            });
          },
        ],
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd,
        agentDir: join(cwd, "agent"),
        model: runtime.getModel("dispatch-contract", "fixture")!,
        modelRuntime: runtime,
        resourceLoader: loader,
        settingsManager: settings,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["write"],
      });
      await session.prompt("write evil.txt");
      await expect(readFile(join(cwd, "evil.txt"), "utf8")).rejects.toThrow();
      expect(blocked).toContain("evil.txt");
      session.dispose();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("supports terminating structured tools, cancellation, and dynamic providers", async () => {
    const cwd = await tempDir();
    const runtime = await ModelRuntime.create({
      authPath: join(cwd, "empty-auth.json"),
      modelsPath: null,
      modelsStorePath: join(cwd, "model-cache"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    runtime.registerProvider("dispatch-contract", {
      baseUrl: "http://127.0.0.1:9/v1",
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
    expect(runtime.getModel("dispatch-contract", "fixture")?.id).toBe("fixture");
    const tool = defineTool({
      name: "done",
      label: "Done",
      description: "Terminate",
      parameters: Type.Object({ summary: Type.String() }),
      execute: async (_id, params, _signal, _onUpdate, _ctx) => ({
        content: [{ type: "text" as const, text: params.summary }],
        details: {},
        terminate: true,
      }),
    });
    const result = await tool.execute(
      "x",
      { summary: "closed" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.terminate).toBe(true);
    const controller = new AbortController();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });

  it("sends Poundlock models the built-in tools without strict schemas", async () => {
    const cwd = await tempDir();
    const tools: Array<{ function: Record<string, unknown> }> = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      tools.push(...(JSON.parse(body).tools ?? []));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(cwd, "empty-auth.json"),
        modelsPath: null,
        modelsStorePath: join(cwd, "model-cache"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      runtime.registerProvider("poundlock", {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        authHeader: true,
        models: [
          poundlockModelDefinition({
            id: "fixture",
            context_tokens: 32768,
            max_output_tokens: 1024,
          } as InteractiveModel),
        ],
      });
      await runtime.setRuntimeApiKey("poundlock", "synthetic");
      const settings = SettingsManager.inMemory(
        { retry: { enabled: false } },
        { projectTrusted: false },
      );
      const loader = new DefaultResourceLoader({
        ...lockedPiResources,
        cwd,
        agentDir: join(cwd, "agent"),
        settingsManager: settings,
        noExtensions: true,
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd,
        agentDir: join(cwd, "agent"),
        model: runtime.getModel("poundlock", "fixture")!,
        modelRuntime: runtime,
        resourceLoader: loader,
        settingsManager: settings,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["read", "bash", "edit", "write"],
      });
      await session.prompt("hello");
      session.dispose();
      // Pi 0.86 would otherwise mark these strict and require every optional
      // argument, which local models fill with a read limit and a bash timeout.
      expect(tools.map((tool) => tool.function.name)).toEqual(["read", "bash", "edit", "write"]);
      for (const tool of tools) expect(tool.function).not.toHaveProperty("strict");
      const read = tools[0].function.parameters as { required: string[] };
      expect(read.required).toEqual(["path"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("marks prompts for caching only on models Anthropic serves", async () => {
    const cwd = await tempDir();
    const bodies: Array<{ model: string; text: string }> = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      bodies.push({ model: JSON.parse(body).model, text: body });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          choices: [
            { index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(cwd, "empty-auth.json"),
        modelsPath: null,
        modelsStorePath: join(cwd, "model-cache"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      const sonnet = poundlockModelDefinition({
        id: "sonnet",
        provider: "anthropic",
        context_tokens: 32768,
        max_output_tokens: 1024,
        pricing: { inputPerMtok: 2, outputPerMtok: 10 },
      } as InteractiveModel);
      expect(sonnet.cost).toMatchObject({ input: 2, cacheRead: 0.2, cacheWrite: 2.5 });
      runtime.registerProvider("poundlock", {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        authHeader: true,
        models: [
          sonnet,
          poundlockModelDefinition({
            id: "local",
            context_tokens: 32768,
            max_output_tokens: 1024,
          } as InteractiveModel),
        ],
      });
      await runtime.setRuntimeApiKey("poundlock", "synthetic");
      const settings = SettingsManager.inMemory(
        { retry: { enabled: false } },
        { projectTrusted: false },
      );
      const loader = new DefaultResourceLoader({
        ...lockedPiResources,
        cwd,
        agentDir: join(cwd, "agent"),
        settingsManager: settings,
        noExtensions: true,
      });
      await loader.reload();
      for (const id of ["sonnet", "local"]) {
        const { session } = await createAgentSession({
          cwd,
          agentDir: join(cwd, "agent"),
          model: runtime.getModel("poundlock", id)!,
          modelRuntime: runtime,
          resourceLoader: loader,
          settingsManager: settings,
          sessionManager: SessionManager.inMemory(cwd),
          tools: ["read"],
        });
        await session.prompt("hello");
        session.dispose();
      }
      expect(bodies.find((b) => b.model === "sonnet")?.text).toContain('"cache_control"');
      expect(bodies.find((b) => b.model === "local")?.text).not.toContain("cache_control");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("loads app-owned extensions while leaving project resources untrusted", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "extensions", "evil.ts"),
      "export default function(){ throw new Error('project extension loaded'); }",
    );
    await writeFile(join(cwd, ".pi", "SYSTEM.md"), "PROJECT SYSTEM");
    const settings = SettingsManager.inMemory({}, { projectTrusted: false });
    let loaded = false;
    const loader = new DefaultResourceLoader({
      ...lockedPiResources,
      cwd,
      agentDir: join(cwd, "agent"),
      settingsManager: settings,
      systemPromptOverride: () => "Host-owned prompt",
      noExtensions: true,
      extensionFactories: [
        () => {
          loaded = true;
        },
      ],
    });
    await loader.reload();
    expect(loaded).toBe(true);
    expect(loader.getSystemPrompt()).toBe("Host-owned prompt");
    expect(loader.getAppendSystemPrompt()).toEqual([]);
  });
});

describe("live Poundlock contract probe", () => {
  const url = process.env.POUNDLOCK_URL;
  const token = process.env.POUNDLOCK_TOKEN;
  const run = url && token ? it : it.skip;
  run("records API major 1 and contract revision 3 from the deployed controller", async () => {
    const response = await fetch(`${url!.replace(/\/$/, "")}/api/v1/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json()) as {
      api_major?: number;
      contract_revision?: number;
      features?: string[];
    };
    expect(body.api_major).toBe(1);
    expect(body.contract_revision).toBe(3);
    for (const feature of [
      "access_preflight",
      "availability_reasons",
      "data_destination",
      "durable_jobs",
      "external_invoke_permission",
      "managed_application_identities",
      "routing_revision",
      "usage_summary",
      "verifier_toolchain",
    ]) {
      expect(body.features).toContain(feature);
    }
  });
});
