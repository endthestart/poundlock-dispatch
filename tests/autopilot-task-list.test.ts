import { milestoneGroups } from "@shared/milestones";
import { autopilotProgressLine, autopilotTaskView, autopilotUnfinished } from "@shared/task-view";
import type { Milestone } from "@shared/types";
import { expect, it } from "vitest";

it("counts a board Autopilot works from its own stages, never calling verified work next", () => {
  expect(
    autopilotProgressLine([
      "accepted",
      "abandoned",
      "skipped",
      "skipped",
      "accepted",
      "repairing",
      "pending",
      "pending",
    ]),
  ).toBe("Autopilot: 2 verified, 1 in progress, 2 to do. 3 tasks did not finish.");
  expect(autopilotProgressLine(["pending"])).toBe("Autopilot: 0 verified, 1 to do.");
});

it("shows verified work as done but not reviewed, and to-do work as neutral", () => {
  expect(autopilotTaskView("accepted")).toMatchObject({
    icon: "verified",
    tone: "verified",
    accepted: false,
  });
  expect(autopilotTaskView("pending")).toMatchObject({ label: "To do", tone: "queued" });
  expect(autopilotUnfinished("skipped")).toBe(true);
  expect(autopilotUnfinished("accepted")).toBe(false);
});

it("groups tasks under their milestones in plan order, with the rest last", () => {
  const milestones = [
    { id: "M1", title: "Catalog" },
    { id: "M2", title: "Import" },
    { id: "M3", title: "Views" },
  ] as Milestone[];
  const tasks = [
    { title: "a", milestoneId: "M2" },
    { title: "b", milestoneId: "M1" },
    { title: "c" },
    { title: "d", milestoneId: "M1" },
  ];
  expect(
    milestoneGroups(tasks, milestones).map((group) => [
      group.title,
      group.tasks.map((t) => t.title),
    ]),
  ).toEqual([
    ["M1 · Catalog", ["b", "d"]],
    ["M2 · Import", ["a"]],
    ["Other tasks", ["c"]],
  ]);
  expect(milestoneGroups(tasks, [])).toEqual([{ id: "all", tasks }]);
});
