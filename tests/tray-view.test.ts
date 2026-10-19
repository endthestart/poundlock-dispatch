import { trayView } from "@shared/tray-view";
import { expect, it } from "vitest";

it("lists building and stopped Autopilot runs, with a count by the icon", () => {
  const view = trayView([
    {
      projectId: "p1",
      name: "Photo Library (run 2)",
      phase: "building",
      progress: "10 verified, 1 in progress, 10 to do.",
    },
    {
      projectId: "p2",
      name: "A project whose name is far too long for a menu bar",
      phase: "interrupted",
    },
  ]);
  expect(view.title).toBe("1");
  expect(view.tooltip).toBe("Poundlock Dispatch · Autopilot: 1 building, 1 stopped");
  expect(view.runs).toEqual([
    {
      projectId: "p1",
      label: "Photo Library (run 2) — 10 verified, 1 in progress, 10 to do.",
    },
    {
      projectId: "p2",
      label: "A project whose name is far too long fo… — stopped; open it to resume",
    },
  ]);
});

it("shows only the app's name when nothing is building", () => {
  expect(trayView([])).toEqual({ tooltip: "Poundlock Dispatch", title: "", runs: [] });
});
