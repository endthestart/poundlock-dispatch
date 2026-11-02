/**
 * Two Project settings fields the terminal reaches by command:
 * `/runtime` is "Node runtime" — workers never inherit your shell PATH, so a
 * Node installed only through NVM is chosen per project — and `/repo-account`
 * is the repository access choice: public clone only, or the GitHub or Gitea
 * account saved with `/accounts`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ForgeKind, ProjectRecord, RuntimeCandidate } from "@shared/types";

const RUNTIME_USAGE =
  "Usage: /runtime, /runtime node <number|folder>, or /runtime node none. A folder is absolute or starts with ~.";
const REPO_ACCOUNT_USAGE = "Usage: /repo-account [github|gitea|none]";

export function runtimeLines(project: ProjectRecord, candidates: RuntimeCandidate[]): string {
  return [
    `Node runtime: ${project.policy.runtimes?.node ?? "none selected (system tool directories only)"}.`,
    ...(candidates.length
      ? [
          "Detected:",
          ...candidates.map(
            (item, index) =>
              `${index + 1}. Node ${item.version} (${item.source}) ${item.directory}`,
          ),
        ]
      : ["No Node versions detected; name the folder that contains node."]),
  ].join("\n");
}

/** The folder `/runtime node …` names: a detected one by number, a folder, or none (null). */
export function runtimeChoice(args: string, candidates: RuntimeCandidate[]): string | null {
  const [kind, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const wanted = rest.join(" ");
  if (kind !== "node" || !wanted) throw new Error(RUNTIME_USAGE);
  if (wanted === "none") return null;
  if (/^\d+$/.test(wanted)) {
    const found = candidates[Number.parseInt(wanted, 10) - 1];
    if (!found)
      throw new Error(`There is no detected Node ${wanted}; ${candidates.length} were found.`);
    return found.directory;
  }
  // `~` as a shell would expand it; anything else goes as typed, and must be absolute.
  return wanted === "~" || wanted.startsWith("~/") ? join(homedir(), wanted.slice(1)) : wanted;
}

export function repoAccountLine(project: ProjectRecord): string {
  const forge = project.source.forge;
  return `Repository access: ${
    forge
      ? `the ${forge === "github" ? "GitHub" : "Gitea"} account from /accounts`
      : "public clone only"
  }.`;
}

/** The account `/repo-account` names: a forge, or none for public clone only. */
export function repoAccountChoice(wanted: string): ForgeKind | undefined {
  if (wanted === "github" || wanted === "gitea") return wanted;
  if (wanted === "none") return undefined;
  throw new Error(REPO_ACCOUNT_USAGE);
}
