import { amendedBoard } from "@core/orchestration";
import type { TaskRecord } from "@shared/types";
import { expect, it } from "vitest";

const task = (id: string, title: string, dependsOn: string[] = []) =>
  ({ id, title, dependsOn, status: "blocked", attempts: [] }) as unknown as TaskRecord;

it("inserts a new task before the task that now depends on it, and keeps the rest", () => {
  const published = [
    task("a", "Tests"),
    task("b", "Implement", ["a"]),
    task("c", "Closeout", ["b"]),
  ];
  const fix = task("n1", "Fix the frozen test", ["a"]);
  const updated = task("n2", "Implement", ["n1"]);
  const board = amendedBoard(published, [fix, updated], []);
  expect(board.map((item) => item.title)).toEqual([
    "Tests",
    "Fix the frozen test",
    "Implement",
    "Closeout",
  ]);
  expect(amendedBoard(published, [], ["closeout"]).map((item) => item.title)).toEqual([
    "Tests",
    "Implement",
  ]);
});

it("hands a removed task's dependencies to the tasks that waited on it", () => {
  const published = [
    task("a", "Import grouping"),
    task("b", "Managed copy", ["a"]),
    task("c", "Thumbnail cache", ["b"]),
  ];
  const split = task("n1", "Managed copy, part one", ["a"]);
  const board = amendedBoard(published, [split], ["Managed copy"]);
  expect(board.map((item) => [item.title, item.dependsOn])).toEqual([
    ["Import grouping", []],
    ["Thumbnail cache", ["a"]],
    ["Managed copy, part one", ["a"]],
  ]);
  expect(published[2].dependsOn).toEqual(["b"]);
});
