import { withRepairFindings } from "@core/orchestration";
import { expect, it } from "vitest";

it("keeps only the latest review's findings in the worker brief", () => {
  const first = withRepairFindings("Implement the ABI.", "Delete the stub block.");
  const second = withRepairFindings(first, "Check the source format before the destination.");
  expect(second).toBe(
    "Implement the ABI.\n\nRepair findings from review:\nCheck the source format before the destination.",
  );
  expect(second).not.toMatch(/stub block/);
});
