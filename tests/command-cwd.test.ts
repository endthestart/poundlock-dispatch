/**
 * Worker commands as they were meant. Each spelling of the same command was a
 * new exact approval, and a repeated program name failed outright.
 */

import { tmpdir } from "node:os";
import { normalizedArguments, withoutRedundantCd } from "@runtime/command-cwd";
import { resolveCommand } from "@runtime/run-command";
import { describe, expect, it } from "vitest";

const CWD = "/work/recipe-box";

describe("withoutRedundantCd", () => {
  it("drops a leading cd into the working directory", () => {
    expect(withoutRedundantCd(`cd ${CWD} && git diff a..b -- x.py`, CWD)).toBe(
      "git diff a..b -- x.py",
    );
    expect(withoutRedundantCd(`cd '${CWD}/'; git status`, CWD)).toBe("git status");
    expect(withoutRedundantCd(`cd . && cd "${CWD}" && ls`, CWD)).toBe("ls");
  });

  it("drops git -C for the working directory anywhere in the command", () => {
    expect(
      withoutRedundantCd(`git -C ${CWD} log --oneline; echo ---; git -C ${CWD} diff --stat`, CWD),
    ).toBe("git log --oneline; echo ---; git diff --stat");
  });

  it("keeps anything that goes somewhere else or needs the shell to expand", () => {
    for (const command of [
      "cd /elsewhere && git status",
      "cd ~/recipe-box && git status",
      "cd $PROJECT && git status",
      `cd ${CWD}`,
      "git -C ../other log",
      `git status && cd ${CWD} && ls`,
    ])
      expect(withoutRedundantCd(command, CWD)).toBe(command);
  });
});

describe("normalizedArguments", () => {
  it("drops a program name repeated as the first argument", () => {
    expect(normalizedArguments("git", ["git", "diff", "--stat"], CWD)).toEqual(["diff", "--stat"]);
    expect(normalizedArguments("/usr/bin/git", ["git", "log"], CWD)).toEqual(["log"]);
  });

  it("drops git -C for the working directory only", () => {
    expect(normalizedArguments("git", ["-C", CWD, "log"], CWD)).toEqual(["log"]);
    expect(normalizedArguments("git", ["git", "-C", ".", "log"], CWD)).toEqual(["log"]);
    expect(normalizedArguments("git", ["-C", "../other", "log"], CWD)).toEqual([
      "-C",
      "../other",
      "log",
    ]);
    expect(normalizedArguments("uv", ["-C", CWD], CWD)).toEqual(["-C", CWD]);
  });

  it("turns SwiftPM's own sandboxes off, which macOS refuses inside Dispatch's", () => {
    const off = ["--disable-sandbox", "-Xswiftc", "-disable-sandbox"];
    expect(normalizedArguments("swift", ["test"], CWD)).toEqual(["test", ...off]);
    expect(normalizedArguments("/usr/bin/swift", ["build", "-c", "release"], CWD)).toEqual([
      "build",
      ...off,
      "-c",
      "release",
    ]);
    expect(normalizedArguments("swift-build", [], CWD)).toEqual(off);
    expect(normalizedArguments("swift", ["package", "resolve"], CWD)).toEqual([
      "package",
      "--disable-sandbox",
      "resolve",
    ]);
    expect(normalizedArguments("swift", ["test", ...off], CWD)).toEqual(["test", ...off]);
    expect(normalizedArguments("swift", ["--version"], CWD)).toEqual(["--version"]);
    expect(normalizedArguments("swiftc", ["main.swift"], CWD)).toEqual(["main.swift"]);
  });
});

describe("run_command", () => {
  it("runs what the worker meant, and asks about that", async () => {
    const root = tmpdir();
    const resolved = await resolveCommand(
      {
        program: "git",
        arguments: ["git", "-C", root, "status"],
        capability: "inspect",
        effect: "inspect",
      },
      root,
      [],
      root,
    );
    expect(resolved.arguments).toEqual(["status"]);
    expect(resolved.requestedArguments).toEqual(["status"]);
  });
});
