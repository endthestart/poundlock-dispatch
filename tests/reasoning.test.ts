import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { ManagerToolHost } from "@core/orchestration";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { createPiManager } from "@runtime/pi-manager";
import { applyReasoning, poundlockModelDefinition } from "@runtime/poundlock-provider";
import {
  conversationReasoningView,
  ReasoningUnsupportedError,
  resolveReasoning,
} from "@shared/reasoning";
import type { InteractiveModel, ProjectRecord } from "@shared/types";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./support/temp-dir";

const sol = {
  id: "frontier-gpt-sol",
  profileId: "sol-uuid",
  dataDestination: "external",
  reasoningLevels: ["none", "low", "high"],
} as InteractiveModel;
const local = { id: "vega-active", dataDestination: "operator_network" } as InteractiveModel;

describe("which reasoning a turn uses", () => {
  it("prefers the conversation, then the role, then none for an external manager", () => {
    expect(
      resolveReasoning({ model: sol, role: "manager", conversation: "high", roleDefault: "low" }),
    ).toEqual({ choice: "high", source: "conversation" });
    expect(resolveReasoning({ model: sol, role: "manager", roleDefault: "low" })).toEqual({
      choice: "low",
      source: "role",
    });
    expect(resolveReasoning({ model: sol, role: "manager" })).toEqual({
      choice: "none",
      source: "external_manager_default",
    });
    // Only the manager gets the external default; a worker runs at the model's own.
    expect(resolveReasoning({ model: sol, role: "interactive" }).choice).toBe("model_default");
    // Omitting is always possible, and is not the same as none.
    expect(
      resolveReasoning({ model: sol, role: "manager", conversation: "model_default" }).choice,
    ).toBe("model_default");
  });

  it("uses the model default when nothing was verified, and refuses rather than substitutes", () => {
    expect(resolveReasoning({ model: local, role: "manager" }).choice).toBe("model_default");
    expect(() => resolveReasoning({ model: local, role: "manager", roleDefault: "none" })).toThrow(
      ReasoningUnsupportedError,
    );
    expect(() => resolveReasoning({ model: sol, role: "manager", conversation: "medium" })).toThrow(
      /"medium" is not available.*verified: none, low, high/,
    );
  });

  it("shows the composer what the next turn will use", () => {
    const project = {
      policy: { managerModel: "" },
      reasoningOverride: undefined,
    } as unknown as ProjectRecord;
    const roles = {
      manager: { profileId: "sol-uuid", profileName: "frontier-gpt-sol", source: "interactive" },
    } as const;
    const view = conversationReasoningView({ project, roles, models: [sol] });
    expect(view.offered).toEqual(["model_default", "none", "low", "high"]);
    expect(view).toMatchObject({ effective: "none", defaultSource: "external_manager_default" });
    const broken = conversationReasoningView({
      project: { ...project, reasoningOverride: "medium" },
      roles,
      models: [sol],
    });
    expect(broken.effective).toBeUndefined();
    expect(broken.error).toMatch(/not available/);
  });
});

describe("what Pi is allowed to send", () => {
  it("registers reasoning only for verified levels, mapping the rest to null", () => {
    expect(poundlockModelDefinition(local)).toMatchObject({
      reasoning: false,
      compat: { supportsReasoningEffort: false },
    });
    const definition = poundlockModelDefinition(sol);
    expect(definition).toMatchObject({
      reasoning: true,
      compat: { supportsReasoningEffort: true },
    });
    expect(definition.thinkingLevelMap).toEqual({
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    });
  });

  it("sends exactly the chosen value, and stops a request Pi changed", async () => {
    const omit = applyReasoning({}, "model_default");
    expect(omit.reasoning).toBeUndefined();
    await expect(omit.onPayload?.({ model: "x" }, undefined as never)).resolves.toEqual({
      model: "x",
    });
    await expect(
      omit.onPayload?.({ reasoning_effort: "none" }, undefined as never),
    ).rejects.toThrow(/Nothing was sent/);

    const none = applyReasoning({}, "none");
    expect(none.reasoning).toBeUndefined();
    await expect(none.onPayload?.({ model: "x" }, undefined as never)).resolves.toEqual({
      model: "x",
      reasoning_effort: "none",
    });

    const prior = vi.fn((payload: unknown) => ({ ...(payload as object), prior: true }));
    const high = applyReasoning({ onPayload: prior }, "high");
    expect(high.reasoning).toBe("high");
    await expect(
      high.onPayload?.({ reasoning_effort: "high" }, undefined as never),
    ).resolves.toEqual({ reasoning_effort: "high", prior: true });
    expect(prior).toHaveBeenCalledOnce();
    // What Pi's clamp would do with an unmapped level: never let it through.
    await expect(
      high.onPayload?.({ reasoning_effort: "medium" }, undefined as never),
    ).rejects.toThrow(/would have sent reasoning "medium"/);
  });
});

