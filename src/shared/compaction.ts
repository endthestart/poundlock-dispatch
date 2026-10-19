/**
 * What the owner is told about compaction, in one place so the terminal, the
 * desktop app and the worker activity line all say the same thing.
 *
 * Pi compacts a conversation when its context nears the window minus a
 * reserve: it replaces older messages with a summary and keeps the recent ones.
 * Nothing Dispatch stores is changed by it. The conversation the owner reads is
 * Dispatch's own record, and the project brief rides in the system prompt of
 * every turn, so compaction cannot reach either. Both facts are worth saying
 * each time, because the owner cannot otherwise see that compaction happened.
 */

export type CompactionReason = "manual" | "threshold" | "overflow";

/** What one compaction did, in numbers the owner can read. */
export interface CompactionSummary {
  reason: CompactionReason;
  /** The context's estimated size, in tokens, before it. */
  tokensBefore: number;
  /** The same estimate after it: the summary plus the messages kept. */
  tokensAfter?: number;
  /** Messages the summary replaced. */
  summarisedMessages?: number;
  /** Messages kept as written beside the summary. */
  keptMessages?: number;
}

/** A compaction Pi ran on its own, or one that failed part way. */
export type CompactionEvent =
  | ({ status: "compacted" } & CompactionSummary)
  | { status: "failed"; reason: CompactionReason; error: string };

/** What asking for a compaction came to. */
export type CompactOutcome =
  | ({ status: "compacted" } & CompactionSummary)
  | { status: "nothing"; why: "too_small" | "already_compacted" }
  | { status: "unsupported" };

/** The most instructions a manual compaction takes: a line or two of what to keep. */
export const MAX_COMPACT_INSTRUCTIONS = 1_000;

/** Above this share of the window the owner is offered a compaction. */
export const COMPACT_OFFER_PERCENT = 60;

const count = (value: number) => Math.round(value).toLocaleString("en-US");
/** Token figures are estimates, so they are rounded to the hundred and called "about". */
const about = (value: number) => `about ${count(Math.round(value / 100) * 100)}`;
const plural = (value: number, noun: string) => `${count(value)} ${noun}${value === 1 ? "" : "s"}`;

const WHY: Record<CompactionReason, string> = {
  manual: "at your request",
  threshold: "automatically, because the context was nearing the model's limit",
  overflow: "automatically, after the model reported its context was full",
};

/**
 * The notice that goes into the conversation. Plain text: the terminal shows
 * it as written.
 */
export function compactionNoticeText(event: CompactionEvent): string {
  if (event.status === "failed")
    return `The conversation could not be compacted (${event.error}). The manager's context is unchanged; it may run out of room if the conversation keeps growing. Try compacting again, or start a new conversation.`;
  const size = event.tokensAfter
    ? `The manager's context went from ${about(event.tokensBefore)} to ${about(event.tokensAfter)} tokens`
    : `The manager's context held ${about(event.tokensBefore)} tokens`;
  const replaced =
    event.summarisedMessages === undefined
      ? "older messages are now a summary"
      : `${plural(event.summarisedMessages, "earlier message")} ${event.summarisedMessages === 1 ? "is" : "are"} now a summary`;
  const kept =
    event.keptMessages === undefined
      ? "the most recent ones were kept as written"
      : `the ${event.keptMessages === 1 ? "most recent message was" : `${count(event.keptMessages)} most recent messages were`} kept as written`;
  return [
    `Conversation compacted ${WHY[event.reason]}.`,
    `${size}: ${replaced}, and ${kept}.`,
    "The project brief stays pinned, and the conversation shown here is unchanged.",
  ].join(" ");
}

/** The short form, for the notice line a client keeps on screen. */
export function compactionLine(summary: CompactionSummary): string {
  return summary.tokensAfter
    ? `Conversation compacted: ${about(summary.tokensBefore)} down to ${about(summary.tokensAfter)} tokens.`
    : "Conversation compacted.";
}

