/**
 * Processes a worker's commands left running after their parent exited.
 * swift test's swiftpm-testing-helper runs in its own process group, so a
 * test run ended by Pi's bash tool or a group kill left a hung helper behind,
 * holding the project's build while the next run started (14 Oct). Every
 * worker command carries RUN_MARKER in its environment, which children
 * inherit; an orphan (parent PID 1: launchd, or init on Linux) that still
 * carries this project's marker is ended. On Linux an orphan adopted by a
 * subreaper such as `systemd --user` keeps a parent other than 1 and is not
 * found here.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

export const RUN_MARKER = "DISPATCH_RUN";

/** The marker for one project's worker commands, from its private home. */
export function runMarker(privateHome: string): string {
  return createHash("sha256").update(privateHome).digest("hex").slice(0, 16);
}

/**
 * Orphans whose environment carries `marker`, from a process listing: pid,
 * ppid, then the command line with the environment appended (`ps -E`).
 */
export function markedOrphans(marker: string, listing = processListing()): number[] {
  const tag = ` ${RUN_MARKER}=${marker} `;
  return listing.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match || match[2] !== "1" || Number(match[1]) === process.pid) return [];
    return ` ${match[3]} `.includes(tag) ? [Number(match[1])] : [];
  });
}

/** End this project's orphaned worker processes; returns how many. */
export function reapOrphans(marker: string | undefined): number {
  if (!marker) return 0;
  let ended = 0;
  for (const pid of markedOrphans(marker)) {
    try {
      process.kill(pid, "SIGKILL");
      ended += 1;
    } catch {
      /* already gone */
    }
  }
  return ended;
}

function processListing(): string {
  if (process.platform === "linux") return procListing();
  try {
    return execFileSync("/bin/ps", ["-E", "-ww", "-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

/** The same listing from /proc, whose `ps` has no `-E`. Unreadable entries
 * (other users' processes, ones that just exited) are skipped. */
function procListing(): string {
  const rows: string[] = [];
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
      const words = (file: string) =>
        readFileSync(`/proc/${pid}/${file}`, "utf8").split("\0").filter(Boolean).join(" ");
      rows.push(`${pid} ${ppid} ${words("cmdline")} ${words("environ")}`);
    } catch {
      /* gone or not ours */
    }
  }
  return rows.join("\n");
}
