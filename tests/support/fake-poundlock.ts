import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One chat request as the fake controller received it. */
export interface ChatRequest {
  model: string;
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>;
  tools?: Array<{ function?: { name?: string } }>;
}

/** What the scripted model answers: tool calls, text, an HTTP error, or nothing at all. */
export interface ScriptedTurn {
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  text?: string;
  /** An HTTP status other than 200, with a Poundlock error body. */
  status?: number;
  code?: string;
  /** Never answer: the request stays open until the server closes. */
  hang?: boolean;
  /** Answer only once this settles. */
  delay?: Promise<unknown>;
  /** End the reply as cut off at the output limit. */
  cutOff?: boolean;
}

export interface FakePoundlockOptions {
  token?: string;
  model?: {
    id?: string;
    profileId?: string;
    contextTokens?: number;
    destination?: "operator_network" | "external";
    routingRevision?: string;
  };
  respond: (request: ChatRequest, index: number) => ScriptedTurn | Promise<ScriptedTurn>;
}

const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

async function body(req: IncomingMessage): Promise<string> {
  let text = "";
  for await (const part of req) text += part;
  return text;
}

/**
 * A Poundlock controller for offline tests: the model list, capabilities, the
 * access preflight and an OpenAI-compatible streaming `/v1/chat/completions`
 * answered by a script. Nothing leaves the machine.
 */
export async function fakePoundlock(options: FakePoundlockOptions) {
  const token = options.token ?? "test-token";
  const model = {
    id: options.model?.id ?? "gate-model",
    profileId: options.model?.profileId ?? "p-gate",
    contextTokens: options.model?.contextTokens ?? 131_072,
    destination: options.model?.destination ?? "operator_network",
    routingRevision: options.model?.routingRevision ?? "r1",
  };
  const requests: ChatRequest[] = [];
  const counts = { preflight: 0, models: 0, capabilities: 0 };
  const open = new Set<ServerResponse>();
  let chats = 0;
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    const text = await body(req);
    if (req.headers.authorization !== `Bearer ${token}`)
      return json(res, 401, { error: { code: "unauthorized", message: "bad token" } });
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/v1/models") {
      counts.models++;
      return json(res, 200, {
        data: [
          {
            id: model.id,
            poundlock: {
              canonical_name: model.id,
              profile_id: model.profileId,
              context_tokens: model.contextTokens,
              max_output_tokens: 8192,
              uses: ["interactive"],
              data_destination: model.destination,
              routing_revision: model.routingRevision,
            },
          },
        ],
      });
    }
    if (req.method === "GET" && path === "/api/v1/capabilities") {
      counts.capabilities++;
      return json(res, 200, { api_major: 1, contract_revision: 4, features: ["access_preflight"] });
    }
    if (req.method === "POST" && path === "/api/v1/access/preflight") {
      counts.preflight++;
      return json(res, 200, {
        operation: "inference",
        access_state: "ready",
        profile_id: model.profileId,
        data_destination: model.destination,
      });
    }
    if (req.method === "POST" && path === "/v1/chat/completions") {
      const request = JSON.parse(text) as ChatRequest;
      requests.push(request);
      const turn = await options.respond(request, chats++);
      if (turn.delay) await turn.delay;
      if (turn.hang) {
        open.add(res);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        return;
      }
      if (turn.status && turn.status !== 200)
        return json(res, turn.status, {
          error: { code: turn.code ?? "error", message: `scripted ${turn.status}` },
        });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const base = { id: `c${chats}`, object: "chat.completion.chunk", model: model.id };
      if (turn.toolCalls?.length) {
        res.write(
          chunk({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: turn.toolCalls.map((call, index) => ({
                    index,
                    id: `call-${chats}-${index}`,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  })),
                },
                finish_reason: null,
              },
            ],
          }),
        );
      } else {
        res.write(
          chunk({
            ...base,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: turn.text ?? "" },
                finish_reason: null,
              },
            ],
          }),
        );
      }
      res.end(
        chunk({
          ...base,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: turn.cutOff
                ? "length"
                : turn.toolCalls?.length
                  ? "tool_calls"
                  : "stop",
            },
          ],
          // A cut-off reply used the whole output allowance (the gate models' 8,192).
          usage: turn.cutOff
            ? { prompt_tokens: 100, completion_tokens: 8192, total_tokens: 8292 }
            : { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }) + "data: [DONE]\n\n",
      );
      return;
    }
    json(res, 404, { error: { code: "not_found", message: path } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    token,
    model,
    requests,
    counts,
    async close() {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** The text of a chat message, whether a string or content parts. */
export function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content))
    return message.content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("");
  return "";
}

/** Tool calls the model made since the last user message, oldest first. */
export function callsSinceLastUser(request: ChatRequest): string[] {
  const lastUser = request.messages.map((m) => m.role).lastIndexOf("user");
  return request.messages
    .slice(lastUser + 1)
    .flatMap((m) => (m.tool_calls ?? []) as Array<{ function?: { name?: string } }>)
    .map((call) => call.function?.name ?? "");
}
