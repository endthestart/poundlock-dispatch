/**
 * Poundlock Dispatch in a terminal. A folder is the project.
 *
 * This is a composition root and nothing else: it builds the same
 * `DispatchHost` the desktop app builds, points it at this folder, and hands
 * it to the screens. The workflow — planning, delegation, review, repair,
 * approvals — is the code the desktop app runs, not a second copy of it.
 *
 * Each command loads only what it uses, so `--help` and `jobs` never load the
 * screen or the host.
 */
import { createRequire } from "node:module";
import { configureSystemCertificateAuthorities } from "@runtime/system-ca";
import { PI_VERSION } from "@shared/types";

const USAGE = `Usage: dispatch [folder]          Open a folder as a project (default: this folder).
       dispatch [folder] --json   Print the project's state and exit.
       dispatch --git <https url> --branch <name|commit> [--account github|gitea]
                                  Open a Git repository as a project; cloned the first time.
       dispatch autopilot <command>  Build an approved plan unattended. --help lists its commands.
                                  (dispatch auto is the same, for one more release.)
       dispatch jobs <command>    Durable Poundlock jobs. dispatch jobs --help lists them.
       dispatch completion <fish|zsh|bash>
                                  Print a shell completion script to load.
       dispatch --version
`;

/** This build's version, from the package.json beside the client in any install. */
function version(): string {
  try {
    return createRequire(import.meta.url)("../../package.json").version as string;
  } catch {
    return "unknown";
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`Poundlock Dispatch ${version()} (Pi ${PI_VERSION})\n`);
    return;
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  if (argv[0] === "completion") {
    const { completionScript } = await import("./completion.js");
    try {
      process.stdout.write(completionScript(argv[1]));
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 2;
    }
    return;
  }
  configureSystemCertificateAuthorities();
  // Model requests may wait ten minutes for an answer, as in the desktop app.
  const { configureModelHttp } = await import("@runtime/model-http");
  configureModelHttp();
  if (argv[0] === "autopilot" || argv[0] === "auto") {
    const { autoCommand } = await import("./cli-commands.js");
    process.exitCode = await autoCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "jobs") {
    const { jobsCommand } = await import("./cli-commands.js");
    // Left to drain rather than `process.exit`, so a patch piped to a slow reader is not cut off.
    process.exitCode = await jobsCommand(argv.slice(1));
    return;
  }
  const { openClient } = await import("./open-client.js");
  await openClient(argv);
}

if (process.argv[1]?.endsWith("tui/index.ts") || process.argv[1]?.endsWith("tui/index.js")) {
  main().catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
