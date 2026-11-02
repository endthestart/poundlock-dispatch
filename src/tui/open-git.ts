/**
 * `dispatch --git <url> --branch <name|commit> [--account github|gitea]`:
 * the app's "Git repository" project. Dispatch clones it into its own data
 * the first time; the same repository and branch reopen that project after.
 */
import type { DispatchHost } from "@core/host/dispatch-host";
import type { FileStore } from "@core/store";
import type { ForgeKind, ProjectRecord } from "@shared/types";

export interface GitOpen {
  repository: string;
  revision: string;
  forge?: ForgeKind;
}

export const GIT_USAGE =
  "Usage: dispatch --git <https url> --branch <name or commit> [--account github|gitea]";

/** `--git`, `--branch` and `--account` from the command line, or nothing when `--git` is absent. */
export function parseGitOpen(args: string[]): GitOpen | undefined {
  const value = (flag: string) => {
    const at = args.indexOf(flag);
    if (at < 0) return undefined;
    const next = args[at + 1];
    if (!next || next.startsWith("-")) throw new Error(`${flag} needs a value. ${GIT_USAGE}`);
    return next;
  };
  const repository = value("--git");
  if (!repository) {
    if (args.includes("--branch") || args.includes("--account")) throw new Error(GIT_USAGE);
    return undefined;
  }
  const revision = value("--branch");
  if (!revision) throw new Error(`Name the branch or commit with --branch. ${GIT_USAGE}`);
  const account = value("--account");
  if (account !== undefined && account !== "github" && account !== "gitea")
    throw new Error(`--account is github or gitea. ${GIT_USAGE}`);
  return { repository, revision, ...(account ? { forge: account } : {}) };
}

/** The flags `parseGitOpen` read, so what is left is the usual arguments. */
export function withoutGitFlags(args: string[]): string[] {
  const flags = new Set(["--git", "--branch", "--account"]);
  return args.filter((arg, index) => !flags.has(arg) && !flags.has(args[index - 1] ?? ""));
}

/** Branch names are case-sensitive; a commit id is stored lower case. */
function sameRevision(stored: string, wanted: string): boolean {
  const ref = wanted.trim();
  return stored === (/^[0-9a-f]{40}$/i.test(ref) ? ref.toLowerCase() : ref);
}

/** The repository's project at that branch, cloned if there is none yet. */
export async function openGitProject(
  host: DispatchHost,
  store: FileStore,
  wanted: GitOpen,
): Promise<ProjectRecord> {
  const existing = (await store.listProjects()).find(
    (project) =>
      project.source.kind === "git" &&
      project.source.repository === wanted.repository.trim() &&
      sameRevision(project.source.revision, wanted.revision) &&
      !project.archived &&
      !project.removing,
  );
  if (existing) return existing;
  const state = await host.createProjectFromGit(wanted);
  const created = state.projects.find((project) => project.id === state.selectedProjectId);
  if (!created) throw new Error(state.notice?.text ?? "The repository could not be added.");
  return created;
}
