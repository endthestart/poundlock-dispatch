/**
 * Web search for the manager and the Planner (roadmap item 2): a search engine
 * the owner hosts (SearXNG), and pages fetched from the public internet. Both
 * are data leaving the owner's network, so a project opts in with its own
 * switch, separate from the Internet switch commands use (ADR 015), and every
 * query is checked for private content before it goes out.
 */
import type { ProjectNetwork } from "./network";

/** Where searches go: a SearXNG instance the owner runs. */
export interface WebSearchSettings {
  /** The instance's base URL, for example `http://127.0.0.1:8888`. */
  url: string;
}

/** All three of a project's switches, so that changing one never drops another. */
export function networkSwitches(policy?: { network?: ProjectNetwork }): Required<ProjectNetwork> {
  return {
    internet: policy?.network?.internet ?? true,
    localNetwork: policy?.network?.localNetwork ?? false,
    webSearch: policy?.network?.webSearch ?? false,
  };
}

/** The switches after one changes: turning the internet off turns web search off with it. */
export function withSwitch(
  policy: { network?: ProjectNetwork } | undefined,
  change: Partial<Required<ProjectNetwork>>,
): Required<ProjectNetwork> {
  const next = { ...networkSwitches(policy), ...change };
  return next.internet ? next : { ...next, webSearch: false };
}

/** A project searches the web only when it allows the internet and turns search on. */
export function projectWebSearch(policy?: { network?: ProjectNetwork }): boolean {
  return (policy?.network?.internet ?? true) && (policy?.network?.webSearch ?? false);
}

/** The instance a project's agents search through, when the owner set one up and the project allows it. */
export function webSearchFor(
  settings: WebSearchSettings | undefined,
  policy?: { network?: ProjectNetwork },
): WebSearchSettings | undefined {
  return settings?.url && projectWebSearch(policy) ? { url: settings.url } : undefined;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** One search or fetch, as a run or a session records it. */
export interface WebCallRecord {
  tool: "web_search" | "web_fetch";
  /** The query, or the URL fetched. */
  target: string;
  /** "ok", or why it did not happen or failed. */
  status: string;
  /** Results returned, or characters of page text. */
  size?: number;
}

/** Longer than a search query needs: likely pasted project text. */
export const MAX_QUERY_CHARS = 200;

const PRIVATE_PATTERNS: Array<[RegExp, string]> = [
  [
    /(^|[^\w])(\/Users\/|\/home\/|\/private\/|\/var\/|\/Volumes\/|\/etc\/|\/opt\/|\/tmp\/|~\/|[A-Za-z]:\\)/,
    "a file path",
  ],
  [
    /\b[\w.-]+\/[\w./-]*\.(ts|tsx|js|jsx|mjs|py|rs|go|swift|kt|java|rb|json|ya?ml|toml|sql|sh|md)\b/i,
    "a file path",
  ],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/, "an API key"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "an API key"],
  [/\b(ghp|gho|ghs|github_pat|glpat|xox[abp])[_-][A-Za-z0-9_-]{16,}/, "an access token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "a cloud access key"],
  [/-----BEGIN [A-Z ]+-----/, "a key or certificate"],
  [/\b[A-Fa-f0-9]{32,}\b/, "a long hex string such as a token or hash"],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}(?=\s|$)/, "a long encoded string such as a token"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, "an email address"],
  [
    /\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/,
    "a private address",
  ],
  [/\b[\w-]+\.(local|lan|home\.arpa|internal)\b/i, "a private host name"],
];

/**
 * Why a query must not leave the owner's network, or undefined when it may:
 * search for public facts, never with code, paths, secrets or personal details.
 */
/** A file name in a query: `security.test.ts`, `"vite.config.ts"`. */
const FILE_NAME =
  /["'`]?[\w@.-]*\w\.(?:tsx?|jsx?|mjs|cjs|json|rs|py|go|swift|kt|java|rb|css|scss|html|vue|svelte|toml|ya?ml|sql|sh|md)\b["'`]?/gi;

/**
 * A query with its file names taken out: they name the project's own files,
 * which the owner keeps private (19 Oct), and a search does without them.
 */
export function withoutFileNames(query: string): { query: string; removed: string[] } {
  const removed: string[] = [];
  const kept = query.replace(FILE_NAME, (name) => {
    const bare = name.replace(/["'`]/g, "");
    // A product named like a file (Node.js, Vue.js) stays.
    if (/^[A-Z][a-z]+\.js$/.test(bare)) return name;
    removed.push(bare);
    return " ";
  });
  // Spaces only: a query that spans lines must still read as pasted text.
  return { query: kept.replace(/[ \t]+/g, " ").trim(), removed };
}

/**
 * Names private to the install whatever the project: a local Planner searched
 * for "Poundlock Dispatch autopilot …", the software it runs inside, instead of
 * the task; a query names what the person runs and finds nothing the task needs.
 */
const INSTALL_TERMS = ["poundlock"];

export function queryProblem(query: string, privateTerms: string[] = []): string | undefined {
  const text = query.trim();
  if (!text) return "the query is empty";
  if (text.length > MAX_QUERY_CHARS)
    return `the query is longer than ${MAX_QUERY_CHARS} characters; search with a few words, not pasted text`;
  if (/\n/.test(text))
    return "the query spans several lines; search with a few words, not pasted text";
  for (const [pattern, what] of PRIVATE_PATTERNS)
    if (pattern.test(text)) return `the query contains ${what}`;
  const lower = text.toLowerCase();
  for (const term of [...INSTALL_TERMS, ...privateTerms])
    if (term.trim().length >= 4 && lower.includes(term.trim().toLowerCase()))
      return "the query names something private to this project or this machine";
  return undefined;
}
