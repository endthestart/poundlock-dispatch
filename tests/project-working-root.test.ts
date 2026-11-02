import { projectWorkingRoot } from "@core/workflow-support";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

function folderSource(path: string, baseRevision = "") {
  return {
    kind: "local_folder" as const,
    originalPath: path,
    baseRevision,
    excludedPatterns: [],
  };
}

describe("project working root", () => {
  it("uses the live folder for a local project", async () => {
    const original = await tempDir("pwr-orig-");
    const data = await tempDir("pwr-data-");
    const project = { id: "proj_live", source: folderSource(original, "rev") };
    expect(projectWorkingRoot(data, project as never)).toBe(original);
  });

  it("stays on the live folder when job results from an older version sit ahead in the review workspace", async () => {
    const original = await tempDir("pwr-ahead-orig-");
    const data = await tempDir("pwr-ahead-data-");
    const project = {
      id: "proj_ahead",
      source: folderSource(original, "base"),
      integration: {
        headRevision: "job-head",
        expectedBase: "job-head",
        appliedPatchSha256: [],
      },
    };
    expect(projectWorkingRoot(data, project as never)).toBe(original);
  });
});
