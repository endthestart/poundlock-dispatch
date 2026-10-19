/**
 * What the manager's model is sent of its own history. Pi stores the session
 * whole; this shapes only the copy sent with each request (Pi's `context`
 * event), so compaction, which counts what was sent, is reached later.
 */
import { condenseOldReviewPackets, type HistoryMessage, messageText } from "./review-context";

/** Tools whose results the manager can fetch again, and how to name one. */
const REREADABLE: Readonly<Record<string, (args: Record<string, unknown>) => string>> = {
  read_project_file: (args) => `read of ${typeof args.path === "string" ? args.path : "a file"}`,
  list_project_files: () => "file listing",
};

/** Results shorter than this cost less than the line that would replace them. */
const MIN_CONDENSED_CHARS = 400;

/**
 * Every file read and listing from an earlier turn reduced to a line naming it.
 *
 * Reads from earlier turns can be most of a long-running manager's context:
 * each stays in the session until
 * compaction although the manager reads a file for the decision at hand and can
 * read it again, current, when it needs it later. Reads in the current turn,
 * which starts at the latest user message, are kept whole.
 *
 * Returns the same array when there is nothing to condense.
 */
export function condenseOldFileReads<M extends HistoryMessage>(messages: M[]): M[] {
  const currentTurn = messages.findLastIndex((message) => message.role === "user");
  if (currentTurn <= 0) return messages;
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const message of messages.slice(0, currentTurn)) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
      calls.set(String(part.id), {
        name: part.name,
        args: (part.arguments ?? {}) as Record<string, unknown>,
      });
    }
  }
  let changed = false;
  const condensed = messages.map((message, index) => {
    if (index >= currentTurn || message.role !== "toolResult" || message.isError) return message;
    const call = calls.get(String(message.toolCallId));
    const name = call && REREADABLE[call.name];
    const chars = messageText(message).length;
    if (!call || !name || chars < MIN_CONDENSED_CHARS) return message;
    changed = true;
    const text = `[Earlier ${name(call.args)}, ${chars} characters, omitted. Read it again if you need it; it may have changed since.]`;
    return { ...message, content: [{ type: "text", text }] };
  });
  return changed ? condensed : messages;
}

/** The manager's history as its model is sent it. */
export function managerHistory<M extends HistoryMessage>(messages: M[]): M[] {
  return condenseOldFileReads(condenseOldReviewPackets(messages));
}

/** Characters per token assumed when sizing a summary request; low on purpose. */
const SUMMARY_CHARS_PER_TOKEN = 3;
/** Pi cuts each tool result to this many characters in a summary request. */
const SUMMARY_TOOL_RESULT_CHARS = 2_000;

/** The longest a single user message is in a summary request, as Pi cuts tool results. */
const SUMMARY_USER_MESSAGE_CHARS = 8_000;

function capUserMessage<M extends HistoryMessage>(message: M): M {
  if (message.role !== "user") return message;
  const text = messageText(message);
  if (text.length <= SUMMARY_USER_MESSAGE_CHARS) return message;
  const cut = text.length - SUMMARY_USER_MESSAGE_CHARS;
  const kept = `${text.slice(0, SUMMARY_USER_MESSAGE_CHARS)}\n\n[... ${cut} more characters cut for the summary]`;
  return { ...message, content: [{ type: "text", text: kept }] };
}

function summaryChars(message: HistoryMessage): number {
  const chars = JSON.stringify(message.content ?? "").length;
  return message.role === "toolResult" ? Math.min(chars, SUMMARY_TOOL_RESULT_CHARS) : chars;
}

/**
 * What Pi summarises at compaction, shaped as the turns themselves were sent,
 * then cut from the oldest end to fit `budgetTokens`.
 *
 * Pi summarised the stored history whole. Turns send decided review packets
 * and earlier file reads as one line each, so the history grew far past what
 * any turn sent before Pi compacted, and a summary request could exceed the
 * model's context, mostly in review packets. The earlier summary, which Pi
 * sends along, carries what is cut.
 */
export function historyForSummary<M extends HistoryMessage>(
  messages: M[],
  budgetTokens: number,
): M[] {
  const condensed = managerHistory(messages).map(capUserMessage);
  const budget = Math.max(0, budgetTokens) * SUMMARY_CHARS_PER_TOKEN;
  let used = 0;
  let start = condensed.length;
  while (start > 0 && used + summaryChars(condensed[start - 1]) <= budget) {
    used += summaryChars(condensed[start - 1]);
    start -= 1;
  }
  return start === 0 ? condensed : condensed.slice(start);
}
