import type { LiveWorkEntry } from "./types.js";

export const LIVE_WORK_LIMIT = 24;

export function activityLogKey(text: string): string {
  return text.replace(/ · \d+s$/, "");
}

export type LiveWorkDockView = {
  currentText: string;
  currentAt?: string;
  earlier: LiveWorkEntry[];
  spinning: boolean;
};

type ConversationTimelineItem<M> =
  | { kind: "message"; message: M }
  | { kind: "activity"; entry: LiveWorkEntry };

/**
 * Keep one settled status for each interval between messages. A running status
 * is rendered separately after the draft, so it stays at the bottom while the
 * reply streams instead of leaving a trail of heartbeat rows behind it.
 */
export function conversationTimeline<M extends { createdAt: string }>(
  messages: M[],
  entries: LiveWorkEntry[] | undefined,
  activity?: string,
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
    let settled: LiveWorkEntry | undefined;
    while (next < work.length && work[next].at <= message.createdAt) {
      settled = work[next++];
    }
    if (settled) timeline.push({ kind: "activity", entry: settled });
    timeline.push({ kind: "message", message });
  }
  if (!active && next < work.length) {
    timeline.push({ kind: "activity", entry: work.at(-1)! });
  }
  return timeline;
}

/**
 * Entries from the log that belong to the turn still in progress. Anything at
 * or before `lastMessageAt` already has a permanent home on that message's own
 * `toolTrace`, so it is excluded here to avoid showing it a second time,
 * trailing out of order below whatever message comes after it.
 */
export function pendingLiveWork(
  entries: LiveWorkEntry[] | undefined,
  lastMessageAt: string | undefined,
): LiveWorkEntry[] | undefined {
  if (!lastMessageAt) return entries;
  const cutoff = new Date(lastMessageAt).getTime();
  return entries?.filter((entry) => new Date(entry.at).getTime() > cutoff);
}

/** Mix activity into the conversation. History stays when idle; only the last line spins while a turn runs. */
export function liveWorkDockView(
  activity?: string,
  entries?: LiveWorkEntry[],
): LiveWorkDockView | undefined {
  const items = entries?.slice(-LIVE_WORK_LIMIT) ?? [];
  const currentText = activity?.trim();
  if (!currentText && !items.length) return undefined;
  if (!currentText) {
    const last = items.at(-1)!;
    return {
      currentText: last.text,
      currentAt: last.at,
      earlier: items.slice(0, -1),
      spinning: false,
    };
  }
  const last = items.at(-1);
  const lastIsCurrent = Boolean(last && activityLogKey(last.text) === activityLogKey(currentText));
  return {
    currentText,
    currentAt: lastIsCurrent ? last?.at : undefined,
    earlier: lastIsCurrent ? items.slice(0, -1) : items,
    spinning: true,
  };
}
