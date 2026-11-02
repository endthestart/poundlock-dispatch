/**
 * The terminal client leaves cleanly however it is closed, closing the
 * terminal window included, so it releases the folder it drives.
 */
import { EventEmitter } from "node:events";
import { closeOnSignals } from "@tui/index";
import { expect, it, vi } from "vitest";

const processLike = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter() });

it("closes on Ctrl+C, a kill, and the terminal window closing", () => {
  const target = processLike();
  const close = vi.fn();
  closeOnSignals(close, target as unknown as NodeJS.Process);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) target.emit(signal);
  expect(close).toHaveBeenCalledTimes(3);
});

it("survives writing to a terminal that has closed, so the shutdown finishes", () => {
  const target = processLike();
  closeOnSignals(vi.fn(), target as unknown as NodeJS.Process);
  target.emit("SIGHUP");
  expect(() =>
    target.stdout.emit("error", Object.assign(new Error("write EIO"), { code: "EIO" })),
  ).not.toThrow();
});