/** The real Pi manager against a scripted OpenAI-compatible stream. */
async function withManager(
  model: { reasoningLevels?: InteractiveModel["reasoningLevels"] },
  reply: (request: number) => Record<string, unknown>,
  run: (
    manager: Awaited<ReturnType<typeof createPiManager>>,
    project: ProjectRecord,
    folder: string,
    requests: Array<Record<string, unknown>>,
  ) => Promise<void>,
) {
  const root = await tempDir("dispatch-reasoning-");
  const folder = join(root, "project");
  await mkdir(folder);
  const store = new FileStore(join(root, "data"));
  await store.init();
  const project = await createFolderProject({ store, folder });
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const delta = reply(requests.length);
    const toolCall = Boolean(delta.tool_calls);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`,
    );
    res.end(
      `data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const manager = await createPiManager({
    store,
    controllerUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    token: "synthetic",
    modelName: "frontier-gpt-sol",
    modelProfileId: "sol-uuid",
    contextTokens: 32768,
    maxOutputTokens: 2048,
    reasoningLevels: model.reasoningLevels,
    capabilities: { api_major: 1, contract_revision: 4, features: [] },
  });
  try {
    await run(manager, project, folder, requests);
  } finally {
    await manager.abort?.(project.id);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it("the Pi manager sends each turn's reasoning as chosen, on a cached session", async () => {
  await withManager(
    { reasoningLevels: ["none", "low", "high"] },
    () => ({ content: "Done." }),
    async (manager, project, folder, requests) => {
      const turn = (reasoning?: "none" | "high" | "model_default") =>
        manager.runTurn({
          project,
          workspace: folder,
          prompt: "Reply",
          host: {} as ManagerToolHost,
          reasoning,
        });
      expect((await turn()).reasoning).toBe("model_default");
      expect((await turn("none")).reasoning).toBe("none");
      expect((await turn("high")).reasoning).toBe("high");
      await turn("model_default");
      expect(requests.map((request) => request.reasoning_effort)).toEqual([
        undefined,
        "none",
        "high",
        undefined,
      ]);
      expect(requests.every((request) => !("reasoning" in request))).toBe(true);

      await expect(
        manager.runTurn({
          project,
          workspace: folder,
          prompt: "Reply",
          host: {} as ManagerToolHost,
          reasoning: "medium",
        }),
      ).rejects.toThrow(ReasoningUnsupportedError);
      expect(requests).toHaveLength(4);
    },
  );
}, 20000);

it("a profile with no verified levels never sends a reasoning parameter", async () => {
  await withManager(
    {},
    () => ({ content: "Done." }),
    async (manager, project, folder, requests) => {
      await manager.runTurn({
        project,
        workspace: folder,
        prompt: "Reply",
        host: {} as ManagerToolHost,
      });
      await expect(
        manager.runTurn({
          project,
          workspace: folder,
          prompt: "Reply",
          host: {} as ManagerToolHost,
          reasoning: "none",
        }),
      ).rejects.toThrow(/only Model default/);
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toHaveProperty("reasoning_effort");
    },
  );
}, 20000);

it("keeps what the manager said before a tool ended its turn", async () => {
  await withManager(
    {},
    () => ({
      content: "I checked the layout; one question first.",
      tool_calls: [
        {
          index: 0,
          id: "ask-1",
          type: "function",
          function: { name: "ask_user", arguments: JSON.stringify({ question: "Which title?" }) },
        },
      ],
    }),
    async (manager, project, folder) => {
      const drafts: Array<string | undefined> = [];
      const result = await manager.runTurn({
        project,
        workspace: folder,
        prompt: "Plan",
        host: { askUser: vi.fn(async () => "Waiting for the user.") } as unknown as ManagerToolHost,
        onDraft: (text) => drafts.push(text),
      });
      expect(result.toolTrace).toEqual([{ name: "ask_user", summary: "ask_user", error: false }]);
      expect(result.text).toBe("I checked the layout; one question first.");
      expect(drafts).toContain("I checked the layout; one question first.");
    },
  );
}, 20000);
