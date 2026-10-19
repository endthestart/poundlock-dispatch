/**
 * How the app starts Autopilot's runner (ADR 016, L26): the packaged app keeps
 * Electron's run-as-Node fuse off, so the runner is the installed terminal
 * client, `dispatch auto run <runDir>`, detached so it outlives the app. It
 * must be this app's version: the run's files are read by both.
 */
import { execFile, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AutoPaths } from "@core/auto/runs";
import { autoBaseRoot } from "@core/data-root";
import type { AutopilotFacilities } from "@core/host/autopilot";
import { approvedHostToolDirectories } from "@core/host-tools";

const run = promisify(execFile);

export function autopilotFacilities(appVersion: string): AutopilotFacilities {
  const home = homedir();
  const cli = process.env.POUNDLOCK_DISPATCH_CLI || join(home, ".local", "bin", "dispatch");
  // A Finder-launched app has a bare PATH; the runner needs docker and git.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: approvedHostToolDirectories(home).join(":"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const install =
    "Install the terminal client from this version's source with scripts/install-tui.sh.";
  return {
    paths: new AutoPaths(autoBaseRoot()),
    home,
    dockerEnv: env,
    async checkRunner() {
      if (!existsSync(cli))
        throw new Error(
          `Autopilot runs through the terminal client, which is not at ${cli}. ${install}`,
        );
      const { stdout } = await run(cli, ["--version"], { env, timeout: 15_000 });
      const version = /Poundlock Dispatch (\S+)/.exec(stdout)?.[1];
      if (version !== appVersion)
        throw new Error(
          `The terminal client at ${cli} is ${version ?? "an unknown version"}; this app is ${appVersion}. ${install}`,
        );
    },
    spawnRunner(runDir) {
      const log = openSync(join(runDir, "runner.log"), "a", 0o600);
      const child = spawn(cli, ["auto", "run", runDir], {
        detached: true,
        stdio: ["ignore", log, log],
        env,
      });
      // A spawn that fails after the check (EACCES, EMFILE) is logged to the
      // run, which then reads as interrupted, rather than crashing the app.
      child.on("error", (error) => {
        appendFileSync(
          join(runDir, "runner.log"),
          `could not start the runner: ${error.message}\n`,
        );
      });
      child.unref();
      closeSync(log);
    },
  };
}
