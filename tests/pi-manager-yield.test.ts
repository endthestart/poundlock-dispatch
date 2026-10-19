import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { ManagerToolHost, ProposePlanInput } from "@core/orchestration";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { compileTaskHints } from "@core/task-hints";
import { compactionReserve, createPiManager, extractAssistantText } from "@runtime/pi-manager";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./support/temp-dir";

it("keeps text streamed before a tool call in the completed manager reply", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "Earlier conversation" }] },
    { role: "user", content: "New question" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Detailed analysis" },
        { type: "toolCall", name: "write_notes" },
      ],
    },
    { role: "toolResult", content: "Notes saved" },
    { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
  ];
  expect(extractAssistantText({ messages }, 1)).toBe("Detailed analysis\n\nFinal answer");
});

async function withSyntheticManager(
  response: (request: number) => { delta: Record<string, unknown>; finishReason: string },
  run: (
    manager: Awaited<ReturnType<typeof createPiManager>>,
    project: Awaited<ReturnType<typeof createFolderProject>>,
    folder: string,
    requests: Array<{ messages?: Array<{ role: string; content: unknown }> }>,
    store: FileStore,
  ) => Promise<void>,
  extra: { webSearch?: { url: string } } = {},
) {
  const root = await tempDir("dispatch-pi-response-");
  const folder = join(root, "project");
  await mkdir(folder);
  const store = new FileStore(join(root, "data"));
  await store.init();
  const project = await createFolderProject({ store, folder });
  let request = 0;
  const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.includes("/api/v1/capabilities")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ api_major: 1, contract_revision: 2, features: [] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const current = response(++request);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: current.delta, finish_reason: null }] })}\n\n`,
    );
    res.end(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: current.finishReason }], usage: { prompt_tokens: 3925, completion_tokens: 171, total_tokens: 4096 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const manager = await createPiManager({
    store,
    controllerUrl: `http://127.0.0.1:${address.port}`,
    token: "synthetic",
    modelName: "fixture",
    modelProfileId: "fixture-uuid",
    contextTokens: 32768,
    maxOutputTokens: 2048,
    capabilities: { api_major: 1, contract_revision: 2, features: [] },
    ...extra,
  });
  try {
    await run(manager, project, folder, requests, store);
  } finally {
    await manager.abort?.(project.id);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function planCall(argumentsValue: Record<string, unknown>) {
  return {
    delta: {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "plan-fixture",
          type: "function",
          function: { name: "propose_plan", arguments: JSON.stringify(argumentsValue) },
        },
      ],
    },
    finishReason: "tool_calls",
  };
}

function validPlan() {
  return {
    summary: "Build the requested project",
    acceptanceCriteria: ["The project check passes"],
    environmentNeed: "none",
    allowDependencyDownloads: false,
    tasks: [
      {
        title: "Build project",
        objective: "Implement the requested project",
        workerPrompt: "Implement the project and run its checks.",
        acceptanceCriteria: "The project check passes",
        difficulty: "small",
        taskKind: "closed_implementation",
        route: "interactive",
      },
    ],
  };
}

it.each([4096, 32768])(
  "the actual Pi manager at %s context yields after asking and continues on reply",
  async (contextTokens) => {
    const root = await tempDir("dispatch-pi-yield-");
    const folder = join(root, "project");
    await mkdir(folder);
    const store = new FileStore(join(root, "data"));
    await store.init();
    const project = await createFolderProject({ store, folder });
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const server = createServer(async (req, res) => {
      if (req.method === "GET" && req.url?.includes("/api/v1/capabilities")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ api_major: 1, contract_revision: 2, features: [] }));
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const delta =
        requests.length === 1
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "ask-1",
                  type: "function",
                  function: {
                    name: "ask_user",
                    arguments: JSON.stringify({ question: "Which title?" }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "Understood, use the requested title." };
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      res.end(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const host = {
      askUser: vi.fn(async () => "Waiting for the user."),
    } as unknown as ManagerToolHost;
    const address = server.address() as { port: number };
    const manager = await createPiManager({
      store,
      controllerUrl: `http://127.0.0.1:${address.port}`,
      token: "synthetic",
      modelName: "fixture",
      modelProfileId: "fixture-uuid",
      contextTokens,
      maxOutputTokens: 1024,
      capabilities: { api_major: 1, contract_revision: 2, features: [] },
    });
    try {
      const first = await manager.runTurn({
        project,
        workspace: folder,
        prompt: "Ask me which title",
        host,
      });
      expect(host.askUser).toHaveBeenCalledWith("Which title?", undefined);
      expect(first.toolTrace).toEqual([{ name: "ask_user", summary: "ask_user", error: false }]);
      expect(requests).toHaveLength(1);
      const second = await manager.runTurn({
        project,
        workspace: folder,
        prompt: "Use Sample",
        host,
      });
      expect(second.text).toContain("Understood");
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1].messages)).toContain("Which title?");
      await manager.reset?.(project.id);
      project.managerSessionId = "new-conversation";
      project.freshConversation = true;
      await manager.runTurn({
        project,
        workspace: folder,
        prompt: "Start a fresh discussion",
        host,
      });
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[2].messages)).not.toContain("Which title?");
    } finally {
      await manager.abort?.(project.id);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  15000,
);

