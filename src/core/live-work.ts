import {
  compactionFromPiEvent,
  type PiCompactionSignal,
  workerCompactionText,
} from "@shared/compaction";
import { activityLogKey, LIVE_WORK_LIMIT } from "@shared/live-work-view";
import type { LiveWorkEntry } from "@shared/types";

export type { LiveWorkEntry };
export type { LiveWorkDockView } from "@shared/live-work-view";
export { activityLogKey, LIVE_WORK_LIMIT, liveWorkDockView } from "@shared/live-work-view";

interface WorkerActivityEvent extends PiCompactionSignal {
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  assistantMessageEvent?: { type?: string };
}

function relativeWorkPath(path: string, cwd: string): string {
  if (!path) return "";
  const prefix = cwd.replace(/[/\\]+$/, "");
  if (path === prefix) return ".";
  if (path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}\\`)) {
    return path.slice(prefix.length + 1);
  }
  return path;
}

export function describeWorkerTool(toolName: string, args: unknown, cwd: string): string {
  const rec = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const path = typeof rec.path === "string" ? relativeWorkPath(rec.path, cwd) : "";
  switch (toolName) {
    case "write":
      return `writing ${path || "a file"}`;
    case "edit":
      return `editing ${path || "a file"}`;
    case "read":
      return `reading ${path || "a file"}`;
    case "grep":
      return typeof rec.pattern === "string" && rec.pattern
        ? `searching for ${rec.pattern}`
        : "searching the project";
    case "find":
    case "ls":
      return path ? `listing ${path}` : "listing files";
    case "run_command": {
      const program = typeof rec.program === "string" ? rec.program : "command";
      const argv = Array.isArray(rec.arguments) ? rec.arguments.map(String).join(" ") : "";
      const command = `${program}${argv ? ` ${argv}` : ""}`.trim();
      return `running ${command.length > 100 ? `${command.slice(0, 97)}…` : command}`;
    }
    default:
      return toolName.replaceAll("_", " ");
  }
}

export function workerActivityPhase(
  modelId: string,
  event: WorkerActivityEvent,
  cwd: string,
): string | undefined {
  if (event.type === "agent_start" || event.type === "turn_start") {
    return `Waiting for ${modelId}`;
  }
  if (event.type === "auto_retry_start") {
    return `Retrying ${modelId}`;
  }
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    return `${modelId} is composing`;
  }
  if (event.type === "tool_execution_start" && event.toolName) {
    return `${modelId}: ${describeWorkerTool(event.toolName, event.args, cwd)}`;
  }
  if (event.type === "tool_execution_end" && event.toolName) {
    if (event.isError) return `${modelId}: ${event.toolName.replaceAll("_", " ")} needs attention`;
    return undefined;
  }
  if (event.type === "agent_end") {
    return "Worker instructions finished — checking results";
  }
  // A worker that compacts forgets the detail of its earlier steps, which is
  // worth seeing in the trail when its work drifts.
  if (event.type === "compaction_start") return `${modelId}: compacting its conversation`;
  const compaction = compactionFromPiEvent(event);
  if (compaction?.status === "compacted") return workerCompactionText(modelId, compaction);
  if (compaction?.status === "failed")
    return `${modelId}: compaction failed, continuing with its full conversation`;
  return undefined;
}

export function formatLiveWorkActivity(
  phase: string,
  elapsedMs: number,
  clockAfterMs = 4000,
): string {
  if (elapsedMs < clockAfterMs) return phase;
  const seconds = Math.max(1, Math.round(elapsedMs / 1000));
  return `${phase} · ${seconds}s`;
}

function isLiveActionPhase(phase: string): boolean {
  return activityLogKey(phase).includes(": ");
}

function isIdleLivePhase(phase: string): boolean {
  const key = activityLogKey(phase);
  return (
    /^Waiting for /.test(key) ||
    /^Retrying /.test(key) ||
    / is (continuing|composing)$/.test(key) ||
    / is replying…$/.test(key)
  );
}

export function appendLiveWork(
  log: LiveWorkEntry[],
  text: string,
  at: string,
  limit = LIVE_WORK_LIMIT,
): LiveWorkEntry[] {
  const key = activityLogKey(text).trim();
  if (!key) return log;
  if (isIdleLivePhase(key) && log.some((item) => isLiveActionPhase(item.text))) return log;
  const last = log.at(-1);
  if (last && activityLogKey(last.text) === key) return log;
  return [...log, { at, text: key }].slice(-limit);
}

export const GLOBAL_LIVE_WORK = "_global";

/** Per-project activity trail. Not persisted into messages.json. */
export class LiveWorkBook {
  private activity = new Map<string, string | undefined>();
  private logs = new Map<string, LiveWorkEntry[]>();

  record(projectId: string | undefined, text: string | undefined, at: string): void {
    const id = projectId || GLOBAL_LIVE_WORK;
    if (!text) {
      this.activity.set(id, undefined);
      return;
    }
    this.activity.set(id, text);
    this.logs.set(id, appendLiveWork(this.logs.get(id) ?? [], text, at));
  }

  clearActivity(projectId: string | undefined): void {
    this.activity.set(projectId || GLOBAL_LIVE_WORK, undefined);
  }

  view(projectId: string | undefined): { activity?: string; liveWork: LiveWorkEntry[] } {
    const id = projectId || GLOBAL_LIVE_WORK;
    return { activity: this.activity.get(id), liveWork: this.logs.get(id) ?? [] };
  }
}

export function bindWorkerActivity(
  subscribe: (listener: (event: WorkerActivityEvent) => void) => () => void,
  options: {
    modelId: string;
    cwd: string;
    onActivity?: (text: string) => void;
    initial: string;
    now?: () => number;
    intervalMs?: number;
  },
): () => void {
  const now = options.now ?? Date.now;
  let phase = options.initial;
  let phaseAt = now();
  const publish = () => {
    options.onActivity?.(formatLiveWorkActivity(phase, now() - phaseAt));
  };
  publish();
  const unsubscribe = subscribe((event) => {
    const next = workerActivityPhase(options.modelId, event, options.cwd);
    if (!next) return;
    if (isIdleLivePhase(next) && isLiveActionPhase(phase)) return;
    if (next !== phase) {
      phase = next;
      phaseAt = now();
    }
    publish();
  });
  const pulse = setInterval(publish, options.intervalMs ?? 4000);
  return () => {
    clearInterval(pulse);
    unsubscribe();
  };
}
