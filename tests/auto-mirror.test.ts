/**
 * L30: the mirror the run's container can read holds only the current branch's
 * history, never the source's stashes, other branches or rewritten-away
 * secrets. A mirror made by a local clone is pruned the same way.
 */
import { execFileSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureMirror } from "@core/auto/checkpoint-git";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();

const has = (mirror: string, object: string) => {
  try {
    git(mirror, "--git-dir", mirror, "cat-file", "-e", object);
    return true;
  } catch {
    return false;
  }
};

/** A source with a secret in a dropped stash, on another branch, and rewritten out of history. */
async function source() {
  const dir = await realpath(await tempDir("auto-l30-src-"));
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "app.txt"), "app\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const blob = (text: string) =>
    execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: text })
      .toString()
      .trim();
  // Rewritten away: committed, then amended out.
  await writeFile(join(dir, "key.txt"), "rewritten-secret\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "oops");
  git(dir, "reset", "-q", "--hard", "HEAD~1");
  // A stash, then dropped.
  await writeFile(join(dir, "app.txt"), "stashed-secret\n");
  git(dir, "stash", "-q");
  git(dir, "stash", "drop", "-q");
  // Another branch.
  git(dir, "checkout", "-q", "-b", "private");
  await writeFile(join(dir, "branch.txt"), "branch-secret\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "private");
  git(dir, "checkout", "-q", "main");
  const secrets = ["rewritten-secret\n", "stashed-secret\n", "branch-secret\n"].map(blob);
  return { dir, base: git(dir, "rev-parse", "HEAD"), secrets };
}

describe("the auto-mode mirror", () => {
  it("holds the base commit and none of the source's other objects", async () => {
    const { dir, base, secrets } = await source();
    const mirror = join(await tempDir("auto-l30-m-"), "m.git");
    await ensureMirror(dir, mirror, base);
    expect(has(mirror, `${base}^{commit}`)).toBe(true);
    for (const secret of secrets) expect(has(mirror, secret)).toBe(false);
    expect(git(mirror, "--git-dir", mirror, "for-each-ref", "--format=%(refname)")).toBe(
      "refs/heads/main",
    );
  });

  it("prunes a mirror an older Dispatch made with a local clone, keeping run branches", async () => {
    const { dir, base, secrets } = await source();
    const mirror = join(await tempDir("auto-l30-old-"), "m.git");
    git(dir, "clone", "-q", "--bare", "--local", "--no-hardlinks", dir, mirror);
    git(mirror, "--git-dir", mirror, "branch", "auto/r1", base);
    git(mirror, "--git-dir", mirror, "update-ref", "refs/auto/r1/drafts/C1-1", base);
    for (const secret of secrets) expect(has(mirror, secret)).toBe(true);
    await ensureMirror(dir, mirror, base);
    for (const secret of secrets) expect(has(mirror, secret)).toBe(false);
    expect(
      git(mirror, "--git-dir", mirror, "for-each-ref", "--format=%(refname)").split("\n").sort(),
    ).toEqual(["refs/auto/r1/drafts/C1-1", "refs/heads/auto/r1"]);
    expect(has(mirror, `${base}^{commit}`)).toBe(true);
    expect(await readFile(join(mirror, "description"), "utf8")).toContain("transferred");
  });
});
