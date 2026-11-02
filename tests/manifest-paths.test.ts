/**
 * A dependency a fresh checkout would not have. An offline worker pointed Cargo at
 * crates in the run's own cache (`.cargo-home`, ignored by Git), so the product
 * built in the run and nowhere else.
 */

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { failureReason } from "@core/auto/engine";
import { unshippedDependencies } from "@core/auto/manifest-paths";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

async function project() {
  const root = await tempDir("manifest-paths-");
  execFileSync("git", ["init", "-q", root]);
  await writeFile(join(root, ".gitignore"), "/target\n/.cargo-home\n");
  await mkdir(join(root, "crates/util"), { recursive: true });
  await mkdir(join(root, "web"), { recursive: true });
  await writeFile(
    join(root, "Cargo.toml"),
    [
      "[dependencies]",
      'serde = "1"',
      'util = { path = "crates/util" }',
      'tempfile = { path = ".cargo-home/registry/src/index.crates.io-1/tempfile-3.27.0" }',
    ].join("\n"),
  );
  await writeFile(
    join(root, "web/package.json"),
    JSON.stringify({
      dependencies: { shared: "file:../crates/util", left: "file:../../elsewhere" },
    }),
  );
  const isIgnored = async (path: string) => {
    try {
      execFileSync("git", ["-C", root, "check-ignore", "-q", "--", path]);
      return true;
    } catch {
      return false;
    }
  };
  return { root, isIgnored };
}

it("names a changed manifest's dependencies on ignored paths or paths outside the project", async () => {
  const { root, isIgnored } = await project();
  const found = await unshippedDependencies(
    root,
    ["Cargo.toml", "web/package.json", "src/main.rs"],
    isIgnored,
  );
  expect(found).toEqual([
    "Cargo.toml: .cargo-home/registry/src/index.crates.io-1/tempfile-3.27.0 (depends on a path outside what Git keeps)",
    "web/package.json: ../../elsewhere (depends on a path outside what Git keeps)",
  ]);
  expect(await unshippedDependencies(root, ["src/main.rs"], isIgnored)).toEqual([]);
});

it("tells the worker to depend on the package by version, not to undo an out-of-scope change", async () => {
  const { root, isIgnored } = await project();
  const violations = await unshippedDependencies(root, ["Cargo.toml"], isIgnored);
  const { details } = failureReason(
    { finish: "done", summary: "" },
    { passed: true, commands: [] },
    violations,
    false,
  );
  expect(details).toContain(
    "Cargo.toml: .cargo-home/registry/src/index.crates.io-1/tempfile-3.27.0",
  );
  expect(details).toContain("by name and version");
  expect(details).not.toContain("outside what the case may change");
});
