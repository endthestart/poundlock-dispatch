/** A run's worktree, ledger and scripted worker, as the engine tests build them. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRunWorktree, ensureMirror } from "@core/auto/checkpoint-git";
import { AutoLedger } from "@core/auto/ledger";
import type { AutoWorkerPort, CaseAttemptInput, CaseAttemptResult } from "@core/auto/ports";
import { tempDir } from "./temp-dir";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

export async function setup(files: Record<string, string> = {}) {
  const source = await tempDir("auto-source-");
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, ".gitignore"), ".venv/\n");
  await writeFile(join(source, "README.md"), "base\n");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(source, name, ".."), { recursive: true });
    await writeFile(join(source, name), text);
  }
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  const base = git(source, "rev-parse", "HEAD");
  const root = await tempDir("auto-data-");
  const runsRoot = join(root, "runs");
  const runDir = join(runsRoot, "r1");
  await mkdir(runDir, { recursive: true });
  const mirror = await ensureMirror(source, join(root, "mirrors", "m.git"), base);
  const repo = await createRunWorktree(mirror, join(runDir, "work"), "auto/r1", base);
  return {
    source,
    base,
    mirror,
    repo,
    runsRoot,
    runDir,
    worktree: repo.worktree,
    ledger: new AutoLedger(runDir),
  };
}
export type Env = Awaited<ReturnType<typeof setup>>;

export type Script = (input: CaseAttemptInput) => Promise<CaseAttemptResult>;

export function worker(script: Script, seen: CaseAttemptInput[] = []): AutoWorkerPort {
  return {
    runCase: async (input) => {
      seen.push(input);
      return script(input);
    },
  };
}
