import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * The files that decide what a script runner runs (M7). A remembered approval
 * covers `npm test` as the user saw it, but once the worker edits the `test`
 * script, a Makefile or the pytest configuration, the same command text runs
 * something else. The approval text carries a fingerprint of these files, so
 * a remembered grant stops matching and Dispatch asks again. It does not cover
 * test files themselves, or a conftest.py below the working directory.
 */
const RUNNER_FILES: Record<string, string[]> = {
  npm: ["package.json"],
  npx: ["package.json"],
  pnpm: ["package.json"],
  yarn: ["package.json"],
  bun: ["package.json"],
  make: ["Makefile", "makefile", "GNUmakefile"],
  pytest: ["conftest.py", "pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"],
  tox: ["tox.ini", "pyproject.toml", "setup.cfg"],
};

const MAX_BYTES = 1 << 20;

function runnerOf(program: string, args: readonly string[]): string | undefined {
  const name = basename(program)
    .toLowerCase()
    .replace(/\.(exe|cmd)$/, "");
  if (RUNNER_FILES[name]) return name;
  // `python -m pytest` and `uv run pytest` run the same runner.
  const after = /^python(\d+(\.\d+)?)?$/.test(name) ? "-m" : name === "uv" ? "run" : undefined;
  const index = after ? args.indexOf(after) : -1;
  const inner = index >= 0 ? args[index + 1] : undefined;
  return inner ? runnerOf(inner, args.slice(index + 2)) : undefined;
}

/** A short fingerprint of those files in `cwd`, or `undefined` when the program is no script runner. */
export async function runnerInputs(
  program: string,
  args: readonly string[],
  cwd: string,
): Promise<string | undefined> {
  const runner = runnerOf(program, args);
  if (!runner) return undefined;
  const hash = createHash("sha256");
  for (const name of RUNNER_FILES[runner]) {
    const content = await readFile(join(cwd, name)).then(
      (bytes) => (bytes.length > MAX_BYTES ? Buffer.from(`size ${bytes.length}`) : bytes),
      () => Buffer.from("absent"),
    );
    hash.update(name).update("\0").update(content).update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
