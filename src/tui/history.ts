/**
 * `/history`: the earlier conversations, plans and tasks New conversation and
 * Start a new run moved aside, as the app's History dialog lists them, newest
 * first, read from the top.
 */
import { displaySafe } from "@shared/display-safe";
import type { RunHistoryRecord } from "@shared/types";
import type { Colours } from "./colour.js";
import { bulleted, heading, subheading, wrap } from "./render.js";

const SPEAKER = { user: "You", manager: "Project Manager", system: "Poundlock Dispatch" } as const;

function taskState(status: string): string {
  return status === "applied" ? "Accepted" : status.replaceAll("_", " ");
}

export function renderHistory(
  history: RunHistoryRecord[],
  width: number,
  colours: Colours,
): string[] {
  const lines = heading(colours, "History", "/chat to return", width);
  lines.push(
    ...wrap(
      "Earlier conversations, plans and tasks for this project. Project files are unchanged.",
      width,
    ).map((line) => colours.paint("muted", line)),
  );
  if (!history.length) lines.push("", colours.paint("muted", "Nothing archived yet."));
  for (const record of history) {
    const headline = record.plan?.summary.split("\n")[0].slice(0, 90) || "Conversation";
    lines.push(
      "",
      subheading(
        colours,
        `${new Date(record.archivedAt).toLocaleString()} · ${displaySafe(headline)}`,
      ),
    );
    if (record.plan) {
      lines.push(colours.paint("faint", `Plan · revision ${record.plan.revision}`));
      lines.push(...wrap(displaySafe(record.plan.summary), width));
    }
    if (record.tasks.length)
      lines.push(
        colours.paint("faint", "Tasks"),
        ...bulleted(
          colours,
          record.tasks.map((task) => `${displaySafe(task.title)} · ${taskState(task.status)}`),
          width,
        ),
      );
    if (record.messages.length) lines.push(colours.paint("faint", "Conversation"));
    for (const message of record.messages)
      lines.push(...wrap(`${SPEAKER[message.role]}: ${displaySafe(message.text)}`, width));
  }
  return lines;
}
