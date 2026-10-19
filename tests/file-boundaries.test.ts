import { mkdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeReadFile } from "@core/file-access";
import type { WorkerContext } from "@core/interactive-worker";
import { compileArgv } from "@runtime/argv";
import { resolveToolPath } from "@runtime/path-policy";
import { buildSandboxRequest } from "@runtime/sandbox-policy";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

describe("canonical project read boundaries", () => {
  it("does not authorize a literal glob filename then expand it into secret reads", async () => {
    const root = await realpath(await tempDir("dispatch-glob-"));
    await writeFile(join(root, "*.json"), "ordinary literal filename");
    await writeFile(join(root, "auth.json"), "synthetic secret");
    expect(() => compileArgv("cat *.json")).toThrow(/Unsupported shell syntax/);
    expect(() => compileArgv("cat ?.json")).toThrow(/Unsupported shell syntax/);
    expect(() => compileArgv("cat ~/auth.json")).toThrow(/Unsupported shell syntax/);
    const project = {
      id: "project",
      name: "fixture",
      planRevision: 1,
      policy: { readGrants: [], verification: { protectedPaths: [] } },
      source: { kind: "local_folder", excludedPatterns: [] },
    } as never;
    await expect(
      resolveToolPath({ projectRoot: root, cwd: root, project, writing: false }, "auth.json"),
    ).rejects.toThrow("excluded");
    const sandbox = await buildSandboxRequest({
      projectRoot: root,
      project,
      privateHome: join(root, "home"),
      network: "deny",
    });
    expect(sandbox.deniedRead).toContain(join(root, "auth.json"));
    expect(sandbox.deniedRead).toContain(join(root, ".env"));
    expect(sandbox.deniedRead).toContain(join(root, ".git"));
  });

  it("rejects traversal, absolute and prefix-sibling reads for manager, worker and cat", async () => {
    const base = await realpath(await tempDir("dispatch-boundary-"));
    const root = join(base, "project"),
      sibling = join(base, "project-extra");
    await mkdir(root);
    await mkdir(sibling);
    const outside = join(base, "outside.txt"),
      prefixed = join(sibling, "file.txt");
    await writeFile(outside, "outside");
    await writeFile(prefixed, "sibling");
    const ctx = {
      cwd: root,
      trust: "assist",
      project: {
        policy: { readGrants: [] },
        source: { kind: "local_folder", excludedPatterns: [] },
      },
    } as unknown as WorkerContext;
    // `safeReadFile` is the manager's read path; the worker's own path is
    // asserted against `evaluateWorkerToolCall` in approval-workflow.test.ts.
    // Both used to be checked here through `approvedPath`, a third copy of
    // these rules that production no longer called and that had gone stale.
    for (const path of ["../outside.txt", outside, prefixed]) {
      await expect(safeReadFile(root, path)).rejects.toThrow("outside");
    }
    expect(await safeReadFile(root, outside, [outside])).toBe("outside");
    await expect(safeReadFile(root, outside, [])).rejects.toThrow("outside");
  });

  it("requires exact target grants for excluded files and redirected symlinks", async () => {
    const base = await realpath(await tempDir("dispatch-grants-"));
    const root = join(base, "project");
    await mkdir(root);
    const outside = join(base, "outside.txt"),
      other = join(base, "other.txt"),
      link = join(root, "link.txt"),
      secret = join(root, ".env");
    await writeFile(outside, "allowed");
    await writeFile(other, "not allowed");
    await writeFile(secret, "fixture secret");
    await symlink(outside, link);
    await expect(safeReadFile(root, link)).rejects.toThrow("outside");
    await expect(safeReadFile(root, link, [link])).rejects.toThrow("outside");
    expect(await safeReadFile(root, link, [outside])).toBe("allowed");
    await unlink(link);
    await symlink(other, link);
    await expect(safeReadFile(root, link, [outside])).rejects.toThrow("outside");
    await expect(safeReadFile(root, secret)).rejects.toThrow("excluded");
    await expect(safeReadFile(root, secret, [root])).rejects.toThrow("excluded");
    expect(await safeReadFile(root, secret, [secret])).toBe("fixture secret");
    await expect(safeReadFile(root, secret, [])).rejects.toThrow("excluded");
  });
});
