/**
 * Read-only Git inspection: what a reviewing worker may run, and proof on a
 * real repository that it reads history without running the repository's
 * helpers, writing to `.git`, or showing a committed secret.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type GitInspectContext,
  gitInspect,
  gitInspectArguments,
  page,
  validRevision,
} from "@runtime/git-inspect";
import { qualifyMacosSandbox } from "@runtime/sandbox";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const ROOT = "/work/project";
const ctx: GitInspectContext = {
  projectRoot: ROOT,
  excludedPatterns: [],
  tmp: "/tmp/x",
  deniedRead: [],
};

describe("revisions and paths", () => {
  it("accepts revisions and ranges, never an option or shell text", () => {
    for (const ok of [
      "12f986af",
      "debb5142..12f986af",
      "main...feature",
      "HEAD~2",
      "v1.0",
      "HEAD^{commit}",
    ])
      expect(validRevision(ok), ok).toBe(true);
    for (const bad of [
      "--output=/tmp/x",
      "-p",
      "a..b..c",
      "a;rm",
      "$(id)",
      "a b",
      "",
      "..",
      "`x`",
      "a:b",
    ])
      expect(validRevision(bad), bad).toBe(false);
  });

  it("refuses paths outside the project, secrets and options", () => {
    for (const bad of [
      "../x",
      "/etc/passwd",
      ".env",
      "config/.env",
      "secrets/key",
      "-x",
      "a\nb",
      ".git/config",
    ])
      expect(() => gitInspectArguments({ command: "diff", paths: [bad] }, ctx), bad).toThrow();
    expect(() =>
      gitInspectArguments(
        { command: "diff", paths: ["dist/app.js"] },
        { ...ctx, excludedPatterns: ["dist/"] },
      ),
    ).toThrow(/excluded/);
  });

  it("puts revisions after --end-of-options and paths after --", () => {
    const args = gitInspectArguments(
      { command: "diff", revisions: ["a..b"], paths: ["src/x.py"] },
      ctx,
    );
    expect(args.indexOf("--end-of-options")).toBeLessThan(args.indexOf("a..b"));
    expect(args.indexOf("--")).toBeLessThan(args.indexOf("src/x.py"));
    expect(args).toContain("--no-ext-diff");
    expect(args).toContain("--no-textconv");
    expect(() =>
      gitInspectArguments({ command: "file", revisions: [], paths: ["a"] }, ctx),
    ).toThrow();
    expect(() => gitInspectArguments({ command: "status", revisions: ["HEAD"] }, ctx)).toThrow();
  });

  it("switches off every filter driver the repository names", () => {
    const args = gitInspectArguments({ command: "status" }, ctx, ["evil"]);
    expect(args).toContain("filter.evil.clean=");
    expect(args).toContain("filter.evil.process=");
  });
});

describe("paging", () => {
  it("returns a page and says where the next starts", () => {
    const long = Array.from({ length: 5_000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const first = page(long);
    expect(first).toMatch(/\[lines 1–\d+ of 5000\. Next page: offset (\d+)/);
    const next = Number(/offset (\d+)/.exec(first)?.[1]);
    expect(page(long, next).startsWith(`line ${next} `)).toBe(true);
    expect(page("short\n")).toBe("short");
  });
});

async function snapshot(dir: string): Promise<string> {
  const entries: string[] = [];
  async function walk(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full);
      else entries.push(`${full}:${(await stat(full)).mtimeMs}:${(await stat(full)).size}`);
    }
  }
  await walk(dir);
  return entries.sort().join("\n");
}

const sandboxed = process.platform === "darwin" && (await qualifyMacosSandbox()).available;

describe.skipIf(!sandboxed)("on a real repository, inside the sandbox", () => {
  it("reads history and diffs, runs no repository helper, and changes nothing", async () => {
    const base = await realpath(await tempDir("git-inspect-"));
    const repo = join(base, "repo");
    const tmp = join(base, "tmp");
    // Inside the sandbox's writable scratch, so a helper that ran would leave its mark.
    const markers = join(base, "tmp", "markers");
    await mkdir(repo);
    await mkdir(markers, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      }).toString();
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    await writeFile(join(repo, "app.py"), "def total(a, b):\n    return a + b\n");
    await writeFile(join(repo, ".env"), "TOKEN=hunter2-committed\n");
    git("add", "-A");
    git("commit", "-qm", "First");
    await writeFile(join(repo, "app.py"), "def total(a, b):\n    return a - b\n");
    await writeFile(join(repo, ".env"), "TOKEN=hunter2-changed\n");
    git("commit", "-qam", "Second");
    const first = git("rev-parse", "--short", "HEAD~1").trim();
    const second = git("rev-parse", "--short", "HEAD").trim();
    // Every helper a repository can name, each leaving a marker if it runs.
    await writeFile(join(repo, ".gitattributes"), "*.py filter=evil diff=evil\n");
    for (const [key, name] of [
      ["core.fsmonitor", "fsmonitor"],
      ["filter.evil.clean", "clean"],
      ["filter.evil.smudge", "smudge"],
      ["diff.external", "external"],
      ["diff.evil.command", "diffcommand"],
      ["diff.evil.textconv", "textconv"],
      ["core.pager", "pager"],
    ])
      git("config", key, `touch ${join(markers, name)}; cat`);
    await writeFile(join(repo, "app.py"), "def total(a, b):\n    return a * b\n");
    const before = await snapshot(join(repo, ".git"));

    const context: GitInspectContext = {
      projectRoot: repo,
      excludedPatterns: [],
      tmp,
      deniedRead: [join(repo, ".git"), join(repo, ".env")],
    };
    const log = await gitInspect({ command: "log", revisions: [`${first}..${second}`] }, context);
    expect(log).toContain("Second");
    const diff = await gitInspect({ command: "diff", revisions: [`${first}..${second}`] }, context);
    expect(diff).toContain("-    return a + b");
    expect(diff).toContain("+    return a - b");
    expect(diff).not.toContain("hunter2");
    const stat = await gitInspect(
      { command: "diff", revisions: [`${first}..${second}`], stat: true },
      context,
    );
    expect(stat).toContain("app.py");
    const show = await gitInspect({ command: "show", revisions: [second] }, context);
    expect(show).toContain("Second");
    expect(show).not.toContain("hunter2");
    expect(
      await gitInspect({ command: "file", revisions: [first], paths: ["app.py"] }, context),
    ).toContain("a + b");
    expect(await gitInspect({ command: "status" }, context)).toContain("app.py");
    expect(await gitInspect({ command: "diff" }, context)).toContain("a * b");
    await expect(
      gitInspect({ command: "file", revisions: [first], paths: [".env"] }, context),
    ).rejects.toThrow(/excluded/);
    const missing = await gitInspect({ command: "log", revisions: ["nosuchref"] }, context);
    expect(missing).toMatch(/failed \(exit \d+\)[\s\S]*Report this error as it is/);

    expect(await readdir(markers)).toEqual([]);
    expect(await snapshot(join(repo, ".git"))).toBe(before);
    expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
  });
});

describe("without a sandbox", () => {
  it("asks before running git where no sandbox can contain it", async () => {
    const asked: string[] = [];
    const result = await gitInspect(
      { command: "status" },
      {
        ...ctx,
        qualifySandbox: async () => ({ available: false, runtime: "none", reason: "none here" }),
        authorizeUncontained: async (display) => {
          asked.push(display);
          return "deny";
        },
        exec: async () => {
          throw new Error("must not run");
        },
      },
    );
    expect(asked).toEqual([expect.stringMatching(/^git status --short/)]);
    expect(result).toMatch(/was not run/);
  });
});
