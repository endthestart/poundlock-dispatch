import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { gitEnvironment, runGit } from "../git";
import { CACHE_EXCLUDE_PATTERNS } from "./scope";

/**
 * Git for local auto mode (ADR 014). The owner's checkout is only ever read:
 * a run works in a worktree of a private bare mirror, on its own branch.
 * Nothing is reset until everything a reset would destroy is saved as a draft
 * commit under refs/auto/, captured through a throwaway index (plain
 * `write-tree` sees only what is staged) and written as a patch.
 *
 * The worktree is writable from the run's container, so Dispatch never trusts
 * anything in it for its own Git: the Git directory is named explicitly (a
 * rewritten `.git` file is never followed) and hooks and fsmonitor are off.
 * Nor does the owner's own Git configuration apply: a signing key, an
 * external diff or a global excludes file would change what is saved.
 */

/** Git's environment for a run: no system or global configuration. */
export function autoGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...gitEnvironment(), GIT_CONFIG_GLOBAL: "/dev/null", ...extra };
}

/** Settings every run's Git call carries, whatever the repository's own configuration says. */
const SAFE = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "diff.ignoreSubmodules=all",
  "-c",
  "status.submoduleSummary=false",
];

/** A patch exactly as Git would apply it: no external diff, text conversion, colour or custom prefixes. */
const PATCH_DIFF = [
  "diff",
  "--binary",
  "--full-index",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

async function checked(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runGit(cwd, args, env);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

/** The mirror: a bare clone, so nothing is checked out twice. */
export class MirrorRepo {
  constructor(readonly dir: string) {}

  run(args: string[], env: NodeJS.ProcessEnv = autoGitEnv()) {
    return runGit(dirname(this.dir), ["--git-dir", this.dir, ...SAFE, ...args], env);
  }

  output(args: string[], env: NodeJS.ProcessEnv = autoGitEnv()): Promise<string> {
    return checked(dirname(this.dir), ["--git-dir", this.dir, ...SAFE, ...args], env);
  }
}

/** One run's worktree, driven only through its own Git directory. */
export class RunRepo {
  constructor(
    readonly worktree: string,
    readonly gitDir: string,
  ) {}

  private args(args: string[]): string[] {
    return ["--git-dir", this.gitDir, "--work-tree", this.worktree, ...SAFE, ...args];
  }

  run(args: string[], env: NodeJS.ProcessEnv = autoGitEnv()) {
    return runGit(this.worktree, this.args(args), env);
  }

  output(args: string[], env: NodeJS.ProcessEnv = autoGitEnv()): Promise<string> {
    return checked(this.worktree, this.args(args), env);
  }

  head(): Promise<string> {
    return this.output(["rev-parse", "HEAD"]);
  }
}

/** Marks a mirror that holds only what Git transfers, not a copy of the source's object store. */
const TRANSFERRED_ONLY = "dispatch-mirror: transferred objects only";

/**
 * A bare mirror of the source with the cache excludes, holding the base commit.
 * The run's container can read it, so it holds only the current branch's
 * history as Git transfers it (L30): a local clone copied the whole object
 * store, with dropped stashes, other branches and secrets rewritten out of
 * history.
 */
export async function ensureMirror(
  source: string,
  mirrorDir: string,
  baseCommit: string,
): Promise<MirrorRepo> {
  const mirror = new MirrorRepo(mirrorDir);
  const marker = join(mirrorDir, "description");
  if (!existsSync(join(mirrorDir, "HEAD"))) {
    await mkdir(dirname(mirrorDir), { recursive: true, mode: 0o700 });
    await checked(
      dirname(mirrorDir),
      [
        ...SAFE,
        "clone",
        "--quiet",
        "--bare",
        "--no-local",
        "--single-branch",
        "--no-tags",
        source,
        mirrorDir,
      ],
      autoGitEnv(),
    );
    await mirror.output(["remote", "remove", "origin"]);
    await writeFile(marker, `${TRANSFERRED_ONLY}\n`);
  } else if ((await readFile(marker, "utf8").catch(() => "")).trim() !== TRANSFERRED_ONLY) {
    await pruneLocalClone(mirror);
    await writeFile(marker, `${TRANSFERRED_ONLY}\n`);
  }
  if ((await mirror.run(["cat-file", "-e", `${baseCommit}^{commit}`])).code !== 0)
    await mirror.output(["fetch", "--quiet", source, baseCommit]);
  const exclude = join(mirrorDir, "info", "exclude");
  const existing = await readFile(exclude, "utf8").catch(() => "");
  const missing = CACHE_EXCLUDE_PATTERNS.filter((line) => !existing.split("\n").includes(line));
  if (missing.length) {
    await mkdir(dirname(exclude), { recursive: true });
    await appendFile(
      exclude,
      `${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
    );
  }
  return mirror;
}

/**
 * A mirror an older Dispatch made with a local clone: keep only its runs'
 * branches and drafts, and drop every other ref and each object nothing kept
 * reaches.
 */
async function pruneLocalClone(mirror: MirrorRepo): Promise<void> {
  const refs = (await mirror.output(["for-each-ref", "--format=%(refname)"]))
    .split("\n")
    .filter(Boolean);
  for (const ref of refs)
    if (!ref.startsWith("refs/heads/auto/") && !ref.startsWith("refs/auto/"))
      await mirror.output(["update-ref", "-d", ref]);
  await mirror.output(["reflog", "expire", "--expire=now", "--all"]);
  await mirror.output(["gc", "--quiet", "--prune=now"]);
}

/** Add the run's worktree on its own branch; returns its Git directory, read before anything else runs in it. */
export async function createRunWorktree(
  mirror: MirrorRepo,
  worktreeDir: string,
  branch: string,
  base: string,
): Promise<RunRepo> {
  await mirror.output(["worktree", "add", "--quiet", "-b", branch, worktreeDir, base]);
  const pointer = (await readFile(join(worktreeDir, ".git"), "utf8")).trim();
  const gitDir = pointer.replace(/^gitdir:\s*/, "");
  if (!isAbsolute(gitDir) || !(await isInside(mirror.dir, gitDir)))
    throw new Error(`The run's worktree points outside its mirror (${gitDir}).`);
  return new RunRepo(worktreeDir, gitDir);
}

/**
 * Whether the worktree's `.git` is still the plain file Git wrote, naming the
 * run's own Git directory. Host Git run in the folder follows it, so anything
 * else there would run configuration the model wrote (H4).
 */
export async function worktreePointerIntact(worktree: string, gitDir: string): Promise<boolean> {
  const pointer = join(worktree, ".git");
  const stats = await lstat(pointer).catch(() => undefined);
  if (!stats?.isFile() || stats.size > 4096) return false;
  return (await readFile(pointer, "utf8")).trim() === `gitdir: ${gitDir}`;
}

/** Put the worktree's `.git` back as the file Git wrote, whatever is there now. */
export async function restoreWorktreePointer(worktree: string, gitDir: string): Promise<void> {
  const pointer = join(worktree, ".git");
  await rm(pointer, { recursive: true, force: true });
  await writeFile(pointer, `gitdir: ${gitDir}\n`, { flag: "wx", mode: 0o644 });
}

async function isInside(parent: string, child: string): Promise<boolean> {
  const [p, c] = await Promise.all([realpath(parent), realpath(child)]);
  const rel = relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Refuse anything that is not this run's worktree of this run's mirror. */
export async function assertIsolatedWorktree(
  repo: RunRepo,
  guard: { mirrorDir: string; runsRoot: string },
): Promise<void> {
  if (!(await isInside(guard.runsRoot, repo.worktree)))
    throw new Error(`Refusing to reset ${repo.worktree}: it is not inside the auto runs folder.`);
  if (!(await isInside(guard.mirrorDir, repo.gitDir)))
    throw new Error(`Refusing to reset ${repo.worktree}: it does not belong to the run's mirror.`);
}

export interface Draft {
  ref: string;
  commit: string;
  tree: string;
  patchFile: string;
  patchSha256: string;
  files: string[];
}

/**
 * Git repositories the worktree holds inside it (Git lists each as `dir/`).
 * Dispatch never stages one: adding it would embed it as a gitlink, and from
 * then on host Git would run inside it with its own configuration.
 */
export async function nestedRepositories(repo: RunRepo): Promise<string[]> {
  const result = await repo.run([
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--ignore-submodules=all",
    "-z",
  ]);
  if (result.code !== 0) throw new Error(result.stderr || "git status failed");
  return result.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("?? ") && entry.endsWith("/"))
    .map((entry) => entry.slice(3, -1));
}

/** `git add -A`, leaving nested repositories out. */
async function addAll(repo: RunRepo, env?: NodeJS.ProcessEnv): Promise<void> {
  const nested = await nestedRepositories(repo);
  await repo.output(
    ["add", "-A", "--", ".", ...nested.map((path) => `:(exclude,literal)${path}`)],
    env,
  );
}

/** Save the working tree as a draft commit and patch, touching neither the files nor the real index. */
export async function saveDraft(
  repo: RunRepo,
  ref: string,
  patchFile: string,
  label: string,
): Promise<Draft | null> {
  const scratch = await mkdtemp(join(tmpdir(), "auto-index-"));
  const env = autoGitEnv({ GIT_INDEX_FILE: join(scratch, "index") });
  try {
    await repo.output(["read-tree", "HEAD"], env);
    await addAll(repo, env);
    const tree = await repo.output(["write-tree"], env);
    if (tree === (await repo.output(["rev-parse", "HEAD^{tree}"]))) return null;
    const commit = await repo.output([
      "commit-tree",
      tree,
      "-p",
      "HEAD",
      "-m",
      `auto draft: ${label}`,
    ]);
    await repo.output(["update-ref", ref, commit]);
    if ((await repo.output(["rev-parse", ref])) !== commit)
      throw new Error(`Draft ref ${ref} did not resolve to ${commit}.`);
    // Written by Git itself, byte for byte: a patch read back as text can lose bytes.
    await repo.output([...PATCH_DIFF, `--output=${patchFile}`, "HEAD", commit]);
    await chmod(patchFile, 0o600);
    const files = (await repo.output(["diff", "--name-only", "HEAD", commit]))
      .split("\n")
      .filter(Boolean);
    return {
      ref,
      commit,
      tree,
      patchFile,
      files,
      patchSha256: createHash("sha256")
        .update(await readFile(patchFile))
        .digest("hex"),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Back to the last checkpoint. Only after the isolation check; ignored files (.venv, caches) stay. */
export async function resetToCheckpoint(
  repo: RunRepo,
  checkpoint: string,
  guard: { mirrorDir: string; runsRoot: string },
): Promise<void> {
  await assertIsolatedWorktree(repo, guard);
  await repo.output(["reset", "--quiet", "--hard", checkpoint]);
  // -ff: nested repositories go too; the draft already holds everything else.
  await repo.output(["clean", "-ffdq"]);
}

/**
 * Commit everything the case changed, except paths it must never commit
 * (caches and the prepared environment): tracked ones go back to HEAD, new
 * ones are left on disk but unstaged. Returns null when nothing is left.
 */
export async function commitCheckpoint(
  repo: RunRepo,
  message: string,
  exclude: (path: string) => boolean,
): Promise<string | null> {
  await addAll(repo);
  const staged = (await repo.run(["diff", "--cached", "--name-only", "-z"])).stdout
    .split("\0")
    .filter(Boolean);
  const dropped = staged.filter(exclude);
  if (dropped.length) {
    const tracked = new Set(
      (await repo.run(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...dropped])).stdout
        .split("\0")
        .filter(Boolean),
    );
    const restore = dropped.filter((path) => tracked.has(path));
    const unstage = dropped.filter((path) => !tracked.has(path));
    if (restore.length) await repo.output(["checkout", "HEAD", "--", ...restore]);
    if (unstage.length) await repo.output(["rm", "--cached", "-q", "--", ...unstage]);
  }
  if ((await repo.run(["diff", "--cached", "--quiet"])).code === 0) return null;
  await repo.output(["commit", "--quiet", "--no-verify", "-m", message]);
  return repo.head();
}

/** Paths changed against HEAD, including untracked ones. */
export async function changedPaths(repo: RunRepo): Promise<string[]> {
  // Untrimmed: the first entry's status column starts with a space.
  const result = await repo.run([
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--ignore-submodules=all",
    "-z",
  ]);
  if (result.code !== 0) throw new Error(result.stderr || "git status failed");
  const entries = result.stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    paths.push(entries[i].slice(3));
    // A rename carries its old path as the next NUL-separated field.
    if (entries[i][0] === "R" || entries[i][0] === "C") paths.push(entries[++i]);
  }
  return paths;
}

/** Untracked paths right now, as Git lists them (a new folder once, with its slash). */
export async function untrackedTopPaths(repo: RunRepo): Promise<string[]> {
  const result = await repo.run([
    "status",
    "--porcelain",
    "--untracked-files=normal",
    "--ignore-submodules=all",
    "-z",
  ]);
  if (result.code !== 0) throw new Error(result.stderr || "git status failed");
  return result.stdout
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3).replace(/\/$/, ""));
}

/**
 * Keep paths out of Git's untracked list for every worktree of the mirror. The
 * file is the mirror's, shared by its runs, so a new run (`fresh`) first drops
 * the paths earlier runs added: a path one run took for its environment hid
 * that file from every later run.
 */
export async function excludeFromRun(
  mirror: MirrorRepo,
  paths: string[],
  { fresh = false }: { fresh?: boolean } = {},
): Promise<void> {
  if (!paths.length && !fresh) return;
  const file = join(mirror.dir, "info", "exclude");
  await mkdir(dirname(file), { recursive: true });
  let existing = await readFile(file, "utf8").catch(() => "");
  if (fresh) {
    existing = existing
      .split("\n")
      .filter((line) => line && !line.startsWith("/"))
      .map((line) => `${line}\n`)
      .join("");
    await writeFile(file, existing);
  }
  const lines = paths
    .map((path) => `/${path}`)
    .filter((line) => !existing.split("\n").includes(line));
  if (lines.length)
    await appendFile(
      file,
      `${existing && !existing.endsWith("\n") ? "\n" : ""}${lines.join("\n")}\n`,
    );
}

export interface CheckpointCommit {
  commit: string;
  caseId?: string;
  finish?: "done" | "progress";
}

/** Checkpoint commits after `from` up to HEAD, oldest first, with their auto trailers. */
export async function checkpointsSince(repo: RunRepo, from: string): Promise<CheckpointCommit[]> {
  const log = await repo.output(["log", "--reverse", "--format=%H%x00%B%x1e", `${from}..HEAD`]);
  return log
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [commit, body = ""] = record.split("\0");
      // Trailers are the message's last paragraph; a title cannot forge one.
      const trailers =
        body
          .trim()
          .split(/\n\s*\n/)
          .at(-1) ?? "";
      const trailer = (name: string) =>
        new RegExp(`^${name}: (.+)$`, "m").exec(trailers)?.[1]?.trim();
      const finish = trailer("Dispatch-Auto-Finish");
      return {
        commit,
        caseId: trailer("Dispatch-Auto-Case"),
        finish: finish === "done" || finish === "progress" ? finish : undefined,
      };
    });
}

export interface ExportedPatch {
  file: string;
  base: string;
  head: string;
  bytes: number;
  sha256: string;
  files: string[];
}

/**
 * Write the run's work from `base` to `head` as one binary patch, after
 * checking that it applies to `base` (in a throwaway index; nothing is
 * checked out). The header above the first diff is ignored by `git apply`.
 */
export async function exportPatch(
  mirror: MirrorRepo,
  base: string,
  head: string,
  file: string,
  header: string[],
): Promise<ExportedPatch> {
  const scratch = await mkdtemp(join(tmpdir(), "auto-export-"));
  try {
    const patch = join(scratch, "work.patch");
    await mirror.output([...PATCH_DIFF, `--output=${patch}`, base, head]);
    const bytes = await readFile(patch);
    if (!bytes.length) throw new Error("The run has no verified change to export yet.");
    const env = autoGitEnv({ GIT_INDEX_FILE: join(scratch, "index") });
    await mirror.output(["read-tree", base], env);
    const check = await mirror.run(["apply", "--cached", "--check", patch], env);
    if (check.code !== 0)
      throw new Error(`The exported patch does not apply to ${base}: ${check.stderr.trim()}`);
    const text = Buffer.concat([
      Buffer.from(`${header.map((line) => (line ? `# ${line}` : "#")).join("\n")}\n\n`),
      bytes,
    ]);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, text, { mode: 0o600 });
    return {
      file,
      base,
      head,
      bytes: text.length,
      sha256: createHash("sha256").update(text).digest("hex"),
      files: (await mirror.output(["diff", "--name-only", base, head])).split("\n").filter(Boolean),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
