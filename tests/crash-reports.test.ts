import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crashSummary, summarise } from "@runtime/crash-reports";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

function report(projectRoot: string): string {
  const header = JSON.stringify({ app_name: "swiftpm-testing-helper" });
  const body = {
    procName: "swiftpm-testing-helper",
    exception: {
      type: "EXC_BAD_ACCESS",
      signal: "SIGSEGV",
      subtype: "KERN_INVALID_ADDRESS at 0x1",
    },
    faultingThread: 1,
    threads: [
      { frames: [{ imageIndex: 0, symbol: "main" }] },
      {
        frames: [
          { imageIndex: 1, symbol: "walIndexTryHdr" },
          {
            imageIndex: 1,
            symbol: "closure #1 in AdjustmentPanel.requestPreview()",
            sourceFile: `${projectRoot}/Sources/App/AdjustmentPanel.swift`,
            sourceLine: 232,
          },
        ],
      },
    ],
    usedImages: [
      { name: "dyld", path: "/usr/lib/dyld" },
      {
        name: "AppTests",
        path: `${projectRoot}/.build/debug/AppTests.xctest/Contents/MacOS/AppTests`,
      },
    ],
  };
  return `${header}\n${JSON.stringify(body)}`;
}

it("summarises the crashing thread of a report that loads project code", () => {
  const summary = summarise(report("/work/app"), "/work/app");
  expect(summary).toMatch(
    /^EXC_BAD_ACCESS \(SIGSEGV, KERN_INVALID_ADDRESS at 0x1\) in swiftpm-testing-helper/,
  );
  expect(summary).toContain("  AppTests  walIndexTryHdr");
  expect(summary).toContain("AdjustmentPanel.requestPreview() (AdjustmentPanel.swift:232)");
  expect(summarise(report("/work/app"), "/work/other")).toBe("");
});

it("knows an anonymised image as the project's by a file of that name it built", () => {
  const anonymised = report("/work/app").replace(
    "/work/app/.build/debug/AppTests.xctest/Contents/MacOS/AppTests",
    "/Users/USER/*/AppTests",
  );
  expect(summarise(anonymised, "/work/app", (name) => name === "AppTests")).toContain(
    "walIndexTryHdr",
  );
  expect(summarise(anonymised, "/work/app", () => false)).toBe("");
});

it("reads only reports written during the command, and only after a crash", async () => {
  const dir = await tempDir("crash-reports-");
  const old = join(dir, "old.ips");
  await writeFile(old, report("/work/app"));
  await utimes(old, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
  const since = Date.now();
  const crashed = "error: Exited with unexpected signal code 11";
  expect(
    await crashSummary({ output: crashed, projectRoot: "/work/app", since, dir, waitMs: 0 }),
  ).toBe("");
  await writeFile(join(dir, "new.ips"), report("/work/app"));
  expect(
    await crashSummary({ output: crashed, projectRoot: "/work/app", since, dir, waitMs: 0 }),
  ).toMatch(/^Crash report new\.ips:\nEXC_BAD_ACCESS/);
  expect(
    await crashSummary({
      output: "1 test failed",
      projectRoot: "/work/app",
      since,
      dir,
      waitMs: 0,
    }),
  ).toBe("");
});
