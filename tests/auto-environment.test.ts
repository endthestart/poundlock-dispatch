import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { environmentChanges, environmentManifest } from "@core/auto/environment";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

async function prepared() {
  const root = await tempDir("auto-environment-");
  await mkdir(join(root, ".venv/bin"), { recursive: true });
  await mkdir(join(root, ".venv/lib/__pycache__"), { recursive: true });
  await mkdir(join(root, "node_modules/vitest"), { recursive: true });
  await writeFile(join(root, ".venv/bin/pytest"), "#!/usr/bin/env python3\nrun_tests()\n");
  await writeFile(join(root, "node_modules/vitest/index.js"), "export {}\n");
  return root;
}

describe("the prepared environment a case may not change (L32)", () => {
  it("catches an edited test runner even when its modification time is restored", async () => {
    const root = await prepared();
    const runner = join(root, ".venv/bin/pytest");
    const before = await environmentManifest(root, [".venv", "node_modules"]);
    const { atime, mtime } = await stat(runner);
    await new Promise((done) => setTimeout(done, 20));
    await writeFile(runner, "#!/usr/bin/env python3\nraise SystemExit(0)\n");
    await utimes(runner, atime, mtime);
    const after = await environmentManifest(root, [".venv", "node_modules"]);
    expect(environmentChanges(before, after)).toEqual([".venv/bin/pytest"]);
  });

  it("catches added and removed files", async () => {
    const root = await prepared();
    const before = await environmentManifest(root, [".venv", "node_modules"]);
    await writeFile(join(root, ".venv/bin/conftest.py"), "x = 1\n");
    await rm(join(root, "node_modules/vitest/index.js"));
    const after = await environmentManifest(root, [".venv", "node_modules"]);
    expect(environmentChanges(before, after)).toEqual([
      ".venv/bin/conftest.py",
      "node_modules/vitest/index.js",
    ]);
  });

  it("catches planted bytecode but ignores the state test tools keep there", async () => {
    const root = await prepared();
    const before = await environmentManifest(root, [".venv", "node_modules"]);
    // Cases write bytecode under /tmp (PYTHONPYCACHEPREFIX), so a .pyc here was planted.
    await writeFile(join(root, ".venv/lib/__pycache__/x.cpython-314.pyc"), "bytecode");
    await mkdir(join(root, "node_modules/.vite/vitest"), { recursive: true });
    await writeFile(join(root, "node_modules/.vite/vitest/results.json"), "{}");
    await mkdir(join(root, "node_modules/.vite-temp"), { recursive: true });
    await writeFile(join(root, "node_modules/.vite-temp/vite.config.ts.timestamp-1.mjs"), "x");
    await writeFile(join(root, "node_modules/.package-lock.json"), "{}");
    const after = await environmentManifest(root, [".venv", "node_modules"]);
    expect(environmentChanges(before, after)).toEqual([".venv/lib/__pycache__/x.cpython-314.pyc"]);
  });

  it("ignores tool state a record saved before it counted as such still lists", async () => {
    const root = await prepared();
    const before = {
      ...(await environmentManifest(root, ["node_modules"])),
      "node_modules/.package-lock.json": "file:1:1:1:1:1",
    };
    await writeFile(join(root, "node_modules/.package-lock.json"), "{}");
    const after = await environmentManifest(root, ["node_modules"]);
    expect(environmentChanges(before, after)).toEqual([]);
  });

  it("ignores data a tool keeps in the environment, such as a browser's locales", async () => {
    const root = await prepared();
    const before = await environmentManifest(root, ["node_modules"]);
    const locales = join(root, "node_modules/playwright-core/.local-browsers/chromium/locales");
    await mkdir(locales, { recursive: true });
    await writeFile(join(locales, "en-US.pak"), "strings");
    const after = await environmentManifest(root, ["node_modules"]);
    expect(environmentChanges(before, after)).toEqual([]);
    await writeFile(join(root, "node_modules/vitest/index.js"), "export const pass = true;\n");
    const edited = await environmentManifest(root, ["node_modules"]);
    expect(environmentChanges(before, edited)).toEqual(["node_modules/vitest/index.js"]);
  });
});
