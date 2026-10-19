import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitEnvironment, gitOutput, isCommitId, runGit } from "./git.js";

export async function materializeSnapshot(
  workspace: string,
  files: Array<{ path: string; content: Buffer; executable: boolean }>,
  message: string,
): Promise<string> {
  await initBareGit(workspace);
  for (const file of files) {
    const destination = join(workspace, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
    if (file.executable) {
      await chmod(destination, 0o755);
    }
  }
  await gitOutput(workspace, ["add", "-A"]);
  await gitOutput(workspace, ["commit", "-m", message, "--allow-empty"]);
  return gitOutput(workspace, ["rev-parse", "HEAD"]);
}

export async function cloneGitRef(
  workspace: string,
  repository: string,
  revision: string,
  credentials?: { username: string; token: string },
): Promise<string> {
  const ref = revision.trim();
  if (!ref) {
    throw new Error("Enter a branch name or a 40-character commit.");
  }
  await mkdir(dirname(workspace), { recursive: true });
  const env = gitEnvironment();
  const askPass = credentials ? await gitAskPass() : undefined;
  if (credentials && askPass) {
    env.POUNDLOCK_DISPATCH_GIT_USERNAME = credentials.username;
    env.POUNDLOCK_DISPATCH_GIT_PASSWORD = credentials.token;
    env.GIT_ASKPASS = askPass.path;
    env.GIT_TERMINAL_PROMPT = "0";
  }
  const clone = await runGit(
    dirname(workspace),
    ["clone", "--template=", "--", repository, workspace],
    env,
  ).finally(() => askPass?.dispose());
  if (clone.code !== 0) {
    throw new Error(clone.stderr || "Could not clone the repository.");
  }
  const checkout = isCommitId(ref)
    ? await runGit(workspace, ["checkout", "--detach", ref])
    : await checkoutBranch(workspace, ref);
  if (checkout.code !== 0) {
    throw new Error(`Could not check out ${ref}. ${checkout.stderr}`.trim());
  }
  await runGit(workspace, ["config", "user.email", "dispatch@local"]);
  await runGit(workspace, ["config", "user.name", "Poundlock Dispatch"]);
  return gitOutput(workspace, ["rev-parse", "HEAD"]);
}

async function checkoutBranch(
  workspace: string,
  ref: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const local = await runGit(workspace, ["checkout", ref]);
  if (local.code === 0) return local;
  return runGit(workspace, ["checkout", "-B", ref, `origin/${ref}`]);
}

async function initBareGit(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  try {
    await access(join(workspace, ".git"), constants.F_OK);
  } catch {
    await gitOutput(workspace, ["init", "--template="]);
    await gitOutput(workspace, ["config", "user.email", "dispatch@local"]);
    await gitOutput(workspace, ["config", "user.name", "Poundlock Dispatch"]);
  }
}

/** Answers Git's username and password prompts from the clone's own environment. */
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*) printf '%s' "$POUNDLOCK_DISPATCH_GIT_USERNAME" ;;
  *) printf '%s' "$POUNDLOCK_DISPATCH_GIT_PASSWORD" ;;
esac
`;

/**
 * The askpass helper for one clone: the packaged app's, or one written into a
 * fresh private folder. Never a script found relative to the current folder,
 * which may be a project someone else wrote, and which would then be handed
 * the token (L26).
 */
async function gitAskPass(): Promise<{ path: string; dispose(): Promise<void> }> {
  const packaged = process.env.POUNDLOCK_DISPATCH_GIT_ASKPASS;
  if (packaged) return { path: packaged, dispose: async () => undefined };
  const dir = await mkdtemp(join(tmpdir(), "dispatch-askpass-"));
  const path = join(dir, "askpass.sh");
  await writeFile(path, ASKPASS_SCRIPT, { mode: 0o700, flag: "wx" });
  return { path, dispose: () => rm(dir, { recursive: true, force: true }) };
}
