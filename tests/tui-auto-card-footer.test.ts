/**
 * The commands under the Autopilot card follow the run: a live run is
 * stopped, a paused one resumed, an ended one merged or dropped.
 */
import { autoCardFooter } from "@tui/auto-card";
import { expect, it } from "vitest";

it("offers what fits where the run is", () => {
  expect(autoCardFooter("running")).toContain("/autopilot details · stop");
  expect(autoCardFooter("running")).toContain("runs on after you quit");
  expect(autoCardFooter("interrupted")).toContain("/autopilot details · resume");
  const ended = autoCardFooter("ended");
  expect(ended).toBe("/autopilot details · merge · export · report · drop · hide");
});
