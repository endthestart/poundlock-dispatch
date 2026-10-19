import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { lockedPiResources } from "@runtime/pi-resources";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

it("does not discover SYSTEM or APPEND_SYSTEM, including outside symlink targets", async () => {
  const base = await tempDir("dispatch-pi-resources-");
  try {
    const cwd = join(base, "project"),
      agentDir = join(base, "agent");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir);
    const target = join(base, "outside.txt");
    await writeFile(target, "SYNTHETIC_OUTSIDE_CANARY");
    for (const dir of [join(cwd, ".pi"), agentDir]) {
      for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"]) await symlink(target, join(dir, name));
    }
    const loader = new DefaultResourceLoader({
      ...lockedPiResources,
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
      systemPromptOverride: () => "Host-owned prompt",
    });
    await loader.reload();
    expect(loader.getSystemPrompt()).toBe("Host-owned prompt");
    expect(loader.getAppendSystemPrompt()).toEqual([]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