it("reports a provider token-limit response instead of returning an empty reply", async () => {
  await withSyntheticManager(
    () => ({
      delta: { role: "assistant", reasoning_content: "I should inspect the project" },
      finishReason: "length",
    }),
    async (manager, project, folder) => {
      await expect(
        manager.runTurn({
          project,
          workspace: folder,
          prompt: "Plan the work",
          host: {} as ManagerToolHost,
        }),
      ).rejects.toThrow(/token limit.*4,096.*did not complete/i);
    },
  );
}, 15000);

it("accepts a valid plan with tasks as an array", async () => {
  await withSyntheticManager(
    () => planCall(validPlan()),
    async (manager, project, folder, requests) => {
      const host = {
        proposePlan: vi.fn(async () => "Plan recorded."),
      } as unknown as ManagerToolHost;
      const result = await manager.runTurn({
        project,
        workspace: folder,
        prompt: "Plan the work",
        host,
      });
      expect(host.proposePlan).toHaveBeenCalledOnce();
      expect(result.toolTrace).toEqual([
        { name: "propose_plan", summary: "propose_plan", error: false },
      ]);
      expect(requests).toHaveLength(1);
    },
  );
}, 15000);

it.each([
  ["valid nested JSON", JSON.stringify(validPlan().tasks)],
  ["malformed nested JSON", '[{"title":"Build project"'],
])(
  "gives one focused correction when tasks is %s",
  async (_label, tasks) => {
    await withSyntheticManager(
      (request) => planCall(request === 1 ? { ...validPlan(), tasks } : validPlan()),
      async (manager, project, folder, requests) => {
        const host = {
          proposePlan: vi.fn(async () => "Plan recorded."),
        } as unknown as ManagerToolHost;
        const result = await manager.runTurn({
          project,
          workspace: folder,
          prompt: "Plan the work",
          host,
        });
        expect(host.proposePlan).toHaveBeenCalledOnce();
        expect(result.toolTrace).toEqual([
          { name: "propose_plan", summary: "propose_plan", error: true },
          { name: "propose_plan", summary: "propose_plan", error: false },
        ]);
        expect(requests).toHaveLength(2);
        const retryContext = JSON.stringify(requests[1].messages);
        expect(retryContext).toContain("plan_validation_failed");
        expect(retryContext).toContain("tasks");
        expect(retryContext).not.toContain("Received arguments");
        expect(retryContext).not.toContain('Build project\\"');
      },
    );
  },
  15000,
);

const withHints = (hints: Record<string, unknown>) => {
  const plan = validPlan();
  return { ...plan, tasks: [{ ...plan.tasks[0], ...hints }] };
};

