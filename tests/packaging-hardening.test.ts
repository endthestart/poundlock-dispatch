/**
 * L26: the packaged app's fuses, the renderer's web permissions, and the Git
 * askpass helper, which is never looked for in the current folder.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { cloneGitRef } from "@core/workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { denyPermissionRequests } from "../src/main/permissions";
import { tempDir } from "./support/temp-dir";

describe("packaged app fuses", () => {
  it("turns off run-as-node, NODE_OPTIONS and the inspector", async () => {
    const config = await readFile("electron-builder.yml", "utf8");
    const fuses = config.slice(config.indexOf("electronFuses:"));
    for (const line of [
      "runAsNode: false",
      "enableNodeOptionsEnvironmentVariable: false",
      "enableNodeCliInspectArguments: false",
    ])
      expect(fuses).toContain(`  ${line}`);
  });
});

describe("renderer permissions", () => {
  it("refuses every request, check and device", () => {
    const handlers: Record<string, (...args: never[]) => unknown> = {};
    denyPermissionRequests({
      setPermissionRequestHandler: (handler) => {
        handlers.request = handler as never;
      },
      setPermissionCheckHandler: (handler) => {
        handlers.check = handler as never;
      },
      setDevicePermissionHandler: (handler) => {
        handlers.device = handler as never;
      },
    });
    const answers: boolean[] = [];
    for (const permission of ["media", "notifications", "clipboard-read", "geolocation"])
      (handlers.request as unknown as (c: unknown, p: string, cb: (ok: boolean) => void) => void)(
        {},
        permission,
        (ok) => answers.push(ok),
      );
    expect(answers).toEqual([false, false, false, false]);
    expect((handlers.check as unknown as () => boolean)()).toBe(false);
    expect((handlers.device as unknown as () => boolean)()).toBe(false);
  });
});

describe("Git askpass helper", () => {
  const home = process.env.HOME;
  afterEach(() => {
    process.env.HOME = home;
    vi.restoreAllMocks();
  });

  it("answers from a private helper, never a script in the current folder", async () => {
    const root = await tempDir("dispatch-askpass-");
    // A folder someone else wrote, open in the terminal where Dispatch started.
    const hostile = join(root, "cwd");
    await mkdir(join(hostile, "scripts"), { recursive: true });
    const marker = join(root, "hostile-ran");
    await writeFile(
      join(hostile, "scripts", "git-askpass.sh"),
      `#!/bin/sh\necho "$POUNDLOCK_DISPATCH_GIT_PASSWORD" > "${marker}"\n`,
    );
    await chmod(join(hostile, "scripts", "git-askpass.sh"), 0o755);
    vi.spyOn(process, "cwd").mockReturnValue(hostile);
    // No global Git configuration or credential helper of this machine's.
    process.env.HOME = join(root, "home");
    await mkdir(process.env.HOME);
    const saved = process.env.POUNDLOCK_DISPATCH_GIT_ASKPASS;
    delete process.env.POUNDLOCK_DISPATCH_GIT_ASKPASS;
    const seen: string[] = [];
    const server = createServer((request, response) => {
      seen.push(request.headers.authorization ?? "");
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
      response.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(
        cloneGitRef(join(root, "work", "clone"), `http://127.0.0.1:${port}/repo.git`, "main", {
          username: "reader",
          token: "synthetic-token",
        }),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      if (saved !== undefined) process.env.POUNDLOCK_DISPATCH_GIT_ASKPASS = saved;
    }
    expect(existsSync(marker)).toBe(false);
    expect(seen).toContain(`Basic ${Buffer.from("reader:synthetic-token").toString("base64")}`);
  });
});
