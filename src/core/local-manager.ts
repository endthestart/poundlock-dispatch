import type { LocalManagerSettings } from "@shared/types";

export interface LocalManagerProbe {
  ok: boolean;
  url: string;
  model: string;
  reportedContextTokens?: number;
  reportedMaxOutputTokens?: number;
}

export function normalizeLocalManager(settings: LocalManagerSettings): LocalManagerSettings {
  if (!settings.enabled)
    return {
      ...settings,
      url: settings.url.trim(),
      model: settings.model.trim(),
    };
  const raw = settings.url.trim();
  if (!raw) throw new Error("Enter the address of the model running on this computer.");
  const parsed = new URL(raw);
  const host = parsed.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (
    !loopback ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      "The direct manager exception accepts only an HTTP address on this computer, without credentials in the URL.",
    );
  if (!settings.model.trim()) throw new Error("Enter the local model ID.");
  if (!Number.isInteger(settings.contextTokens) || settings.contextTokens < 4096)
    throw new Error("The local manager needs a verified context limit of at least 4,096 tokens.");
  if (!Number.isInteger(settings.maxOutputTokens) || settings.maxOutputTokens < 256)
    throw new Error("The local manager needs a verified output limit of at least 256 tokens.");
  parsed.pathname = parsed.pathname.replace(/\/(?:v1)?\/?$/, "") || "";
  return {
    ...settings,
    url: parsed.toString().replace(/\/$/, ""),
    model: settings.model.trim(),
  };
}

export async function probeLocalManager(
  settings: LocalManagerSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<LocalManagerProbe> {
  const normalized = normalizeLocalManager({ ...settings, enabled: true });
  const response = await fetchImpl(`${normalized.url}/v1/models`, {
    headers: normalized.token ? { Authorization: `Bearer ${normalized.token}` } : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `The local model server returned HTTP ${response.status} while listing models.`,
    );
  const body = (await response.json()) as {
    data?: Array<{
      id?: string;
      context_length?: number;
      context_tokens?: number;
      max_output_tokens?: number;
    }>;
  };
  const model = body.data?.find((item) => item.id === normalized.model);
  if (!model) throw new Error(`The local server did not list the model “${normalized.model}”.`);
  return {
    ok: true,
    url: normalized.url,
    model: normalized.model,
    reportedContextTokens: model.context_tokens ?? model.context_length,
    reportedMaxOutputTokens: model.max_output_tokens,
  };
}
