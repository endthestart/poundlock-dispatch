/**
 * Local auto mode (ADR 014): how a worker ends a case, and the guards an
 * unattended worker needs.
 *
 * A loop that asks the model for a trailing JSON report loses work: after a
 * compaction the model often forgets the report. Here the contract sits
 * in the system prompt (compaction never summarises it), the case ends with a
 * `finish_case` tool call that ends the turn, a one-line reminder rides on the
 * first tool result after a compaction, and a turn that ends without the call
 * gets two nudges in the same session with writes blocked. `finish_case` only
 * announces: Dispatch's own checks decide acceptance.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutoUsage } from "@shared/auto-run";
import { Type } from "typebox";

export interface FinishRecord {
  status: "done" | "partial" | "blocked";
  summary: string;
  tests: string[];
  blockedReason?: string;
  learnings: string[];
}

export interface AutoAttemptRecord {
  finish?: FinishRecord;
  compactions: number;
  nudges: number;
  usage: AutoUsage;
  /** Why a guard ended the attempt early (a loop, a stall); its work is kept. */
  stopped?: string;
}

export function newAttemptRecord(): AutoAttemptRecord {
  return { compactions: 0, nudges: 0, usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 } };
}

export const MAX_FINISH_NUDGES = 2;

export function autoContract(caseId: string): string {
  return [
    "## Local auto mode (applies to this whole attempt, including after any summary of it)",
    `You are working on case ${caseId}, unattended. Nobody will answer questions.`,
    "- Work only on this case. Do not commit: Dispatch runs the project's checks itself and commits accepted work.",
    '- When the case is complete and you have run its checks, call the finish_case tool with status "done".',
    '- If you made progress but could not complete it, call finish_case with status "partial".',
    '- If you cannot proceed without a person, call finish_case with status "blocked" and the reason.',
    "- Never end your turn without calling finish_case. Do not re-run the same checks once they pass.",
  ].join("\n");
}

/** Tools that change files or run commands: blocked while the worker is only asked to finish. */
const WRITE_TOOLS = new Set(["write", "edit", "bash"]);

export interface AttemptTiming {
  /** When the attempt's time runs out (epoch ms). */
  deadlineAt: number;
  /** The attempt's whole allowance, for the 80% warning. */
  allowanceMs: number;
  now?: () => number;
}

/** What the worker is told as its time runs down: once at 80% of the allowance, again at five minutes. */
export function timeNote(
  caseId: string,
  timing: AttemptTiming,
  warned: number,
): { text: string; level: number } | undefined {
  const left = timing.deadlineAt - (timing.now ?? Date.now)();
  const minutes = Math.max(1, Math.round(left / 60_000));
  if (warned < 2 && left <= 5 * 60_000)
    return {
      level: 2,
      text: `[Case ${caseId}: ${minutes} min left. Start nothing new: call finish_case now, with done or partial.]`,
    };
  if (warned < 1 && left <= timing.allowanceMs * 0.2)
    return {
      level: 1,
      text: `[Case ${caseId}: about ${minutes} min left. Finish: make sure the checks pass, then call finish_case.]`,
    };
  return undefined;
}

/** Results that differ only by how long they took are the same result. */
function normalizeResult(text: string): string {
  return text
    .replace(/\b\d+(\.\d+)?\s*(ms|s|sec|secs|seconds|minutes?)\b/g, "#")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\b/g, "#");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export const LOOP_WINDOW = 40;
export const LOOP_MAX_DISTINCT = 3;
export const MAX_CYCLE_PERIOD = 8;
export const REPEAT_NUDGE =
  "The results did not change. Call finish_case, or fix something before checking again.";

export type RepetitionVerdict =
  | { kind: "ok" }
  | { kind: "nudge"; reason: string }
  | { kind: "stop"; reason: string };

/**
 * The two loops the A/B saw. The 35B made the same few calls hundreds of
 * times (in 40 calls, at most 3 distinct: stop), and at 64K it cycled through
 * the same four passing checks without ending its turn (a block of up to 8
 * calls repeating with unchanged results: block the next repeat once with a
 * nudge, then stop). A stop ends the attempt; its work is kept.
 */
export class RepetitionGuard {
  private readonly calls: string[] = [];
  private readonly done: Array<{ signature: string; result: string }> = [];
  private readonly pending = new Map<string, string>();
  private nudged = 0;

  onCall(toolCallId: string, toolName: string, input: unknown): RepetitionVerdict {
    const signature = `${toolName}:${stable(input)}`;
    this.calls.push(signature);
    const window = this.calls.slice(-LOOP_WINDOW);
    if (window.length === LOOP_WINDOW && new Set(window).size <= LOOP_MAX_DISTINCT)
      return {
        kind: "stop",
        reason: `loop: ${LOOP_WINDOW} tool calls with only ${new Set(window).size} different ones`,
      };
    const period = this.repeatingPeriod(signature);
    if (period) {
      if (this.nudged > 0)
        return {
          kind: "stop",
          reason: `loop: the same ${period} tool calls repeated with unchanged results after a nudge`,
        };
      this.nudged++;
      return { kind: "nudge", reason: REPEAT_NUDGE };
    }
    this.pending.set(toolCallId, signature);
    return { kind: "ok" };
  }

  onResult(toolCallId: string, text: string): void {
    const signature = this.pending.get(toolCallId);
    if (!signature) return;
    this.pending.delete(toolCallId);
    this.done.push({ signature, result: normalizeResult(text) });
  }

