/**
 * `dispatch autopilot merge` and `report`: the run card's "Merge into
 * folder…" and "Open report" for a shell. Merging changes the owner's folder,
 * so without `--yes` it only says what a merge would bring.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { autopilotView, mergePreview, mergeRun } from "@core/auto/control";
import { readRunFile } from "@core/auto/runs";
import { type AutopilotFacilities, mergeAutopilot } from "@core/host/autopilot";
import type { TUI } from "@earendil-works/pi-tui";
import type { AutopilotMergePreview } from "@shared/auto-run";
import type { RunCardDeps } from "./auto-card.js";
import type { Colours } from "./colour.js";
import { showPicker } from "./picker.js";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function mergeSummary(preview: AutopilotMergePreview): string[] {
  return [
    `${plural(preview.commits, "commit")}, ${plural(preview.files, "file")} changed, up to ${preview.head.slice(0, 12)}. Verified by the checks, not reviewed.`,
    ...(preview.runsHere.length
      ? [
          `These run on this computer once merged; review them first: ${preview.runsHere.join(", ")}`,
        ]
      : []),
  ];
}

/**
 * Fast-forward the run's folder to its last verified commit. The folder's
 * newest run in a Dispatch project goes through the app's own merge, which
 * also marks the board's tasks the run verified as done.
 */
export async function mergeCommand(
  runDir: string,
  yes: boolean,
  deps: RunCardDeps & Pick<AutopilotFacilities, "spawnRunner">,
): Promise<string[]> {
  if (!yes) {
    const preview = await mergePreview(runDir);
    return [
      ...mergeSummary(preview),
      `Fast-forward the folder to it with: dispatch autopilot merge ${(await readRunFile(runDir)).runId} --yes`,
    ];
  }
  const run = await readRunFile(runDir);
  const found = await deps.project(run.source);
  const newest = (await autopilotView(deps.paths, run.source))?.runId === run.runId;
  const merged =
    found && newest
      ? await mergeAutopilot(
          { paths: deps.paths, checkRunner: async () => undefined, spawnRunner: deps.spawnRunner },
          found.store,
          found.project,
        )
      : await mergeRun(runDir);
  return [
    `Merged ${plural(merged.commits, "verified commit")} (${plural(merged.files, "file")}) into ${run.source}. The work was verified by the checks, not reviewed.`,
  ];
}

/** `/autopilot merge` in the terminal client: the preview, confirmed in a picker as the app's dialog confirms it. */
export async function confirmMerge(tui: TUI, colours: Colours, runDir: string): Promise<boolean> {
  const summary = mergeSummary(await mergePreview(runDir)).join(" ");
  const picked = await showPicker(
    tui,
    colours,
    [
      { value: "merge", label: "Merge", description: summary },
      { value: "cancel", label: "Cancel" },
    ],
    { title: "Merge Autopilot's work into the folder" },
  );
  return picked?.value === "merge";
}

/** Where the run's report is; it is written when the run ends. */
export function reportPath(runDir: string): string {
  const report = join(runDir, "report.md");
  if (!existsSync(report))
    throw new Error("This run has no report yet: it is written when the run ends.");
  return report;
}