/** Why a requested compaction changed nothing. */
export function compactionSkippedText(outcome: {
  status: "nothing" | "unsupported";
  why?: "too_small" | "already_compacted";
}): string {
  if (outcome.status === "unsupported") return "This manager keeps no conversation to compact.";
  return outcome.why === "already_compacted"
    ? "Already compacted: nothing has been added since the last summary."
    : "Nothing to compact yet: the conversation is still short enough to keep whole.";
}

/** One line for a worker's activity trail. */
export function workerCompactionText(modelId: string, summary: CompactionSummary): string {
  const size = summary.tokensAfter
    ? ` (${about(summary.tokensBefore)} down to ${about(summary.tokensAfter)} tokens)`
    : "";
  return `${modelId}: compacted its conversation${size}`;
}

/** The compactions a worker attempt recorded in its provenance, if any. */
export function compactionsFromProvenance(
  provenance: Record<string, unknown> | undefined,
): CompactionSummary[] {
  const recorded = provenance?.compactions;
  if (!Array.isArray(recorded)) return [];
  return recorded.filter(
    (item): item is CompactionSummary =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as CompactionSummary).tokensBefore === "number",
  );
}

/** One line for a task's evidence, or `undefined` when its worker never compacted. */
export function compactionEvidenceText(compactions: CompactionSummary[]): string | undefined {
  const last = compactions.at(-1);
  if (!last) return undefined;
  const times = compactions.length === 1 ? "once" : `${compactions.length} times`;
  const size = last.tokensAfter
    ? ` (${about(last.tokensBefore)} down to ${about(last.tokensAfter)} tokens${compactions.length > 1 ? " the last time" : ""})`
    : "";
  return `Compacted ${times}${size}: older steps were summarised.`;
}

/** The conversation's context use as the manager reports it after a turn or a compaction. */
export interface ContextUsage {
  /** Estimated tokens in the manager's context now. */
  tokens: number;
  /** The model's context window. */
  windowTokens: number;
  /** The size above which the manager compacts on its own. */
  autoCompactAtTokens: number;
}

export interface ContextUsageView {
  percent: number;
  text: string;
  title: string;
  /** True once it is worth offering a compaction before the automatic one. */
  offerCompact: boolean;
}

export function contextUsageView(usage: ContextUsage): ContextUsageView {
  const percent = Math.min(
    100,
    Math.max(0, Math.round((usage.tokens / Math.max(1, usage.windowTokens)) * 100)),
  );
  const auto = Math.round((usage.autoCompactAtTokens / Math.max(1, usage.windowTokens)) * 100);
  return {
    percent,
    text: `context ${percent}% used`,
    title: `About ${count(usage.tokens)} of ${count(usage.windowTokens)} tokens. The manager compacts the conversation on its own at about ${auto}%.`,
    offerCompact: percent >= COMPACT_OFFER_PERCENT,
  };
}

/** The part of a Pi session event that compaction cares about. */
export interface PiCompactionSignal {
  type: string;
  reason?: CompactionReason;
  result?: { tokensBefore: number; estimatedTokensAfter?: number } | undefined;
  aborted?: boolean;
  errorMessage?: string;
}

/**
 * Reads Pi's `compaction_end` event. `undefined` for any other event, and for
 * a compaction that means nothing to tell: one the owner or a pause cancelled.
 * The message counts come from the caller, which saw what Pi was about to
 * summarise.
 */
export function compactionFromPiEvent(
  event: PiCompactionSignal,
  counts: { summarisedMessages?: number; keptMessages?: number } = {},
): CompactionEvent | undefined {
  if (event.type !== "compaction_end" || !event.reason) return undefined;
  if (event.result)
    return {
      status: "compacted",
      reason: event.reason,
      tokensBefore: event.result.tokensBefore,
      ...(event.result.estimatedTokensAfter === undefined
        ? {}
        : { tokensAfter: event.result.estimatedTokensAfter }),
      ...counts,
    };
  if (event.aborted || !event.errorMessage) return undefined;
  return {
    status: "failed",
    reason: event.reason,
    error: event.errorMessage.replace(/^(Auto-compaction|Compaction) failed: /, ""),
  };
}
