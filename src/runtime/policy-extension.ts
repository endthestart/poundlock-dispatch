import { constants } from "node:fs";
import { access, type FileHandle, lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { canonicalDestination, excludedPath, isWithin } from "@core/file-access";
import { listLiveProjectFiles } from "@core/snapshot";
import type { ToolJournal } from "@core/tool-journal";
import type {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { PermissionSettings } from "@shared/permissions";
import type { ProjectRecord } from "@shared/types";
import { withoutRedundantCd } from "./command-cwd.js";
import type { FileViews } from "./edit-guard.js";
import { FILE_TOOLS, MUTATING_FILE_TOOLS, resolveToolPath } from "./path-policy.js";

export interface PolicyExtensionOptions {
  /** Frozen test files, project-relative; write tools refuse them. */
  frozenPaths?: string[];
  projectRoot: string;
  cwd: string;
  project: ProjectRecord;
  trust: "ask" | "assist" | "full";
  bashEnabled: boolean;
  /** An investigation: nothing that writes may run, whatever the trust mode. */
  readOnly?: boolean;
  signal?: AbortSignal;
  journal?: ToolJournal;
  journalMeta?: {
    piSessionId?: string;
    workflowId?: string;
    planRevision?: number;
    taskId?: string;
    attemptId?: string;
  };
  getPermissions?: () => Promise<PermissionSettings | undefined>;
  getPolicy?: () => Promise<{
    project: ProjectRecord;
    trust: "ask" | "assist" | "full";
    permissions?: PermissionSettings;
  }>;
  authorizeBash?: (input: {
    command: string;
    cwd: string;
    toolCallId: string;
  }) => Promise<"allow" | "deny">;
  authorizeMutation?: (input: {
    tool: string;
    path: string;
    toolCallId: string;
  }) => Promise<"allow" | "deny">;
  onBlocked?: (tool: string, reason: string) => void;
  /** Told what the model reads and writes through Pi's file tools: the edit guard. */
  fileViews?: FileViews;
}

export async function evaluateWorkerToolCall(
  options: PolicyExtensionOptions,
  event: { toolName: string; toolCallId: string; input: Record<string, unknown> },
): Promise<{
  block?: boolean;
  /** The owner refused: the worker stops. Any other block is an error the worker can act on. */
  stop?: boolean;
  reason?: string;
  pendingEventId?: string;
  canonicalPath?: string;
}> {
  const live = await currentPolicy(options);
  if (options.readOnly && (event.toolName === "bash" || MUTATING_FILE_TOOLS.has(event.toolName))) {
    const reason = "This is a read-only investigation: files cannot be changed and Bash is off.";
    options.onBlocked?.(event.toolName, reason);
    return { block: true, reason };
  }
  if (event.toolName === "bash" && (!options.bashEnabled || live.trust === "assist")) {
    const reason =
      "Raw Bash is disabled in Approve for me. Use run_command with a program and argument list.";
    options.onBlocked?.(event.toolName, reason);
    await options.journal?.recordDenied({
      ...options.journalMeta,
      toolCallId: event.toolCallId,
      action: { tool: "bash", program: String(event.input.command ?? "") },
      authorization: "deny",
      sideEffectScope: [],
    });
    return { block: true, reason };
  }
  if (event.toolName === "bash") {
    // Approve and run the command without a `cd` into where it already runs.
    const command = withoutRedundantCd(String(event.input.command ?? ""), options.cwd);
    event.input.command = command;
    event.input.timeout = bashTimeoutSeconds(event.input.timeout);
    if (live.trust === "ask") {
      const granted = live.permissions?.grants?.[live.project.id]?.some(
        (rule) => rule.kind === "bash" && rule.cwd === options.cwd && rule.action === command,
      );
      if (!granted) {
        const decision = await options.authorizeBash?.({
          command,
          cwd: options.cwd,
          toolCallId: event.toolCallId,
        });
        if (decision !== "allow") {
          const reason = "Tool approval denied or cancelled. Worker stopped.";
          options.onBlocked?.(event.toolName, reason);
          await options.journal?.recordDenied({
            ...options.journalMeta,
            toolCallId: event.toolCallId,
            action: { tool: "bash", program: command, cwd: options.cwd },
            authorization: "deny",
            sideEffectScope: [],
          });
          return { block: true, stop: true, reason };
        }
      }
    }
    const pending = await options.journal?.begin({
      ...options.journalMeta,
      toolCallId: event.toolCallId,
      action: { tool: "bash", program: command, cwd: options.cwd },
      authorization: live.trust === "ask" ? "ask" : "allow",
      sideEffectScope: ["host-user-authority"],
    });
    return { pendingEventId: pending?.eventId };
  }
  if (!FILE_TOOLS.has(event.toolName)) return {};
  const requested = String(
    (event.input as { path?: string; file_path?: string }).path ??
      (event.input as { file_path?: string }).file_path ??
      "",
  );
  const writing = MUTATING_FILE_TOOLS.has(event.toolName);
  try {
    const canonical = await resolveToolPath(
      {
        projectRoot: options.projectRoot,
        cwd: options.cwd,
        project: live.project,
        writing,
        frozenPaths: options.frozenPaths,
      },
      requested || undefined,
    );
    if (requested && canonical && isWithin(options.projectRoot, canonical)) {
      if ("path" in event.input) event.input.path = canonical;
    }
    if (writing) {
      const pending = await options.journal?.begin({
        ...options.journalMeta,
        toolCallId: event.toolCallId,
        action: { tool: event.toolName, path: canonical },
        authorization: "allow",
        sideEffectScope: [canonical],
      });
      return { pendingEventId: pending?.eventId, canonicalPath: canonical };
    }
    return { canonicalPath: canonical };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    options.onBlocked?.(event.toolName, reason);
    await options.journal?.recordDenied({
      ...options.journalMeta,
      toolCallId: event.toolCallId,
      action: { tool: event.toolName, path: requested },
      authorization: "deny",
      sideEffectScope: [],
    });
    return { block: true, reason };
  }
}

async function currentPolicy(options: PolicyExtensionOptions): Promise<{
  project: ProjectRecord;
  trust: "ask" | "assist" | "full";
  permissions?: PermissionSettings;
}> {
  const live = await options.getPolicy?.();
  if (live) return live;
  return {
    project: options.project,
    trust: options.trust,
    permissions: await options.getPermissions?.(),
  };
}

type PiFileToolFactories = {
  createReadToolDefinition: typeof createReadToolDefinition;
  createWriteToolDefinition: typeof createWriteToolDefinition;
  createEditToolDefinition: typeof createEditToolDefinition;
};
type ProjectFileToolDefinition =
  | ReturnType<typeof createReadToolDefinition>
  | ReturnType<typeof createWriteToolDefinition>
  | ReturnType<typeof createEditToolDefinition>;

async function liveToolPath(
  options: PolicyExtensionOptions,
  requested: string,
  writing: boolean,
): Promise<string> {
  const live = await currentPolicy(options);
  return resolveToolPath(
    {
      projectRoot: options.projectRoot,
      cwd: options.cwd,
      project: live.project,
      writing,
      frozenPaths: options.frozenPaths,
    },
    requested,
  );
}

async function validateOpenedProjectFile(
  options: PolicyExtensionOptions,
  canonical: string,
  handle: FileHandle,
  writing: boolean,
) {
  // Re-resolve after open so an ancestor swapped between authorization and
  // open cannot redirect the descriptor outside the current project policy.
  const revalidated = await liveToolPath(options, canonical, writing);
  if (revalidated !== canonical) {
    throw new Error("The file path changed while the operation was opening it.");
  }
  const [opened, current] = await Promise.all([handle.stat(), lstat(canonical)]);
  if (!opened.isFile() || !current.isFile()) {
    throw new Error(`${writing ? "Write" : "Read"} a regular file, not a directory.`);
  }
  if (opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error("The file changed while the operation was opening it.");
  }
  if (opened.nlink > 1) {
    throw new Error("Hard-linked project files require explicit review.");
  }
  return opened;
}

/**
 * macOS's O_NOFOLLOW_ANY refuses a link anywhere in the path, not only at its
 * last component as O_NOFOLLOW does. Every path opened here is already
 * canonical, so a link in it can only be a folder swapped in after the check
 * (L34). Elsewhere the check after opening is what catches it.
 */
const NOFOLLOW = process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW;

/**
 * Open a canonical project path: no link followed anywhere in it that this
 * platform can refuse, and never blocked on a FIFO planted there (L33); the
 * check after opening refuses anything but a regular file.
 */
export function openProjectPath(path: string, flags: number, mode?: number): Promise<FileHandle> {
  // O_NOFOLLOW_ANY includes O_NOFOLLOW, and the two together are EINVAL.
  return open(path, flags | NOFOLLOW | constants.O_NONBLOCK, mode);
}

/**
 * Create `target` under `root` one folder at a time, each checked to be a real
 * folder at its own path before the next is made in it. `mkdir -p` would
 * follow a folder swapped for a link and create the rest outside (L34).
 */
export async function createProjectDirectories(root: string, target: string): Promise<void> {
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    const next = join(current, part);
    try {
      await mkdir(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stats = await lstat(next);
    if (!stats.isDirectory() || (await realpath(next)) !== next)
      throw new Error("The destination changed while creating its directory.");
    current = next;
  }
}

/**
 * Read a project file under the live policy. `viewed` marks a read whose
 * content the model sees (the read tool), as opposed to the edit tool's own.
 */
export async function readProjectBuffer(
  options: PolicyExtensionOptions,
  requested: string,
  viewed = false,
): Promise<Buffer> {
  const canonical = await liveToolPath(options, requested, false);
  // O_NONBLOCK: a FIFO planted in the project must not hang the tool (L33);
  // the check after opening refuses anything but a regular file.
  const handle = await openProjectPath(canonical, constants.O_RDONLY);
  try {
    const opened = await validateOpenedProjectFile(options, canonical, handle, false);
    const buffer = await handle.readFile();
    if (viewed) options.fileViews?.viewed(canonical, buffer, opened);
    return buffer;
  } finally {
    await handle.close();
  }
}

async function writeProjectFile(
  options: PolicyExtensionOptions,
  requested: string,
  content: string,
): Promise<void> {
  const canonical = await liveToolPath(options, requested, true);
  const handle = await openProjectPath(canonical, constants.O_WRONLY | constants.O_CREAT, 0o644);
  try {
    await validateOpenedProjectFile(options, canonical, handle, true);
    await handle.truncate(0);
    await handle.writeFile(content, "utf8");
    if (options.fileViews) options.fileViews.viewed(canonical, content, await handle.stat());
  } finally {
    await handle.close();
  }
}

async function makeProjectDirectory(
  options: PolicyExtensionOptions,
  requested: string,
): Promise<void> {
  const live = await currentPolicy(options);
  const canonical = await canonicalDestination(options.projectRoot, requested);
  if (!isWithin(options.projectRoot, canonical)) {
    throw new Error("That directory is outside the attached project.");
  }
  const exclusions =
    live.project.source.kind === "local_folder" ? live.project.source.excludedPatterns : [];
  if (await excludedPath(canonical, exclusions, options.projectRoot)) {
    throw new Error("This directory is ignored or excluded.");
  }
  await createProjectDirectories(options.projectRoot, canonical);
  const after = await canonicalDestination(options.projectRoot, canonical);
  if (after !== canonical) throw new Error("The destination changed while creating its directory.");
}

/**
 * Keep Pi's native file-tool schemas, diffs, mutation queue, and rendering while
 * revalidating the path at the actual filesystem operation. The extension hook
 * remains the authorization point; these operations close the symlink swap
 * window between authorization and execution.
 */
export function projectFileToolDefinitions(
  pi: PiFileToolFactories,
  options: PolicyExtensionOptions,
): ProjectFileToolDefinition[] {
  const read = {
    readFile: (path: string) => readProjectBuffer(options, path, true),
    access: async (path: string) => {
      const canonical = await liveToolPath(options, path, false);
      await access(canonical, constants.R_OK);
    },
  };
  const write = {
    mkdir: (path: string) => makeProjectDirectory(options, path),
    writeFile: (path: string, content: string) => writeProjectFile(options, path, content),
  };
  const edit = {
    readFile: (path: string) => readProjectBuffer(options, path),
    writeFile: (path: string, content: string) => writeProjectFile(options, path, content),
    access: async (path: string) => {
      const canonical = await liveToolPath(options, path, true);
      await access(canonical, constants.R_OK | constants.W_OK);
    },
  };
  return [
    pi.createReadToolDefinition(options.cwd, { operations: read }),
    pi.createWriteToolDefinition(options.cwd, { operations: write }),
    pi.createEditToolDefinition(options.cwd, { operations: edit }),
  ];
}

interface SearchFilter {
  tool: "grep" | "find" | "ls";
  searchRoot: string;
  included: Set<string>;
}

async function searchFilterFor(
  options: PolicyExtensionOptions,
  tool: SearchFilter["tool"],
  canonicalPath: string,
): Promise<SearchFilter | undefined> {
  const stat = await lstat(canonicalPath).catch(() => undefined);
  if (!stat?.isDirectory()) return undefined;
  const live = await currentPolicy(options);
  const exclusions =
    live.project.source.kind === "local_folder" ? live.project.source.excludedPatterns : [];
  const listed = await listLiveProjectFiles(options.projectRoot, exclusions, 10_001);
  if (listed.length > 10_000) {
    throw new Error("Project search is limited to 10,000 included files.");
  }
  const included = new Set<string>();
  for (const item of listed) {
    const full = resolve(options.projectRoot, item.path);
    if (!isWithin(canonicalPath, full)) continue;
    included.add(full);
    let parent = full;
    while (parent !== canonicalPath) {
      parent = resolve(parent, "..");
      if (!isWithin(canonicalPath, parent)) break;
      included.add(parent);
    }
  }
  return { tool, searchRoot: canonicalPath, included };
}

export function filterSearchToolOutput(filter: SearchFilter, text: string): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (!line || /^(No matches|No files|\(empty directory\))/.test(line)) {
      kept.push(line);
      continue;
    }
    let requested = line;
    if (filter.tool === "grep") {
      const match = line.match(/^(.+)(?::|-)\d+(?::|-)\s/);
      if (!match) continue;
      requested = match[1];
    } else if (filter.tool === "ls") {
      requested = line.replace(/\/$/, "");
    }
    const full = resolve(filter.searchRoot, requested.split("/").join(sep));
    if (isWithin(filter.searchRoot, full) && filter.included.has(full)) kept.push(line);
  }
  const safe = kept.join("\n").trim();
  if (safe) return safe;
  return filter.tool === "grep"
    ? "No matches found in included project files"
    : filter.tool === "find"
      ? "No included files found matching pattern"
      : "(no included entries)";
}

/**
 * What an investigation's worker is told once its context is filling up.
 *
 * An investigation is one long turn, so Pi never compacts it, and its only
 * deliverable is the report at the end. A worker that read seven commits in
 * full filled a 64K window and stopped one token into its answer. Saying how
 * much is used, while there is still room, lets it stop gathering in time.
 */
/** Past this, an investigation's worker gets no more tools, only room to report. */
const REPORT_NOW_PERCENT = 88;

/**
 * An investigation's effort budget, in tool calls. Without one a thorough
 * model kept reading for half an hour whatever its speed: 60 and 74 calls on
 * one review. A bound makes an investigation's length predictable; the
 * manager asks a narrower follow-up if the report says more is needed.
 */
export const INVESTIGATION_TOOL_CALLS = 40;
const INVESTIGATION_TOOL_CALLS_NOTE = 30;

export function contextBudgetNote(
  usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
): string | undefined {
  if (!usage?.percent || usage.percent < 60) return undefined;
  const used = `[Context ${Math.round(usage.percent)}% of ${usage.contextWindow} tokens used.`;
  return usage.percent >= 80
    ? `${used} Write your report now, from what you have; another large read may leave no room for it.]`
    : `${used} Stop gathering soon: read only what your report still needs, then write it.]`;
}

const NESTED_SANDBOX = /sandbox_apply: Operation not permitted/;
/** Raw Bash is not rewritten the way run_command adds SwiftPM's flags. */
const NESTED_SANDBOX_NOTE =
  "[Dispatch runs this command in a sandbox, and macOS refuses a tool's own sandbox inside it. For SwiftPM, use run_command, which adds the flags, or pass --disable-sandbox -Xswiftc -disable-sandbox.]";

/** The longest a raw Bash command may run, as for run_command. */
export const MAX_BASH_SECONDS = 600;

/**
 * Pi's Bash has no timeout unless the model sets one. A worker's `lldb -o run`
 * on a hung binary ran 23 minutes, until the attempt limit (13 Oct).
 */
export function bashTimeoutSeconds(requested: unknown): number {
  return typeof requested === "number" && requested > 0
    ? Math.min(requested, MAX_BASH_SECONDS)
    : MAX_BASH_SECONDS;
}

export function projectPolicyExtension(options: PolicyExtensionOptions) {
  const pending = new Map<string, string>();
  const searches = new Map<string, SearchFilter>();
  let calls = 0;
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event, ctx) => {
      // The notes on each result are advice; a local model can read past
      // them. Near the end of the window or the budget, stop the gathering.
      // Not terminating: the turn goes on, and the next reply is the report.
      if (options.readOnly) {
        calls += 1;
        const full = (ctx.getContextUsage()?.percent ?? 0) >= REPORT_NOW_PERCENT;
        if (full || calls > INVESTIGATION_TOOL_CALLS)
          return {
            block: true,
            reason: `${
              full
                ? "Your context is nearly full"
                : `You have used this investigation's ${INVESTIGATION_TOOL_CALLS} tool calls`
            }, so no more tools. Write your report now from what you have gathered, and say what you could not check.`,
          };
      }
      const result = await evaluateWorkerToolCall(options, {
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: event.input as Record<string, unknown>,
      });
      if (result.pendingEventId) pending.set(event.toolCallId, result.pendingEventId);
      if (
        result.canonicalPath &&
        (event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls")
      ) {
        const filter = await searchFilterFor(options, event.toolName, result.canonicalPath);
        if (filter) searches.set(event.toolCallId, filter);
      }
      // A refused path or tool is an error the worker reads and works around.
      // Ending the turn there would cost a whole attempt when a worker tries
      // to write a helper script to /tmp.
      if (result.block)
        return { block: true, reason: result.reason, ...(result.stop ? { terminate: true } : {}) };
      return undefined;
    });
    pi.on("tool_result", async (event, ctx) => {
      const eventId = pending.get(event.toolCallId);
      if (eventId) {
        pending.delete(event.toolCallId);
        await options.journal?.complete(
          eventId,
          event.isError ? { error: "tool error" } : undefined,
        );
      }
      const filter = searches.get(event.toolCallId);
      searches.delete(event.toolCallId);
      const content =
        filter && !event.isError
          ? event.content.map((part) =>
              part.type === "text"
                ? { ...part, text: filterSearchToolOutput(filter, part.text) }
                : part,
            )
          : undefined;
      const note = options.readOnly
        ? [
            contextBudgetNote(ctx.getContextUsage()),
            calls >= INVESTIGATION_TOOL_CALLS_NOTE
              ? `[Tool calls: ${calls} of ${INVESTIGATION_TOOL_CALLS} used. Read only what your report still needs.]`
              : undefined,
          ]
            .filter(Boolean)
            .join("\n")
        : "";
      const nested = event.content.some(
        (part) => part.type === "text" && NESTED_SANDBOX.test(part.text),
      )
        ? NESTED_SANDBOX_NOTE
        : "";
      const notes = [note, nested].filter(Boolean).join("\n");
      if (!notes) return content ? { content } : undefined;
      return { content: [...(content ?? event.content), { type: "text" as const, text: notes }] };
    });
  };
}
