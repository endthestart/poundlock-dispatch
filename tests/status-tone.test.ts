import { CARD_TONES, projectGlance, projectStatusTone } from "@shared/status-tone";
import type { ProjectStatus } from "@shared/types";
import { describe, expect, it } from "vitest";

/**
 * The tone of the project state, shared by the desktop header pill and the
 * terminal's title bar so the two never colour the same state differently.
 */
describe("projectStatusTone", () => {
  it("is active for anything the shared status derivation calls active, whatever the raw status", () => {
    expect(projectStatusTone("running", true)).toBe("active");
    expect(projectStatusTone("waiting_for_capacity", true)).toBe("active");
    expect(projectStatusTone("draft", true)).toBe("active");
  });

  it("asks for you when a plan, an answer or a pause is waiting", () => {
    for (const status of ["awaiting_approval", "needs_input", "paused"] as ProjectStatus[])
      expect(projectStatusTone(status, false)).toBe("review");
  });

  it("marks a finished run accepted and a failed one a problem", () => {
    expect(projectStatusTone("completed", false)).toBe("accepted");
    expect(projectStatusTone("failed", false)).toBe("problem");
  });

  it("leaves everything else quiet", () => {
    for (const status of ["draft", "planning", "cancelled"] as ProjectStatus[])
      expect(projectStatusTone(status, false)).toBe("muted");
  });
});

it("shows a project's Autopilot glance unless interactive work outranks it", () => {
  const glances = { p1: { label: "Building 2/5", tone: "active" as const } };
  expect(projectGlance({ id: "p1", status: "draft" }, glances)?.label).toBe("Building 2/5");
  expect(projectGlance({ id: "p1", status: "needs_input" }, glances)).toBeUndefined();
  expect(projectGlance({ id: "p2", status: "draft" }, glances)).toBeUndefined();
  expect(CARD_TONES.stopped).toBe("muted");
  expect(CARD_TONES.needs_you).toBe(projectStatusTone("needs_input", false));
});
