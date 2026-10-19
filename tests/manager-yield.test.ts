import { settleManagerPrompt } from "@core/manager-yield";
import { expect, it } from "vitest";

it("returns after a terminating tool even when session.prompt never settles", async () => {
  let hung = false;
  let resolveYield!: () => void;
  const whenYielded = new Promise<void>((resolve) => {
    resolveYield = resolve;
  });
  const prompt = new Promise(() => undefined);
  const pending = settleManagerPrompt(prompt, () => true, whenYielded, {
    graceMs: 20,
    onHung: () => {
      hung = true;
    },
  });
  resolveYield();
  await expect(pending).resolves.toBe("yielded");
  await new Promise((resolve) => setTimeout(resolve, 15));
  expect(hung).toBe(true);
});

it("propagates prompt failures when the turn did not yield", async () => {
  await expect(
    settleManagerPrompt(
      Promise.reject(new Error("inference failed")),
      () => false,
      new Promise(() => undefined),
    ),
  ).rejects.toThrow("inference failed");
});
