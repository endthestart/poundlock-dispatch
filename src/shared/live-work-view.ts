import type { LiveWorkEntry } from "./types.js";

export const LIVE_WORK_LIMIT = 24;

export function activityLogKey(text: string): string {
  return text.replace(/ · \d+s$/, "");
}

/** Normal folds tool and system steps; Verbose shows every one. */
export type TranscriptDensity = "normal" | "verbose";

type ConversationTimelineItem<M> =
  | { kind: "message"; message: M }
  /** `hidden`: earlier steps Normal folded into this one, so a failure among them is not lost unseen. */
  | { kind: "activity"; entry: LiveWorkEntry; hidden?: number };

/**
 * Keep one settled status for each interval between messages, or every status
 * when the transcript is verbose. A running status is rendered separately after
 * the draft, so it stays at the bottom while the reply streams instead of
 * leaving a trail of heartbeat rows behind it.
 */
export function conversationTimeline<M extends { createdAt: string }>(
  messages: M[],
  entries: LiveWorkEntry[] | undefined,
  activity: string | undefined,
  density: TranscriptDensity,
): ConversationTimelineItem<M>[] {
  const timeline: ConversationTimelineItem<M>[] = [];
  const work = [...(entries ?? [])].sort((a, b) => a.at.localeCompare(b.at));
  const active = Boolean(activity?.trim());
  if (
    active &&
    work.length &&
    activityLogKey(work.at(-1)!.text) === activityLogKey(activity!.trim())
  ) {
    work.pop();
  }
  let next = 0;
  for (const message of messages) {
    const settled: LiveWorkEntry[] = [];
    while (next < work.length && work[next].at <= message.createdAt) {
      settled.push(work[next++]);
    }
    if (density === "verbose")
      for (const entry of settled) timeline.push({ kind: "activity", entry });
    else if (settled.length) timeline.push(folded(settled));
    timeline.push({ kind: "message", message });
  }
  const rest = work.slice(next);
  if (density === "verbose") for (const entry of rest) timeline.push({ kind: "activity", entry });
  else if (!active && rest.length) timeline.push(folded(rest));
  return timeline;
}

/** The last of a run of steps, counting the ones before it that Normal leaves out. */
function folded(entries: LiveWorkEntry[]): {
  kind: "activity";
  entry: LiveWorkEntry;
  hidden?: number;
} {
  const entry = entries.at(-1)!;
  return entries.length > 1
    ? { kind: "activity", entry, hidden: entries.length - 1 }
    : { kind: "activity", entry };
}
