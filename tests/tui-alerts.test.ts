/**
 * The terminal's notifications: a bell for a decision, and a bell plus a
 * notice naming the project when an Autopilot run stops building or moves to
 * the local fallback, where the desktop app shows a notification. The bell
 * is on unless `/appearance notify off` turned it off.
 */
import { terminalAlerts } from "@tui/alerts";
import { memoryPreferences } from "@tui/preferences";
import { describe, expect, it, vi } from "vitest";

const BELL = String.fromCharCode(7);
const UI = { composerInfolets: [], desktopNotifications: false };

describe("terminalAlerts", () => {
  it("rings and names the project when an Autopilot run stops building", async () => {
    const written: string[] = [];
    const host = { setNotice: vi.fn(), emitState: vi.fn(async () => undefined) };
    const alerts = terminalAlerts(
      () => host,
      (text) => written.push(text),
      memoryPreferences(),
    );
    alerts.notifyAutopilot?.(
      "demo",
      { label: "Building 3/10 · on local fallback", tone: "active", onFallback: true },
      UI,
    );
    expect(host.setNotice).toHaveBeenCalledWith({
      kind: "info",
      text: "Autopilot · Building 3/10 · on local fallback: demo",
    });
    expect(host.emitState).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(host.emitState).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(written).toEqual([BELL]));
  });

  it("rings for a new decision, not when one is answered", async () => {
    const written: string[] = [];
    const alerts = terminalAlerts(
      () => ({ setNotice: vi.fn(), emitState: vi.fn() }),
      (text) => written.push(text),
      memoryPreferences(),
    );
    alerts.notifyNeedsYou?.(2, UI, true);
    alerts.notifyNeedsYou?.(1, UI, false);
    await vi.waitFor(() => expect(written).toEqual([BELL]));
    await new Promise((settle) => setTimeout(settle, 10));
    expect(written).toEqual([BELL]);
  });

  it("stays silent with the bell turned off, and still names the run", async () => {
    const written: string[] = [];
    const host = { setNotice: vi.fn(), emitState: vi.fn(async () => undefined) };
    const alerts = terminalAlerts(
      () => host,
      (text) => written.push(text),
      memoryPreferences({ transcriptDensity: "normal", bell: false }),
    );
    alerts.notifyNeedsYou?.(1, UI, true);
    alerts.notifyAutopilot?.("demo", { label: "Built", tone: "done" }, UI);
    await vi.waitFor(() => expect(host.emitState).toHaveBeenCalledOnce());
    expect(host.setNotice).toHaveBeenCalledWith({ kind: "info", text: "Autopilot · Built: demo" });
    expect(written).toEqual([]);
  });
});
