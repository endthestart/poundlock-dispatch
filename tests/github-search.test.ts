import { describe, expect, it } from "vitest";
import { harness, json, page } from "./support/web-harness";

const API = "https://api.github.com/search/";

const repository = {
  full_name: "acme/frame-tools",
  html_url: "https://github.com/acme/frame-tools",
  description: "Align and stack\nastrophotos",
  stargazers_count: 412,
  language: "Rust",
  pushed_at: "2026-10-01T12:00:00Z",
  archived: false,
};

describe("github_search", () => {
  it("finds repositories through GitHub's public API, recorded like any search", async () => {
    const { tools, calls, records } = harness({
      [`${API}repositories`]: () => json({ items: [repository] }),
    });
    const text = await tools.searchGithub("astrophotography stacking rust", "repositories");
    expect(calls[0]).toContain(`${API}repositories?q=astrophotography`);
    expect(text).toContain("untrusted web content");
    expect(text).toContain("acme/frame-tools");
    expect(text).toContain("Align and stack astrophotos · 412 stars · Rust · last push 2026-10-01");
    expect(records).toEqual([
      {
        tool: "github_search",
        target: "astrophotography stacking rust",
        status: "ok",
        size: 1,
      },
    ]);
  });

  it("finds issues and pull requests, and their pages may then be read", async () => {
    const issue = "https://github.com/acme/frame-tools/issues/7";
    const { tools } = harness({
      [`${API}issues`]: () =>
        json({
          items: [
            {
              title: "Frames drift",
              html_url: issue,
              state: "open",
              comments: 3,
              body: "Off by one",
            },
            {
              title: "Fix drift",
              html_url: "https://github.com/acme/frame-tools/pull/8",
              state: "closed",
              pull_request: {},
            },
          ],
        }),
      "https://github.com/robots.txt": () =>
        page("User-agent: *\nDisallow: /*/tree/\n", 200, "text/plain"),
      [issue]: () => page("<p>The frames drift by one pixel.</p>"),
    });
    const text = await tools.searchGithub("frame drift registration", "issues");
    expect(text).toContain("Issue (open): Frames drift");
    expect(text).toContain("3 comments · Off by one");
    expect(text).toContain("Pull request (closed): Fix drift");
    expect(await tools.fetchPage(issue)).toContain("The frames drift by one pixel.");
  });

  it("keeps private content in and shares web_search's cap", async () => {
    const { tools, calls, records } = harness({
      [`${API}repositories`]: () => json({ items: [repository] }),
      "http://127.0.0.1:8888/search": () => json({ results: [] }),
    });
    expect(await tools.searchGithub("open /home/someone/secret", "repositories")).toContain(
      "Not searched",
    );
    expect(await tools.searchGithub("library-frontier-2 parser", "repositories")).toContain(
      "Not searched",
    );
    expect(calls).toHaveLength(0);
    expect(records.map((record) => record.tool)).toEqual(["github_search", "github_search"]);
    for (let n = 0; n < 19; n++) await tools.search(`stacking ${n}`);
    expect(await tools.searchGithub("star stacking", "repositories")).toContain("acme/frame-tools");
    expect(await tools.searchGithub("star stacking", "repositories")).toContain(
      "used its 20 searches",
    );
  });

  it("says when GitHub's hourly search limit is used, and when it resets", async () => {
    const { tools, records } = harness({
      [`${API}repositories`]: () =>
        json({ message: "API rate limit exceeded" }, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Date.parse("2026-10-30T05:17:00Z") / 1000),
        }),
    });
    expect(await tools.searchGithub("star stacking", "repositories")).toBe(
      "GitHub's search limit is used until 05:17 UTC; use web_search meanwhile.",
    );
    expect(records[0].status).toContain("search limit is used");
  });
});
