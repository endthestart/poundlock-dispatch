import { projectFiles } from "@core/paths";
import { projectWorkingRoot } from "@core/workflow-support";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

function folderSource(path: string, extras: Record<string, string> = {}) {
  return {
    kind: "local_folder" as const,
    originalPath: path,
    capturedAt: new Date().toISOString(),
    snapshotSha256: extras.snapshotSha256 ?? "",
    baseRevision: extras.baseRevision ?? "",
    includedFiles: 0,
    includedBytes: 0,
    excludedPatterns: [],
    includedUncommitted: true,
    originalFingerprint: extras.originalFingerprint ?? "",
  };
}

describe("project working root", () => {
  it("uses the live folder for a local project even when a fingerprint is set", async () => {
    const original = await tempDir("pwr-orig-");
    const data = await tempDir("pwr-data-");
    const project = {
      id: "proj_live",
      source: folderSource(original, { originalFingerprint: "abc", baseRevision: "rev" }),
      integration: { headRevision: "rev", expectedBase: "rev", appliedPatchSha256: [] },
    };
    expect(projectWorkingRoot(data, project as never)).toBe(original);
  });

  it("stays on the live folder when job results from an older version sit ahead in the review workspace", async () => {
    const original = await tempDir("pwr-ahead-orig-");
    const data = await tempDir("pwr-ahead-data-");
    const project = {
      id: "proj_ahead",
      source: folderSource(original, { originalFingerprint: "abc", baseRevision: "base" }),
      integration: {
        headRevision: "job-head",
        expectedBase: "job-head",
        appliedPatchSha256: [],
      },
    };
    expect(projectWorkingRoot(data, project as never)).toBe(original);
  });

  it("keeps captured snapshot projects on the review workspace", async () => {
    const original = await tempDir("pwr-cap-orig-");
    const data = await tempDir("pwr-cap-data-");
    const project = {
      id: "proj_captured",
      source: folderSource(original, { snapshotSha256: "copied", originalFingerprint: "x" }),
      integration: { headRevision: "rev", expectedBase: "rev", appliedPatchSha256: [] },
    };
    expect(projectWorkingRoot(data, project as never)).toBe(
      projectFiles(data, project.id).workspace,
    );
  });
});
