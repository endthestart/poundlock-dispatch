/**
 * What the menu bar icon shows while Dispatch runs without a window: the
 * Autopilot runs building in their own processes, so closing the window never
 * hides that work is going on (owner, 16 Oct; as the photo importer does).
 */
export interface TrayRun {
  projectId: string;
  name: string;
  phase: "building" | "interrupted";
  /** Autopilot's own counts, such as "10 verified, 1 in progress, 10 to do." */
  progress?: string;
}

export interface TrayView {
  tooltip: string;
  /** Next to the icon: how many runs are building, or nothing. */
  title: string;
  runs: Array<{ projectId: string; label: string }>;
}

const MAX_NAME = 40;

export function trayView(runs: TrayRun[]): TrayView {
  const building = runs.filter((run) => run.phase === "building").length;
  const stopped = runs.length - building;
  const name = (text: string) =>
    text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text;
  const counts = [
    building ? `${building} building` : "",
    stopped ? `${stopped} stopped` : "",
  ].filter(Boolean);
  return {
    tooltip: counts.length
      ? `Poundlock Dispatch · Autopilot: ${counts.join(", ")}`
      : "Poundlock Dispatch",
    title: building ? String(building) : "",
    runs: runs.map((run) => ({
      projectId: run.projectId,
      label:
        run.phase === "building"
          ? `${name(run.name)} — ${run.progress ?? "building"}`
          : `${name(run.name)} — stopped; open it to resume`,
    })),
  };
}
