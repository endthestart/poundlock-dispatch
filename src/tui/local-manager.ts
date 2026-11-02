/**
 * `/local-manager`: Settings → Models and routing → "Project Manager on this
 * computer" in the app. Only the manager talks to a model server on this
 * computer; workers and frontier models still come through Poundlock. The
 * terminal tests the server before it saves, and takes its limits from what
 * the server reports unless they are given.
 */
import type { AppStateView, LocalManagerSettings } from "@shared/types";

export const LOCAL_MANAGER_USAGE =
  "Usage: /local-manager, /local-manager off, or /local-manager on <model> [address] [--context <tokens>] [--output <tokens>]";

const DEFAULT_ADDRESS = "http://127.0.0.1:11434";

type Saved = AppStateView["connection"]["localManager"];

export interface LocalManagerRequest {
  model: string;
  url: string;
  contextTokens?: number;
  maxOutputTokens?: number;
}

export interface LocalManagerProbeResult {
  model: string;
  reportedContextTokens?: number;
  reportedMaxOutputTokens?: number;
}

export function localManagerLines(saved: Saved): string {
  if (!saved?.enabled)
    return "Project Manager: the Poundlock model chosen under /role manager. /local-manager on <model> uses one on this computer.";
  return [
    `Project Manager: ${saved.model} on this computer, at ${saved.url}.`,
    `  ${saved.contextTokens.toLocaleString()} tokens context, ${saved.maxOutputTokens.toLocaleString()} output; token ${saved.tokenConfigured ? "saved" : "none"}.`,
    "  Workers still use Poundlock.",
  ].join("\n");
}

function tokens(flag: string, value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${flag} needs a number of tokens.`);
  return Number.parseInt(value, 10);
}

/** `on <model> [address] [--context n] [--output n]`, or `off`, or nothing. */
export function parseLocalManager(
  args: string,
  saved: Saved,
): { action: "show" } | { action: "off" } | { action: "on"; request: LocalManagerRequest } {
  const [action = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (!action) return { action: "show" };
  if (action === "off" && !rest.length) return { action: "off" };
  if (action !== "on") throw new Error(LOCAL_MANAGER_USAGE);
  const words: string[] = [];
  const request: Partial<LocalManagerRequest> = {};
  for (let at = 0; at < rest.length; at += 1) {
    const word = rest[at];
    if (word === "--context") request.contextTokens = tokens(word, rest[++at]);
    else if (word === "--output") request.maxOutputTokens = tokens(word, rest[++at]);
    else if (word.startsWith("--")) throw new Error(LOCAL_MANAGER_USAGE);
    else words.push(word);
  }
  const [model, url, ...extra] = words;
  if (!model || extra.length) throw new Error(LOCAL_MANAGER_USAGE);
  return {
    action: "on",
    request: { ...request, model, url: url ?? saved?.url ?? DEFAULT_ADDRESS },
  };
}

/**
 * What to save after a successful test: a limit given in the command wins,
 * then the one the server reports, then the one already saved for this model.
 */
export function localManagerSettings(
  request: LocalManagerRequest,
  probe: LocalManagerProbeResult,
  saved: Saved,
  token: string,
): LocalManagerSettings {
  const same = saved?.model === request.model ? saved : undefined;
  const contextTokens = request.contextTokens ?? probe.reportedContextTokens ?? same?.contextTokens;
  const maxOutputTokens =
    request.maxOutputTokens ?? probe.reportedMaxOutputTokens ?? same?.maxOutputTokens;
  if (contextTokens === undefined || maxOutputTokens === undefined)
    throw new Error(
      `The server does not report ${request.model}'s ${contextTokens === undefined ? "context" : "output"} limit. Give it with --context <tokens> --output <tokens>.`,
    );
  return {
    enabled: true,
    url: request.url,
    token,
    model: request.model,
    contextTokens,
    maxOutputTokens,
  };
}

/** Saving `off` keeps the address and model, as the app's checkbox does. */
export function localManagerOff(saved: Saved): LocalManagerSettings {
  return {
    enabled: false,
    url: saved?.url ?? DEFAULT_ADDRESS,
    token: "",
    model: saved?.model ?? "",
    contextTokens: saved?.contextTokens ?? 0,
    maxOutputTokens: saved?.maxOutputTokens ?? 0,
  };
}
