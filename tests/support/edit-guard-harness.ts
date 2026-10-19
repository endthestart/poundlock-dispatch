/**
 * Dispatch's worker file tools with and without the edit guard, driven the
 * way Pi's sequential tool loop drives them: every `tool_call` handler until
 * one blocks, the tool, then every `tool_result` handler in turn.
 */
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { EditGuard, editGuardExtension } from "@runtime/edit-guard";
import {
  type PolicyExtensionOptions,
  projectFileToolDefinitions,
  projectPolicyExtension,
  readProjectBuffer,
} from "@runtime/policy-extension";
import { defaultBudget, defaultPolicy, type ProjectRecord } from "@shared/types";

export function fixtureProject(root: string): ProjectRecord {
  return {
    id: "project",
    name: "Example",
    archived: false,
    createdAt: "now",
    updatedAt: "now",
    status: "draft",
    source: {
      kind: "local_folder",
      originalPath: root,
      capturedAt: "now",
      snapshotSha256: "",
      baseRevision: "",
      includedFiles: 0,
      includedBytes: 0,
      excludedPatterns: [],
      includedUncommitted: true,
      originalFingerprint: "",
    },
    policy: defaultPolicy(),
    budget: defaultBudget(),
    integration: { headRevision: "", expectedBase: "", appliedPatchSha256: [] },
    planRevision: 1,
    managerSessionId: "manager",
    eventCursor: 0,
  };
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
  /** Refused by a `tool_call` handler; the tool did not run. */
  blocked: boolean;
}

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

export function workerFileTools(root: string, options: { guard?: boolean } = {}) {
  const policy: PolicyExtensionOptions = {
    projectRoot: root,
    cwd: root,
    project: fixtureProject(root),
    trust: "full",
    bashEnabled: false,
  };
  const guard =
    options.guard === false
      ? undefined
      : new EditGuard({
          cwd: root,
          projectRoot: root,
          readFile: (path) => readProjectBuffer(policy, path),
        });
  policy.fileViews = guard;
  const definitions = projectFileToolDefinitions(
    { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition },
    policy,
  );
  const handlers: Record<string, Handler[]> = { tool_call: [], tool_result: [] };
  const api = {
    on: (event: string, handler: Handler) => handlers[event]?.push(handler),
  } as unknown as ExtensionAPI;
  projectPolicyExtension(policy)(api);
  if (guard) editGuardExtension(guard)(api);
  const ctx = { getContextUsage: () => undefined };
  let calls = 0;

  async function call(name: string, raw: Record<string, unknown>): Promise<ToolOutcome> {
    const tool = definitions.find((item) => item.name === name);
    if (!tool) throw new Error(`No ${name} tool`);
    const toolCallId = `call-${++calls}`;
    const input = (tool.prepareArguments?.(raw) ?? raw) as Record<string, unknown>;
    for (const handler of handlers.tool_call) {
      const result = (await handler(
        { type: "tool_call", toolName: name, toolCallId, input },
        ctx,
      )) as { block?: boolean; reason?: string } | undefined;
      if (result?.block) return { text: result.reason ?? "", isError: true, blocked: true };
    }
    let content: Array<{ type: string; text?: string }>;
    let details: unknown;
    let isError = false;
    try {
      const result = await (tool.execute as (...args: unknown[]) => Promise<unknown>)(
        toolCallId,
        input,
        new AbortController().signal,
        undefined,
        { cwd: root },
      );
      ({ content, details } = result as { content: typeof content; details: unknown });
    } catch (error) {
      content = [{ type: "text", text: error instanceof Error ? error.message : String(error) }];
      isError = true;
    }
    const event = {
      type: "tool_result",
      toolName: name,
      toolCallId,
      input,
      content,
      details,
      isError,
    };
    for (const handler of handlers.tool_result) {
      const patch = (await handler(event, ctx)) as Partial<typeof event> | undefined;
      if (patch?.content) event.content = patch.content;
      if (patch?.isError !== undefined) event.isError = patch.isError;
    }
    const text = event.content.map((part) => part.text ?? "").join("\n");
    return { text, isError: event.isError, blocked: false };
  }

  return {
    guard,
    read: (path: string, extra: Record<string, unknown> = {}) => call("read", { path, ...extra }),
    write: (path: string, content: string) => call("write", { path, content }),
    edit: (path: string, edits: Array<{ oldText: string; newText: string }>) =>
      call("edit", { path, edits }),
  };
}
