import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MANAGER_SYSTEM_PROMPT } from "@core/manager-prompt";
import { requireInteractiveLimits } from "@shared/roles";
import type { InteractiveModel, ReasoningChoice } from "@shared/types";
import { lockedPiResources } from "./pi-resources.js";
import {
  applyReasoning,
  type PoundlockProviderOptions,
  poundlockModelDefinition,
  wrapStreamForPoundlock,
} from "./poundlock-provider.js";

interface SessionFactoryOptions {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  model: InteractiveModel;
  /** Sent as `reasoning_effort` on every request of this session; Model default sends nothing. */
  reasoning?: ReasoningChoice;
  controllerUrl: string;
  token: string;
  providerId?: string;
  systemPrompt: string;
  tools: string[];
  excludeTools?: string[];
  customTools: unknown[];
  extensionFactories?: Array<(api: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void>;
  fresh?: boolean;
  provider: Omit<PoundlockProviderOptions, "model" | "controllerUrl" | "token" | "providerId">;
}

export async function createDispatchPiSession(options: SessionFactoryOptions) {
  const pi = await import("@earendil-works/pi-coding-agent");
  await mkdir(options.agentDir, { recursive: true, mode: 0o700 });
  const { contextTokens, maxOutputTokens } = requireInteractiveLimits(options.model);
  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(options.agentDir, "runtime-empty-auth.json"),
    modelsPath: null,
    modelsStorePath: join(options.agentDir, "model-cache"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const providerId = options.providerId ?? "poundlock";
  modelRuntime.registerProvider(providerId, {
    baseUrl: `${options.controllerUrl.replace(/\/$/, "")}/v1`,
    api: "openai-completions",
    authHeader: true,
    models: [
      poundlockModelDefinition({
        ...options.model,
        context_tokens: contextTokens,
        max_output_tokens: maxOutputTokens,
      }),
    ],
  });
  await modelRuntime.setRuntimeApiKey(providerId, options.token);
  const model = modelRuntime.getModel(providerId, options.model.id)!;
  const settingsManager = pi.SettingsManager.inMemory(
    {
      compaction: {
        enabled: true,
        reserveTokens: Math.min(12000, Math.floor(contextTokens / 4)),
        keepRecentTokens: Math.min(6000, Math.floor(contextTokens / 8)),
      },
      retry: { enabled: false },
    },
    { projectTrusted: false },
  );
  const loader = new pi.DefaultResourceLoader({
    ...lockedPiResources,
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    systemPromptOverride: () => options.systemPrompt,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    skillsOverride: () => ({ skills: [], diagnostics: [] }),
    noExtensions: true,
    extensionFactories: options.extensionFactories ?? [],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const { session } = await pi.createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    model,
    thinkingLevel: "off",
    modelRuntime,
    tools: options.tools,
    excludeTools: options.excludeTools,
    customTools: options.customTools as never,
    resourceLoader: loader,
    sessionManager: pi.SessionManager.continueRecent(
      options.cwd,
      options.fresh ? join(options.sessionDir, `fresh-${Date.now()}`) : options.sessionDir,
    ),
    settingsManager,
  });
  session.agent.toolExecution = "sequential";
  const stream = session.agent.streamFunction;
  const timed = (
    model: Parameters<typeof stream>[0],
    context: Parameters<typeof stream>[1],
    streamOptions: Parameters<typeof stream>[2],
  ) =>
    stream(model, context, {
      ...applyReasoning(streamOptions, options.reasoning ?? "model_default"),
      timeoutMs: 21 * 60_000,
      maxRetries: 0,
    });
  session.agent.streamFunction = wrapStreamForPoundlock(timed, {
    ...options.provider,
    controllerUrl: options.controllerUrl,
    token: options.token,
    model: options.model,
    providerId,
  }) as typeof stream;
  return { session, pi };
}

export { MANAGER_SYSTEM_PROMPT };
