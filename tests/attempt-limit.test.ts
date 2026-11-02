import { attemptClock } from "@core/attempt-limit";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
});

const approval = {
  projectId: "p",
  projectName: "P",
  taskId: "t",
  planRevision: 1,
  kind: "bash" as const,
  action: "cargo --version",
  reason: "Approve this exact program.",
};

it("stops an attempt's clock while the owner decides an approval", async () => {
  // A plan review timed out waiting 45 minutes for `cargo --version`.
  vi.useFakeTimers();
  const expire = vi.fn();
  const clock = attemptClock(expire, 10_000);
  let answer: (allowed: boolean) => void = () => {};
  vi.advanceTimersByTime(4_000);
  const asked = clock
    .approvals({ request: () => new Promise<boolean>((resolve) => (answer = resolve)) })
    .request(approval);
  vi.advanceTimersByTime(60_000);
  expect(expire).not.toHaveBeenCalled();
  answer(true);
  await expect(asked).resolves.toBe(true);
  vi.advanceTimersByTime(5_999);
  expect(expire).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(expire).toHaveBeenCalledOnce();
});

it("runs out after its budget without approvals, and never after it stops", () => {
  vi.useFakeTimers();
  const expire = vi.fn();
  attemptClock(expire, 10_000);
  vi.advanceTimersByTime(10_000);
  expect(expire).toHaveBeenCalledOnce();
  const stopped = vi.fn();
  attemptClock(stopped, 10_000).stop();
  vi.advanceTimersByTime(20_000);
  expect(stopped).not.toHaveBeenCalled();
});
