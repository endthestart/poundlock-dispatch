import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ManagerSpend, sessionCost } from "@core/manager-spend";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const reply = (usd: number) =>
  JSON.stringify({ message: { role: "assistant", usage: { cost: { total: usd } } } });

it("adds up the manager's priced replies across its sessions, and only those", async () => {
  expect(
    sessionCost(
      [reply(0.5), JSON.stringify({ message: { role: "user" } }), reply(0.25)].join("\n"),
    ),
  ).toBe(0.75);
  const sessions = join(await tempDir("manager-spend-"), "sessions");
  await mkdir(sessions);
  await writeFile(join(sessions, "a.jsonl"), `${reply(1)}\n`);
  // A reply still being written is skipped, not an error.
  await writeFile(join(sessions, "b.jsonl"), `${reply(0.4)}\n${reply(0.1)}\n{"message":{"ro`);
  await writeFile(join(sessions, "notes.txt"), reply(9));
  const spend = new ManagerSpend();
  expect(await spend.of(sessions)).toBeCloseTo(1.5);
  await writeFile(join(sessions, "a.jsonl"), `${reply(1)}\n${reply(2)}\n`);
  expect(await spend.of(sessions)).toBeCloseTo(3.5);
  expect(await spend.of(join(sessions, "missing"))).toBe(0);
});
