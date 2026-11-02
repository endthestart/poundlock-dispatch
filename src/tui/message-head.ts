/**
 * The faint line over a message: the manager's reasoning when the turn set
 * one, and when it was said, as the app's message header has them. The
 * speaker is left out on purpose: the layout already says whose words these
 * are (yours against the right margin, the manager's flush left).
 */
import { reasoningLabel } from "@shared/reasoning";
import type { ChatMessage } from "@shared/types";

export function messageHead(message: Pick<ChatMessage, "reasoning" | "createdAt">): string {
  const reasoning =
    message.reasoning && !["model_default", "none"].includes(message.reasoning)
      ? `Reasoning: ${reasoningLabel(message.reasoning).toLowerCase()}`
      : undefined;
  // The streaming draft has no time yet; "now" holds its line, so the reply does not shift when it lands.
  const time = message.createdAt
    ? new Date(message.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "now";
  return [reasoning, time].filter(Boolean).join(" · ");
}
