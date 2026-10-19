import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tempDir } from "./temp-dir";

/** The fake Docker CLI, with its own state folder and the images it pretends to have. */
export async function fakeDocker(images: string[] = ["toolchain:test"]) {
  const state = await tempDir("fake-docker-");
  const env = { ...process.env, FAKE_DOCKER_STATE: state, FAKE_DOCKER_IMAGES: images.join(",") };
  return {
    docker: resolve("tests/support/fake-docker-cli.mjs"),
    state,
    env,
    /** Every call made, as its argument list, oldest first, including `--context <name>`. */
    async rawCalls(): Promise<string[][]> {
      const text = await readFile(join(state, "calls.jsonl"), "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
    },
    /** Every call made, oldest first, without the global `--context <name>`. */
    async calls(): Promise<string[][]> {
      return (await this.rawCalls()).map((call) =>
        call[0] === "--context" ? call.slice(2) : call,
      );
    },
  };
}
