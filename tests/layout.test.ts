import {
  COMFORT_MAIN_PX,
  fitPanels,
  fitPanelWidths,
  LEFT_PANEL,
  MIN_MAIN_PX,
  PANEL_HANDLE_PX,
  RIGHT_PANEL,
  resizeByKey,
} from "@shared/panel-layout";
import { describe, expect, it } from "vitest";

it("keeps the conversation column usable at the supported minimum window", () => {
  const fitted = fitPanelWidths(960, LEFT_PANEL.fallback, RIGHT_PANEL.fallback);
  expect(fitted.left + fitted.right + PANEL_HANDLE_PX * 2 + MIN_MAIN_PX).toBeLessThanOrEqual(960);
  expect(960 - (fitted.left + fitted.right + PANEL_HANDLE_PX * 2)).toBeGreaterThanOrEqual(
    MIN_MAIN_PX,
  );
});

it("shrinks stored inspector width before shrinking the project list", () => {
  const fitted = fitPanelWidths(960, LEFT_PANEL.max, RIGHT_PANEL.max);
  expect(fitted.right).toBe(RIGHT_PANEL.min);
  expect(fitted.left).toBeGreaterThanOrEqual(LEFT_PANEL.min);
  expect(960 - (fitted.left + fitted.right + PANEL_HANDLE_PX * 2)).toBeGreaterThanOrEqual(
    MIN_MAIN_PX,
  );
});

describe("fitPanels", () => {
  const open = {
    left: LEFT_PANEL.fallback,
    right: RIGHT_PANEL.fallback,
    leftCollapsed: false,
    rightCollapsed: false,
  };
  function mainWidth(width: number, fit: ReturnType<typeof fitPanels>) {
    return (
      width -
      (fit.leftDocked ? fit.left + PANEL_HANDLE_PX : 0) -
      (fit.rightDocked ? fit.right + PANEL_HANDLE_PX : 0)
    );
  }

  it.each([960, 1280, 1600, 2560])("docks both panels and fits them at %ipx", (width) => {
    const fit = fitPanels(width, { ...open, left: LEFT_PANEL.max, right: RIGHT_PANEL.max });
    expect(fit.leftDocked && fit.rightDocked).toBe(true);
    expect(mainWidth(width, fit)).toBeGreaterThanOrEqual(MIN_MAIN_PX);
  });

  it("protects a comfortable conversation width before honoring wide panels", () => {
    const fit = fitPanels(960, open);
    expect(mainWidth(960, fit)).toBeGreaterThanOrEqual(COMFORT_MAIN_PX);
    expect(fit.right).toBe(RIGHT_PANEL.min);
    expect(fitPanels(1920, open).right).toBe(RIGHT_PANEL.fallback);
  });

  it("does not rewrite stored preferences when the window shrinks", () => {
    const prefs = { ...open, right: 700 };
    const narrow = fitPanels(960, prefs);
    expect(narrow.right).toBeLessThan(700);
    expect(prefs.right).toBe(700);
    expect(fitPanels(2560, prefs).right).toBe(700);
  });

  it("undocks the status panel first when text zoom leaves no room", () => {
    const fit = fitPanels(480, open);
    expect(fit.rightDocked).toBe(false);
    expect(fit.rightSqueezed).toBe(true);
    expect(fit.leftDocked).toBe(true);
    expect(mainWidth(480, fit)).toBeGreaterThanOrEqual(MIN_MAIN_PX);
  });

  it("undocks both panels when the conversation would otherwise be unusable", () => {
    const fit = fitPanels(400, open);
    expect(fit.leftDocked || fit.rightDocked).toBe(false);
    expect(fit.leftSqueezed && fit.rightSqueezed).toBe(true);
  });

  it("gives the conversation the collapsed panel's room", () => {
    const fit = fitPanels(960, { ...open, rightCollapsed: true, left: LEFT_PANEL.max });
    expect(fit.rightDocked).toBe(false);
    expect(fit.rightSqueezed).toBe(false);
    expect(fit.left).toBe(LEFT_PANEL.max);
  });
});

describe("resizeByKey", () => {
  const bounds = { min: 100, max: 300 };
  it("moves the separator in the arrow direction and clamps", () => {
    expect(resizeByKey("ArrowRight", 200, bounds, { direction: 1 })).toBe(216);
    expect(resizeByKey("ArrowRight", 200, bounds, { direction: -1 })).toBe(184);
    expect(resizeByKey("ArrowLeft", 110, bounds, { direction: 1, shift: true })).toBe(100);
    expect(resizeByKey("End", 110, bounds, { direction: 1 })).toBe(300);
    expect(resizeByKey("Tab", 110, bounds, { direction: 1 })).toBeUndefined();
  });
});
