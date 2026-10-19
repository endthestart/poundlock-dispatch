import { mkdir, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const { assertOutputClosed } = createRequire(import.meta.url)("../scripts/before-pack.cjs");
it("refuses to overwrite a running bundle, including a symlinked output, but allows a separate build", async () => {
  const root = await tempDir("dispatch-package-");
  const output = join(root, "release"),
    alias = join(root, "alias");
  await mkdir(output);
  await symlink(output, alias);
  const commands = join(output, "Poundlock Dispatch.app/Contents/MacOS/Poundlock Dispatch");
  expect(() => assertOutputClosed(output, commands)).toThrow("Quit");
  expect(() => assertOutputClosed(alias, commands)).toThrow("Quit");
  expect(() => assertOutputClosed(join(root, "fresh-release"), commands)).not.toThrow();
});
