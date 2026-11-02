import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WeekSpend } from "@core/week-spend";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const reply = (at: string, usd: number) =>
  JSON.stringify({
    timestamp: at,
    message: { role: "assistant", usage: { cost: { total: usd } } },
  });
const planner = (at: string, usd: number) =>
  JSON.stringify({ seq: 1, at, event: { type: "planner_cost", costUsd: usd } });

it("adds the manager's and the Planner's last 7 days across projects and runs", async () => {
  const root = await tempDir("week-spend-");
  const sessions = [join(root, "p1", "sessions"), join(root, "p2", "sessions")];
  const runs = join(root, "runs");
  for (const dir of [...sessions, join(runs, "auto-1")]) await mkdir(dir, { recursive: true });
  await writeFile(
    join(sessions[0], "a.jsonl"),
    `${reply("2026-10-20T10:00:00.000Z", 5)}\n${reply("2026-10-27T10:00:00.000Z", 1.5)}\n`,
  );
  await writeFile(join(sessions[1], "b.jsonl"), `${reply("2026-10-28T09:00:00.000Z", 0.25)}\n`);
  await writeFile(
    join(runs, "auto-1", "events.jsonl"),
    `${planner("2026-10-19T00:00:00.000Z", 3)}\n${planner("2026-10-28T08:00:00.000Z", 0.75)}\n${JSON.stringify({ seq: 3, at: "2026-10-28T09:00:00.000Z", event: { type: "milestone_review", milestoneId: "M1", complete: false, verdicts: [], costUsd: 0.5 } })}\n`,
  );
  const spend = new WeekSpend();
  const now = new Date("2026-10-28T12:00:00.000Z");
  // A milestone review's Planner cost counts as the run's own total counts it.
  expect(await spend.total(sessions, runs, now)).toBeCloseTo(3);
  // Read again at most once a minute, and only the files that changed.
  await writeFile(join(sessions[1], "b.jsonl"), `${reply("2026-10-28T11:00:00.000Z", 4)}\n`);
  expect(await spend.total(sessions, runs, new Date(now.getTime() + 30_000))).toBeCloseTo(3);
  expect(await spend.total(sessions, runs, new Date(now.getTime() + 61_000))).toBeCloseTo(6.75);
  expect(await new WeekSpend().total([join(root, "missing")], undefined, now)).toBe(0);
});
