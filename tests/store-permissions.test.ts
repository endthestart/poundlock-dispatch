/** L27: folders holding tokens are owner-only, even when they already existed. */
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { FileStore } from "@core/store";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

describe("the data and config folders", () => {
  it.skipIf(process.platform === "win32")("are made owner-only at start-up", async () => {
    const base = await tempDir("dispatch-l27-");
    const data = join(base, "data");
    const config = join(base, "config");
    await mkdir(data, { mode: 0o755 });
    await mkdir(config, { mode: 0o755 });
    await new FileStore(data, config).init();
    expect((await stat(data)).mode & 0o777).toBe(0o700);
    expect((await stat(config)).mode & 0o777).toBe(0o700);
  });
});
