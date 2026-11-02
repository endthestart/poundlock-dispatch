/** A web tools instance over a fake network: routes by URL prefix, every call and record kept. */
import { createWebTools } from "@runtime/web-tools";
import type { WebCallRecord } from "@shared/web-search";

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
export const page = (body: string, status = 200, type = "text/html; charset=utf-8") =>
  new Response(body, { status, headers: { "content-type": type } });

export function harness(
  routes: Record<string, () => Response>,
  extra: {
    addresses?: Record<string, string[]>;
    enabled?: () => boolean;
    url?: string;
    /** URLs the fake engine returns for the query "seed", so they may be fetched. */
    seed?: string[];
  } = {},
) {
  const all: Record<string, () => Response> = {
    ...(extra.seed
      ? {
          "http://127.0.0.1:8888/search?q=seed": () =>
            json({ results: extra.seed!.map((url) => ({ title: "seed", url })) }),
        }
      : {}),
    ...routes,
  };
  const calls: string[] = [];
  const records: WebCallRecord[] = [];
  const agents: string[] = [];
  const tools = createWebTools({
    settings: { url: extra.url ?? "http://127.0.0.1:8888" },
    privateTerms: ["library-frontier-2"],
    onCall: (entry) => records.push(entry),
    enabled: extra.enabled,
    resolve: async (host) => extra.addresses?.[host] ?? ["93.184.216.34"],
    sleep: async () => undefined,
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      agents.push(new Headers(init?.headers).get("user-agent") ?? "");
      const route = Object.entries(all).find(([prefix]) => url.startsWith(prefix));
      return route ? route[1]() : new Response("missing", { status: 404 });
    }) as typeof fetch,
  });
  /** Search for the seeded URLs first, then start the record afresh. */
  const seeded = async () => {
    await tools.search("seed");
    calls.length = 0;
    records.length = 0;
  };
  return { tools, calls, records, agents, seeded };
}
