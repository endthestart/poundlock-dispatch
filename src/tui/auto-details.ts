/**
 * The run card's Details as the terminal shows them: the shared summary
 * sentence, the progress lines, and each task with its stage and the reason
 * it stopped. `dispatch autopilot status` prints them under the card;
 * `/auto details` shows them on their own screen.
 */
import type { AutopilotView } from "@shared/auto-run";
import { autopilotDetails, autopilotDetailsSummary } from "@shared/autopilot-details";
import { displaySafe } from "@shared/display-safe";
import type { Colours } from "./colour.js";
import { heading, wrap } from "./render.js";

export function runDetailLines(view: AutopilotView): string[] {
  const details = autopilotDetails(view);
  return [
    autopilotDetailsSummary(details),
    ...details.lines,
    ...details.cases.map(
      (item, index) =>
        `${index + 1}. ${item.label} · ${item.title}${item.reason ? ` — ${item.reason}` : ""}`,
    ),
  ];
}

/** The details screen: the card, then the details, as the app's card opens them. */
export function renderRunDetails(
  card: string[] | undefined,
  view: AutopilotView | undefined,
  width: number,
  colours: Colours,
): string[] {
  const lines = heading(colours, "Autopilot run", "/chat to return", width);
  if (!view || !card) {
    lines.push("", colours.paint("muted", "This folder has no Autopilot run."));
    return lines;
  }
  // Titles, reasons and activity carry the model's words: nothing in them may drive the terminal.
  for (const line of [...card, "", ...runDetailLines(view)])
    lines.push(...(line ? wrap(displaySafe(line), width) : [""]));
  return lines;
}
