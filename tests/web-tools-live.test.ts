/**
 * Web search against a real SearXNG instance. Skipped unless
 * POUNDLOCK_SEARXNG_URL names one (for example http://127.0.0.1:8888); it then
 * searches the public web and reads one public page.
 */
import { createWebTools } from "@runtime/web-tools";
import type { WebCallRecord } from "@shared/web-search";
import { expect, it } from "vitest";

const url = process.env.POUNDLOCK_SEARXNG_URL;
const live = url ? it : it.skip;

live(
  "searches through a real SearXNG and reads a public page",
  async () => {
    const records: WebCallRecord[] = [];
    const tools = createWebTools({ settings: { url: url! }, onCall: (r) => records.push(r) });
    const results = await tools.search("digiKam photo management features");
    expect(results).toContain("untrusted web content");
    // Only a URL the engine returned may be fetched; some sites refuse readers, so try a few.
    const urls = [...results.matchAll(/^ {3}(https?:\/\/\S+)$/gm)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    let page = "";
    for (const url of urls.slice(0, 4)) {
      page = await tools.fetchPage(url);
      if (page.startsWith("Page ")) break;
    }
    expect(page).toMatch(/^Page /);
    expect(page).toMatch(/digiKam/i);
    expect(records[0]).toMatchObject({ tool: "web_search", status: "ok" });
    expect(records.some((r) => r.tool === "web_fetch" && r.status === "ok")).toBe(true);
  },
  60_000,
);
