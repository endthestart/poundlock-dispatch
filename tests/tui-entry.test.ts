/**
 * `dispatch --help`, `--version`, `jobs` and `autopilot` each load only what
 * they use. The entry once imported the whole terminal client up front, so
 * printing the usage took seconds of module loading.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

const LIGHT = [/^node:/, /^@shared\/types$/, /^@runtime\/system-ca$/];

it("imports nothing heavy before it knows which command it runs", async () => {
  const source = await readFile(join(__dirname, "../src/tui/index.ts"), "utf8");
  const eager = [...source.matchAll(/^import (?!type )[^;]*?from "([^"]+)";/gms)].map(
    (match) => match[1],
  );
  expect(eager.filter((specifier) => !LIGHT.some((light) => light.test(specifier)))).toEqual([]);
});

it("loads pi-coding-agent only when it is needed, never with the screen", async () => {
  // It takes over a second to load, and the screen needs it only to colour
  // code fences and copy a selection; the manager's runtime loads it for a turn.
  const dir = join(__dirname, "../src/tui");
  const eager: string[] = [];
  for (const file of await readdir(dir)) {
    const source = await readFile(join(dir, file), "utf8");
    if (/^import (?!type )[^;]*?from "@earendil-works\/pi-coding-agent";/ms.test(source))
      eager.push(file);
  }
  expect(eager).toEqual([]);
});
