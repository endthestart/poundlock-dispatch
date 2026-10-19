import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostToolchainEnvironment,
  preparedWorkerTempDirectory,
  workerTempDirectory,
} from "@core/host-tools";
import { workerEnvironment } from "@runtime/run-command";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

it("points rustup at the owner's toolchains, since workers run with a private HOME", async () => {
  const home = await tempDir("toolchain-home-");
  expect(hostToolchainEnvironment(home, {})).toEqual({});
  await mkdir(join(home, ".rustup"));
  expect(hostToolchainEnvironment(home, {})).toEqual({ RUSTUP_HOME: join(home, ".rustup") });
  // An explicit RUSTUP_HOME wins.
  const custom = await tempDir("toolchain-custom-");
  expect(hostToolchainEnvironment(home, { RUSTUP_HOME: custom })).toEqual({ RUSTUP_HOME: custom });
});

it("keeps the worker's own HOME for caches while naming the toolchain home", async () => {
  const privateHome = await tempDir("worker-home-");
  const env = workerEnvironment(privateHome);
  expect(env.HOME).toBe(privateHome);
  if (env.RUSTUP_HOME) expect(env.RUSTUP_HOME.startsWith(privateHome)).toBe(false);
});

it("gives workers a temp folder named the way a terminal names it", async () => {
  const privateHome = await tempDir("worker-home-");
  const env = workerEnvironment(privateHome);
  const temp = workerTempDirectory(privateHome);
  expect(env.TMPDIR).toBe(temp);
  expect(temp.startsWith(tmpdir())).toBe(true);
  expect(workerTempDirectory(privateHome)).toBe(temp);
  expect(workerTempDirectory(`${privateHome}-other`)).not.toBe(temp);
  const real = await preparedWorkerTempDirectory(privateHome);
  expect(real).toBe(await realpath(temp));
});
