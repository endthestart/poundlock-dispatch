/**
 * The real Pi manager against a synthetic inference server, for tests that
 * need Pi's own compaction to run: its decision reads the usage the server
 * reports, and its summary requests are real requests the test can read.
 */
import { mkdir, readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { ManagerToolHost } from "@core/orchestration";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { createPiManager } from "@runtime/pi-manager";
import { tempDir } from "./temp-dir";

export interface SyntheticRequest {
  messages: Array<{ role: string; content: unknown }>;
}

export const text = (content: unknown): string =>
  typeof content === "string" ? content : JSON.stringify(content);
export const systemOf = (request: SyntheticRequest) =>
  text(request.messages.find((m) => m.role === "system")?.content);
export const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
export const isSummary = (request: SyntheticRequest) =>
  systemOf(request).includes("context summarization assistant");

/** Every stored Pi session under the data directory, as one string. */
export async function storedSessions(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  const texts = await Promise.all(
    files.map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
  );
  return texts.join("\n");
}

export type SyntheticManager = Awaited<ReturnType<typeof createPiManager>>;

/**
 * `reply` decides what the model says to each request; `usage` is what the
 * server reports as used, which is what Pi's compaction decision reads; `hold`
 * delays a response, so a test can act while a request is in flight.
 */
export async function withManager(
  options: {
    contextTokens?: number;
    maxOutputTokens?: number;
    usage?: (request: number) => number;
    reply?: (request: number) => Record<string, unknown> | undefined;
    hold?: (request: number) => Promise<void> | undefined;
  },
  run: (context: {
    manager: SyntheticManager;
    /** Another manager on the same data and server, as after a restart. */
    restart: () => Promise<SyntheticManager>;
    project: Awaited<ReturnType<typeof createFolderProject>>;
    folder: string;
    data: string;
    requests: SyntheticRequest[];
  }) => Promise<void>,
) {
  const root = await tempDir("dispatch-pi-context-");
  const folder = join(root, "project");
  await mkdir(folder);
  const data = join(root, "data");
  const store = new FileStore(data);
  await store.init();
  const project = await createFolderProject({ store, folder });
  const requests: SyntheticRequest[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.includes("/api/v1/capabilities")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ api_major: 1, contract_revision: 2, features: [] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const n = requests.length;
    await options.hold?.(n);
    const delta = options.reply?.(n) ?? { role: "assistant", content: `Answer ${n}.` };
    const tool = "tool_calls" in delta;
    const total = options.usage?.(n) ?? 500;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.end(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: total - 20, completion_tokens: 20, total_tokens: total } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const managers: SyntheticManager[] = [];
  const create = async () => {
    const manager = await createPiManager({
      store,
      controllerUrl: `http://127.0.0.1:${address.port}`,
      token: "synthetic",
      modelName: "fixture",
      modelProfileId: "fixture-uuid",
      contextTokens: options.contextTokens ?? 32768,
      maxOutputTokens: options.maxOutputTokens ?? 2048,
      capabilities: { api_major: 1, contract_revision: 2, features: [] },
    });
    managers.push(manager);
    return manager;
  };
  const manager = await create();
  try {
    await run({ manager, restart: create, project, folder, data, requests });
  } finally {
    for (const each of managers) await each.abort?.(project.id);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** A tool host for a turn that calls no tool. */
export const noTools = {} as ManagerToolHost;
