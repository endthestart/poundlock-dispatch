/**
 * The board's tasks while Autopilot works them, as the app's Tasks section
 * shows them: grouped by milestone with how many are verified, and the tasks
 * that did not finish set apart, from the shared `autopilotBoard`.
 */
import type { CaseStage } from "@shared/auto-run";
import { AUTOPILOT_BOARD_HINT, type AutopilotBoard, taskStage } from "@shared/task-view";
import type { TaskRecord } from "@shared/types";
import type { Colours } from "./colour.js";
import { subheading, wrap } from "./render.js";

/** The terminal merges with a command, not from the app's panel. */
const HINT = AUTOPILOT_BOARD_HINT.replace("from the Autopilot panel", "with /autopilot merge");

export function runBoardLines(
  board: AutopilotBoard,
  row: (task: TaskRecord, stage: CaseStage | undefined) => string[],
  width: number,
  colours: Colours,
): string[] {
  const lines = [colours.paint("muted", board.progress), ""];
  for (const group of board.groups) {
    if (group.title)
      lines.push(
        subheading(colours, `${group.title} · ${group.verified} of ${group.total} verified`),
      );
    for (const task of group.tasks) lines.push(...row(task, taskStage(task, board.stages)), "");
    if (group.unfinished.length) {
      lines.push(
        colours.paint(
          "faint",
          `${group.unfinished.length} did not finish; the Planner replans what they were for:`,
        ),
      );
      for (const task of group.unfinished)
        lines.push(...row(task, taskStage(task, board.stages)), "");
    }
  }
  lines.push(...wrap(HINT, width).map((line) => colours.paint("faint", line)));
  return lines;
}