  /** The period p when the last 2p finished calls are one block twice over and `next` starts it again. */
  private repeatingPeriod(next: string): number | undefined {
    const done = this.done;
    const m = done.length;
    for (let p = 1; p <= MAX_CYCLE_PERIOD && 2 * p <= m; p++) {
      if (done[m - p].signature !== next) continue;
      let same = true;
      for (let i = 0; i < p && same; i++) {
        const a = done[m - 2 * p + i];
        const b = done[m - p + i];
        same = a.signature === b.signature && a.result === b.result;
      }
      if (same) return p;
    }
    return undefined;
  }
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((part) =>
          part && typeof part === "object" && "text" in part ? String(part.text) : "",
        )
        .join("\n")
    : "";

export interface AutoAttemptHooks {
  systemPromptSuffix: string;
  finishTool: (pi: typeof import("@earendil-works/pi-coding-agent")) => unknown;
  extension: (pi: ExtensionAPI) => void;
  /** After the turn: nudge in the same session until finish_case, then add up usage. */
  afterTurn: <M extends { role: string }>(
    session: { messages: M[] },
    last: M | undefined,
    runTurn: (text: string) => Promise<M | undefined>,
  ) => Promise<M | undefined>;
}

export function autoAttemptHooks(
  caseId: string,
  record: AutoAttemptRecord,
  options: { timing?: AttemptTiming; finalize?: boolean; onStop?: (reason: string) => void } = {},
): AutoAttemptHooks {
  let finishing = options.finalize ?? false;
  let remind = false;
  let warned = 0;
  const guard = new RepetitionGuard();
  return {
    systemPromptSuffix: autoContract(caseId),
    finishTool: (pi) =>
      pi.defineTool({
        name: "finish_case",
        label: "Finish case",
        description:
          "End this case. status: done (complete, checks run), partial (progress, not complete) or blocked (needs a person; give blockedReason). summary: what changed. tests: tests you added or ran. learnings: up to 5 short notes for later cases.",
        parameters: Type.Object({
          status: Type.Union([
            Type.Literal("done"),
            Type.Literal("partial"),
            Type.Literal("blocked"),
          ]),
          summary: Type.String(),
          tests: Type.Optional(Type.Array(Type.String())),
          blockedReason: Type.Optional(Type.String()),
          learnings: Type.Optional(Type.Array(Type.String())),
        }),
        execute: async (_id, params) => {
          record.finish = {
            status: params.status,
            summary: params.summary,
            tests: params.tests ?? [],
            blockedReason: params.blockedReason,
            learnings: (params.learnings ?? []).slice(0, 5),
          };
          return {
            content: [
              {
                type: "text" as const,
                text: "Recorded. Dispatch will run the checks now. Stop here.",
              },
            ],
            details: {},
            terminate: true,
          };
        },
      }),
    extension: (pi) => {
      pi.on("session_compact", () => {
        record.compactions++;
        remind = true;
      });
      pi.on("tool_call", (event) => {
        if (finishing && WRITE_TOOLS.has(event.toolName))
          return { block: true, reason: "Only finish_case now. Do not change files." };
        if (event.toolName === "finish_case") return undefined;
        const verdict = guard.onCall(event.toolCallId, event.toolName, event.input);
        if (verdict.kind === "nudge") return { block: true, reason: verdict.reason };
        if (verdict.kind === "stop") {
          record.stopped = verdict.reason;
          options.onStop?.(verdict.reason);
          return { block: true, reason: `Stopped: ${verdict.reason}.`, terminate: true };
        }
        return undefined;
      });
      pi.on("tool_result", (event) => {
        guard.onResult(event.toolCallId, textOf(event.content));
        const notes: string[] = [];
        if (remind) notes.push(`[Case ${caseId}. When it is complete, call finish_case.]`);
        remind = false;
        const time = options.timing && timeNote(caseId, options.timing, warned);
        if (time) {
          warned = time.level;
          notes.push(time.text);
        }
        if (!notes.length) return undefined;
        return {
          content: [
            ...(event.content ?? []),
            { type: "text" as const, text: `\n${notes.join("\n")}` },
          ],
        };
      });
    },
    afterTurn: async (session, last, runTurn) => {
      let final = last;
      for (let n = 0; n < MAX_FINISH_NUDGES && !record.finish && !record.stopped; n++) {
        const stop = (final as { stopReason?: string } | undefined)?.stopReason;
        if (stop === "error" || stop === "aborted") break;
        finishing = true;
        record.nudges++;
        final = await runTurn(
          'You ended without calling finish_case. Call it now: status "done" if the case is complete and its checks pass, "partial" if not, or "blocked" with the reason. Do not change files.',
        );
      }
      for (const message of session.messages as Array<{
        role: string;
        usage?: Partial<AutoUsage>;
      }>) {
        if (message.role !== "assistant" || !message.usage) continue;
        record.usage.input += message.usage.input ?? 0;
        record.usage.output += message.usage.output ?? 0;
        record.usage.cacheWrite += message.usage.cacheWrite ?? 0;
        record.usage.cacheRead += message.usage.cacheRead ?? 0;
      }
      return final;
    },
  };
}

/** Poundlock or the model could not serve the attempt: retried later, never a repair. */
/**
 * A failure that passes if the run waits: Poundlock or the model unreachable or
 * busy, or a provider asking for a retry later (OpenRouter's in-flight credit
 * budget stopped a frontier Planner with a 402 and Retry-After). A
 * plain out-of-credits refusal is not one.
 */
export function isInferenceUnavailable(error: string | undefined): boolean {
  return Boolean(
    error &&
      /fetch failed|Connection error|Request timed out|may already have started|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|socket hang up|network error|provider stream ended|no progress from|not ready|capacity|Service Unavailable|Bad Gateway|Gateway Time-?out|\b50[234]\b|route changed|no longer advertised|in_flight_budget|Retry-After|rate.?limit|Too Many Requests|\b429\b/i.test(
        error,
      ),
  );
}
