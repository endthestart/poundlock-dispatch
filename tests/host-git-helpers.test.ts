/**
 * L22: Dispatch's host Git never runs a helper program named in a
 * repository's own configuration, such as one unpacked from an archive.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "@core/git";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

/** A repository whose configuration names a program for every helper Git can run. */
async function hostileRepository() {
  const repo = await tempDir("dispatch-l22-");
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "data.txt"), "one\n");
  await writeFile(join(repo, "notes.md"), "one\n");
  await writeFile(
    join(repo, ".gitattributes"),
    "*.txt filter=evil diff=evil\n*.md filter=sneaky\n",
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const marker = (name: string) => join(repo, `${name}.ran`);
  const script = join(repo, "helper.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${repo}/$1.ran"\ncat\n`);
  await chmod(script, 0o755);
  const included = join(repo, "included.config");
  await writeFile(included, `[filter "sneaky"]\n\tclean = ${script} sneaky\n`);
  for (const [key, value] of [
    ["core.fsmonitor", `${script} fsmonitor`],
    ["core.pager", `${script} pager`],
    ["diff.external", `${script} external`],
    ["diff.evil.command", `${script} driver`],
    ["diff.evil.textconv", `${script} textconv`],
    ["filter.evil.clean", `${script} clean`],
    ["filter.evil.process", `${script} process`],
    ["include.path", included],
  ])
    git(repo, "config", key, value);
  // Touch the file so status has to look at its content again.
  await writeFile(join(repo, "data.txt"), "two\n");
  await writeFile(join(repo, "notes.md"), "two\n");
  return { repo, marker };
}

describe("host Git in a hostile repository", () => {
  it("runs status and diff without any helper the repository names", async () => {
    const { repo, marker } = await hostileRepository();
    const status = await runGit(repo, ["status", "--porcelain"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("data.txt");
    const diff = await runGit(repo, ["diff"]);
    expect(diff.code).toBe(0);
    await runGit(repo, ["add", "-A"]);
    for (const name of [
      "fsmonitor",
      "pager",
      "external",
      "driver",
      "textconv",
      "clean",
      "process",
      "sneaky",
    ])
      expect(existsSync(marker(name)), name).toBe(false);
  });
});
