/**
 * GitHub search for the manager and the Planner (roadmap item 2): repositories and
 * issues through GitHub's public REST API, with no token. It goes out under
 * web_search's rules (a public query, the same cap, every call recorded), and the
 * pages it returns are ones web_fetch may then read: GitHub's robots.txt allows
 * repository, issue and file pages.
 */
import type { WebSearchResult } from "../shared/web-search.js";

export type GithubSearchKind = "repositories" | "issues";

export const GITHUB_API = "https://api.github.com";

/** Results returned per search, as for web_search. */
const RESULTS = 8;

export function githubSearchUrl(query: string, kind: GithubSearchKind): URL {
  const url = new URL(`${GITHUB_API}/search/${kind}`);
  url.search = new URLSearchParams({ q: query, per_page: String(RESULTS) }).toString();
  return url;
}

interface Repository {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  stargazers_count?: number;
  language?: string | null;
  pushed_at?: string;
  archived?: boolean;
}

interface Issue {
  title?: string;
  html_url?: string;
  body?: string | null;
  state?: string;
  pull_request?: unknown;
  comments?: number;
}

/** The search's results, with the facts that tell a maintained project from an abandoned one. */
export function githubResults(kind: GithubSearchKind, body: unknown): WebSearchResult[] {
  const items = ((body as { items?: unknown[] })?.items ?? []).slice(0, RESULTS);
  if (kind === "repositories")
    return (items as Repository[])
      .filter((item) => item.html_url?.startsWith("https://github.com/"))
      .map((item) => ({
        title: item.full_name ?? "",
        url: item.html_url ?? "",
        snippet: [
          item.description ?? "",
          `${item.stargazers_count ?? 0} stars`,
          item.language ?? "",
          item.pushed_at ? `last push ${item.pushed_at.slice(0, 10)}` : "",
          item.archived ? "archived" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      }));
  return (items as Issue[])
    .filter((item) => item.html_url?.startsWith("https://github.com/"))
    .map((item) => ({
      title: `${item.pull_request ? "Pull request" : "Issue"} (${item.state ?? "unknown"}): ${item.title ?? ""}`,
      url: item.html_url ?? "",
      snippet: `${item.comments ?? 0} comments · ${(item.body ?? "").replace(/\s+/g, " ").trim()}`,
    }));
}

/** Why GitHub refused, in words the model can act on: its unauthenticated search allows 10 a minute. */
export function githubRefusal(status: number, headers: Headers): string {
  const reset = Number(headers.get("x-ratelimit-reset"));
  if ((status === 403 || status === 429) && headers.get("x-ratelimit-remaining") === "0")
    return `GitHub's search limit is used${Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` : ""}; use web_search meanwhile`;
  if (status === 422) return "GitHub could not read that query; use plain words";
  return `GitHub answered ${status}`;
}
