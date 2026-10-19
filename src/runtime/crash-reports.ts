/**
 * The faulting thread of a crash a command caused, from macOS's own crash
 * report. A worker that sees only "signal 11" from `swift test` guesses at the
 * cause; the report in ~/Library/Logs/DiagnosticReports names it in its first
 * frames. Only reports written during
 * the command that load code from the project are read, so another app's
 * crash never reaches the worker.
 */
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const CRASH_REPORTS = join(homedir(), "Library", "Logs", "DiagnosticReports");
const FRAMES = 20;
/** ReportCrash writes a report a moment after the process dies. */
const REPORT_WAIT_MS = 3000;
const CRASH_SIGNATURE =
  /\bsignal (?:code )?(?:4|6|10|11)\b|SIGSEGV|SIGBUS|SIGABRT|SIGILL|Segmentation fault|Bus error|Abort trap/i;

interface Report {
  name: string;
  summary: string;
}

/** A crash summary for failed command output, or "" when no report involves the project. */
export async function crashSummary(input: {
  output: string;
  projectRoot: string;
  since: number;
  dir?: string;
  waitMs?: number;
}): Promise<string> {
  if (!CRASH_SIGNATURE.test(input.output)) return "";
  const deadline = Date.now() + (input.waitMs ?? REPORT_WAIT_MS);
  for (;;) {
    const reports = await projectReports(
      input.dir ?? CRASH_REPORTS,
      input.projectRoot,
      input.since,
    );
    if (reports.length || Date.now() >= deadline)
      return reports.map((report) => report.summary).join("\n\n");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function projectReports(dir: string, projectRoot: string, since: number): Promise<Report[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const recent: Array<{ name: string; at: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".ips")) continue;
    const at = await stat(join(dir, name)).then(
      (info) => info.mtimeMs,
      () => 0,
    );
    if (at >= since - 1000) recent.push({ name, at });
  }
  const reports: Report[] = [];
  for (const { name } of recent.sort((a, b) => b.at - a.at).slice(0, 3)) {
    const summary = summarise(
      await readFile(join(dir, name), "utf8").catch(() => ""),
      projectRoot,
      (image) => builtInProject(projectRoot, image),
    );
    if (summary) reports.push({ name, summary: `Crash report ${name}:\n${summary}` });
  }
  return reports;
}

/** Whether a file named `name` was built in the project (its build folders, searched briefly). */
export function builtInProject(projectRoot: string, name: string): boolean {
  const folders = [".build", "target", "build", "DerivedData"].map((folder) =>
    join(projectRoot, folder),
  );
  try {
    return Boolean(
      execFileSync("/usr/bin/find", [...folders, "-name", name, "-type", "f", "-print", "-quit"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch (error) {
    // find exits non-zero when a folder is missing but still prints matches.
    const stdout = (error as { stdout?: string }).stdout;
    return Boolean(stdout?.trim());
  }
}

interface Frame {
  imageIndex?: number;
  symbol?: string;
  sourceFile?: string;
  sourceLine?: number;
}

/** The faulting thread of one .ips report, or "" when it loads nothing from the project. */
export function summarise(
  text: string,
  projectRoot: string,
  inProject: (name: string) => boolean = () => false,
): string {
  const newline = text.indexOf("\n");
  if (newline < 0) return "";
  let body: {
    procName?: string;
    exception?: { type?: string; signal?: string; subtype?: string };
    faultingThread?: number;
    threads?: Array<{ frames?: Frame[] }>;
    usedImages?: Array<{ name?: string; path?: string }>;
  };
  try {
    body = JSON.parse(text.slice(newline + 1));
  } catch {
    return "";
  }
  const images = body.usedImages ?? [];
  // macOS anonymises the user's own paths ("/Users/USER/*/AppTests"), so an
  // image from the project is known by its name inside the project folder.
  const fromProject = images.some(
    (image) =>
      image.path?.startsWith(projectRoot) ||
      (image.path?.startsWith("/Users/USER/") && image.name && inProject(image.name)),
  );
  if (!fromProject) return "";
  const frames = body.threads?.[body.faultingThread ?? 0]?.frames ?? [];
  const exception = body.exception;
  // Swift's thunks and partial applies repeat the frame above them.
  const meaningful = frames.filter((frame) => !frame.sourceFile?.endsWith("<compiler-generated>"));
  const lines = meaningful.slice(0, FRAMES).map((frame) => {
    const image = images[frame.imageIndex ?? -1]?.name ?? "?";
    const source = frame.sourceFile
      ? ` (${basename(frame.sourceFile)}${frame.sourceLine ? `:${frame.sourceLine}` : ""})`
      : "";
    return `  ${image}  ${frame.symbol ?? "?"}${source}`;
  });
  return [
    `${exception?.type ?? "Crash"} (${exception?.signal ?? "signal unknown"}${exception?.subtype ? `, ${exception.subtype}` : ""}) in ${body.procName ?? "a process"}. Crashing thread, innermost first:`,
    ...lines,
  ].join("\n");
}
