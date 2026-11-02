/**
 * `dispatch completion <shell>`: each script completes the subcommands the
 * parsers take, and none of them names a command the parsers would refuse.
 */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAutoArgs } from "@tui/auto-args";
import { AUTOPILOT_COMMANDS, completionScript, JOBS_COMMANDS } from "@tui/completion";
import { main } from "@tui/index";
import { parseJobsArgs } from "@tui/jobs-args";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./support/temp-dir";

describe("dispatch completion", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("prints the script, and exits 2 with the usage for a shell it does not know", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await main(["completion", "fish"]);
    expect(String(out.mock.calls[0]?.[0])).toContain("complete -c dispatch");
    await main(["completion", "tcsh"]);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/^Usage: dispatch completion/);
    expect(process.exitCode).toBe(2);
  });

  it("names only commands the parsers take", () => {
    // A known command may still want arguments; only "Unknown" means a name the parser lacks.
    const refusal = (parse: () => unknown) => {
      try {
        parse();
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };
    for (const command of AUTOPILOT_COMMANDS)
      expect(
        refusal(() => parseAutoArgs([command])),
        command,
      ).not.toMatch(/Unknown/);
    for (const command of JOBS_COMMANDS)
      expect(
        refusal(() => parseJobsArgs([command])),
        command,
      ).not.toMatch(/Unknown/);
    expect(refusal(() => parseAutoArgs(["frobnicate"]))).toMatch(/Unknown/);
    expect(refusal(() => parseJobsArgs(["frobnicate"]))).toMatch(/Unknown/);
  });

  it("writes a script for fish, zsh and bash, and refuses another shell", () => {
    for (const shell of ["fish", "zsh", "bash"]) {
      const script = completionScript(shell);
      for (const command of [...AUTOPILOT_COMMANDS, ...JOBS_COMMANDS])
        expect(script, `${shell} ${command}`).toContain(command);
    }
    expect(completionScript("zsh")).toContain("bashcompinit");
    expect(() => completionScript("tcsh")).toThrow(/^Usage: dispatch completion/);
    expect(() => completionScript(undefined)).toThrow(/^Usage: dispatch completion/);
  });

  it("completes autopilot's commands in bash", async () => {
    const file = join(await tempDir("tui-completion-"), "dispatch.bash");
    await writeFile(file, completionScript("bash"));
    const words = execFileSync(
      "bash",
      [
        "-c",
        `source ${file}; COMP_WORDS=(dispatch autopilot st); COMP_CWORD=2; _dispatch; echo "\${COMPREPLY[*]}"`,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(words.split(" ").sort()).toEqual(["start", "status", "stop"]);
  });
});
