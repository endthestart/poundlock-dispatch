/**
 * What the manager hears when its question points at questions the owner never saw.
 * A frontier manager wrote seven questions in its thinking and asked only "Please
 * answer 1–7 above"; the owner had nothing above to answer.
 */
export const UNSEEN_QUESTION =
  "The owner sees only this question and its options, never your thinking, and nothing you wrote this turn is shown above it. Put every question you need answered in the question itself (numbered questions are fine), then ask again.";

/** A question that sends the owner to text above it, as in "answer 1–7 above". */
export function pointsAbove(question: string): boolean {
  return /\b(?:answer|reply|respond|see|questions?|points?|items?|\d+\s*[–-]\s*\d+)\b[^?]*\babove\b/i.test(
    question,
  );
}

interface SessionEntry {
  type: string;
  message?: { role?: string; content?: unknown };
}

/** What the manager wrote where the owner can see it since the owner's last message. */
export function visibleTurnText(entries: readonly SessionEntry[]): string {
  const texts: string[] = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index].message;
    if (entries[index].type !== "message" || !message) continue;
    if (message.role === "user") break;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ type?: string; text?: unknown }>)
      if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
  }
  return texts.join("").trim();
}
