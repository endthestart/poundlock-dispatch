/**
 * A worker's TMPDIR is reached the way a terminal reaches it, and its sandbox
 * can use it, read-only investigations included.
 */
import { spawnSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { workerEnvironment } from "@runtime/run-command";
import { qualifyMacosSandbox, wrapWithSandbox } from "@runtime/sandbox";
import { buildSandboxRequest } from "@runtime/sandbox-policy";
import { defaultBudget, defaultPolicy, type ProjectRecord } from "@shared/types";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const project = (root: string) =>
  ({
    id: "project",
    source: { kind: "local_folder", originalPath: root, excludedPatterns: [] },
    policy: defaultPolicy(),
    budget: defaultBudget(),
  }) as unknown as ProjectRecord;

it.runIf(process.platform === "darwin")(
  "lets sandboxed commands use a TMPDIR whose path goes through a link",
  async () => {
    const qualification = await qualifyMacosSandbox();
    if (!qualification.available) return;
    const root = await tempDir("worker-temp-");
    const privateHome = join(root, "..", `${root.split("/").pop()}-home`);
    const env = workerEnvironment(privateHome);
    const built = await buildSandboxRequest({
      projectRoot: root,
      project: project(root),
      privateHome,
      network: "deny",
    });
    for (const request of [built, { ...built, writable: [] }]) {
      const wrapped = await wrapWithSandbox(
        ["/bin/sh", "-c", 'echo ok > "$TMPDIR/probe" && cat "$TMPDIR/probe"'],
        request,
        qualification,
      );
      const run = spawnSync(wrapped.program, wrapped.arguments, {
        cwd: root,
        env,
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe("ok");
    }
    // As in a terminal on macOS, the path names /var, a link to /private/var.
    expect(await realpath(env.TMPDIR ?? "")).toBe(built.temp);
  },
);