it("gives the manager web search only where the owner set it up and the project turned it on", async () => {
  const toolsOf = (request: unknown) =>
    ((request as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map(
      (tool) => tool.function.name,
    );
  const reply = () => ({ delta: { role: "assistant", content: "Noted." }, finishReason: "stop" });
  const host = {} as ManagerToolHost;
  await withSyntheticManager(
    reply,
    async (manager, project, folder, requests) => {
      project.policy.network = { webSearch: true };
      await manager.runTurn({ project, workspace: folder, prompt: "Hello", host });
      expect(toolsOf(requests[0])).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
    },
    { webSearch: { url: "http://127.0.0.1:8888" } },
  );
  // The project's switch is off: no web tools, even with an instance set up.
  await withSyntheticManager(
    reply,
    async (manager, project, folder, requests) => {
      await manager.runTurn({ project, workspace: folder, prompt: "Hello", host });
      expect(toolsOf(requests[0])).not.toContain("web_search");
    },
    { webSearch: { url: "http://127.0.0.1:8888" } },
  );
}, 15000);

it("passes a task's context note, files to touch and reuse through propose_plan", async () => {
  const hints = {
    contextNote: "The router already strips accents.",
    filesToTouch: ["src/core/slug.ts", "tests/slug.test.ts"],
    reuse: ["slugify() in src/util/text.ts"],
  };
  await withSyntheticManager(
    () => planCall(withHints(hints)),
    async (manager, project, folder, requests) => {
      const host = {
        proposePlan: vi.fn(async () => "Plan recorded."),
      } as unknown as ManagerToolHost;
      await manager.runTurn({ project, workspace: folder, prompt: "Plan the work", host });
      expect(requests).toHaveLength(1);
      expect(host.proposePlan).toHaveBeenCalledOnce();
      expect(vi.mocked(host.proposePlan).mock.calls[0][0].tasks[0]).toMatchObject(hints);
      // The schema tells the model what each field is for.
      const schema = JSON.stringify(
        (requests[0] as { tools?: unknown[] }).tools?.find(
          (tool) => (tool as { function: { name: string } }).function.name === "propose_plan",
        ),
      );
      expect(schema).toContain("filesToTouch");
      expect(schema).toContain("Only ones you know");
    },
  );
}, 15000);

it.each([
  ["a path outside the project", { filesToTouch: ["/etc/passwd"] }, "must be relative"],
  ["an object in place of a string", { reuse: [{ path: "src/util/text.ts" }] }, "non-empty string"],
])(
  "gives one focused correction for %s in a task's hints",
  async (_label, hints, reason) => {
    await withSyntheticManager(
      (request) => planCall(request === 1 ? withHints(hints) : validPlan()),
      async (manager, project, folder, requests) => {
        const host = {
          // What the real host does: the plan compiler refuses an unusable hint.
          proposePlan: vi.fn(async (input: ProposePlanInput) => {
            for (const task of input.tasks) compileTaskHints(task);
            return "Plan recorded.";
          }),
        } as unknown as ManagerToolHost;
        await manager.runTurn({ project, workspace: folder, prompt: "Plan the work", host });
        expect(requests).toHaveLength(2);
        const retryContext = JSON.stringify(requests[1].messages);
        expect(retryContext).toContain("plan_validation_failed");
        expect(retryContext).toContain(`tasks[0].${Object.keys(hints)[0]}`);
        expect(retryContext).toContain(reason);
      },
    );
  },
  15000,
);

it("stops after one failed plan correction without persisting a partial plan", async () => {
  await withSyntheticManager(
    () => planCall({ ...validPlan(), tasks: JSON.stringify(validPlan().tasks) }),
    async (manager, project, folder, requests, store) => {
      const host = {
        proposePlan: vi.fn(async () => "Plan recorded."),
      } as unknown as ManagerToolHost;
      await expect(
        manager.runTurn({
          project,
          workspace: folder,
          prompt: "Plan the work",
          host,
        }),
      ).rejects.toThrow(/could not correct the plan after one retry.*No new plan or tasks/i);
      expect(requests).toHaveLength(2);
      expect(host.proposePlan).not.toHaveBeenCalled();
      expect(await store.getPlan(project.id)).toBeUndefined();
      expect(await store.getTasks(project.id)).toEqual([]);
    },
  );
}, 15000);

function toolCall(name: string, argumentsValue: Record<string, unknown>) {
  return {
    delta: {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: `${name}-fixture`,
          type: "function",
          function: { name, arguments: JSON.stringify(argumentsValue) },
        },
      ],
    },
    finishReason: "tool_calls",
  };
}

it.each([
  [
    "delegate_task",
    {
      title: "Write ADR",
      objective: "Record the decision",
      workerPrompt: "Write the ADR",
      acceptanceCriteria: "ADR exists",
      difficulty: "small",
      taskKind: "closed_implementation",
    },
    { delegateTask: vi.fn(async () => "Delegated.") },
  ],
  [
    "request_repair",
    { taskId: "task-1", findings: "Tests failed." },
    { requestRepair: vi.fn(async () => "Repair queued.") },
  ],
  [
    "request_escalation",
    { target: "worker", findings: "Local repair is insufficient." },
    { requestEscalation: vi.fn(async () => "Escalation recorded.") },
  ],
  [
    "request_apply_result",
    { taskId: "task-1" },
    { requestApplyResult: vi.fn(async () => "Applied.") },
  ],
  ["mark_complete", { summary: "Done." }, { markComplete: vi.fn(async () => "Complete.") }],
] as const)(
  "yields after terminating manager tool %s without an empty-reply failure",
  async (name, args, hostFns) => {
    await withSyntheticManager(
      () => toolCall(name, args),
      async (manager, project, folder, requests) => {
        const host = hostFns as unknown as ManagerToolHost;
        const result = await manager.runTurn({
          project,
          workspace: folder,
          prompt: "Continue",
          host,
        });
        expect(result.toolTrace).toEqual([{ name, summary: name, error: false }]);
        expect(result.text).toBe("");
        expect(requests).toHaveLength(1);
      },
    );
  },
  15000,
);

describe("the manager's room to answer before compaction", () => {
  // Pi compacts once history reaches context − reserve, and then offers at
  // most reserve − 4096 tokens of output. So the reserve decides the largest
  // reply the manager can still write just before it compacts.
  const replyRoom = (context: number, output: number) => compactionReserve(context, output) - 4096;

  it("leaves a 32K manager room for a whole detailed plan", () => {
    // A detailed plan on the workstation needed ~4,200 tokens; the old quarter-of-
    // the-window reserve left 4,096.
    expect(replyRoom(32_768, 8192)).toBeGreaterThanOrEqual(4200);
    expect(replyRoom(32_768, 8192)).toBe(8192);
  });

  it("never reserves more than half the window", () => {
    expect(compactionReserve(8192, 8192)).toBe(4096);
    expect(compactionReserve(65_536, 8192)).toBe(12_288);
  });
});
