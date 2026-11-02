/**
 * `/accounts`: Settings → Integrations in the app. A GitHub or Gitea account
 * for private repositories, pushing and pull requests, stored only on this
 * computer. The token is asked for hidden, never typed as an argument.
 */
import type { AppStateView, ForgeKind } from "@shared/types";

const ACCOUNTS_USAGE =
  "Usage: /accounts, /accounts github <username> [host], /accounts gitea <username> [base address], or /accounts remove <github|gitea>";

const TITLE: Record<ForgeKind, string> = { github: "GitHub", gitea: "Gitea" };

export const TOKEN_HINT: Record<ForgeKind, string> = {
  github:
    "A personal access token with contents read/write and pull requests. Dispatch will not push until you confirm.",
  gitea: "An access token for this Gitea.",
};

type Integrations = AppStateView["integrations"];

export function accountLines(integrations: Integrations): string {
  return (["github", "gitea"] as const)
    .map((kind) => {
      const account = integrations[kind];
      if (!account) return `${TITLE[kind]}: not configured.`;
      return `${TITLE[kind]}: ${account.username} at ${account.host}${account.configured ? "" : " (no token saved)"}.`;
    })
    .join("\n");
}

export type AccountsRequest =
  | { action: "show" }
  | { action: "remove"; kind: ForgeKind }
  | { action: "save"; kind: ForgeKind; username: string; host: string; title: string };

const isForge = (value: string | undefined): value is ForgeKind =>
  value === "github" || value === "gitea";

export function parseAccounts(args: string, integrations: Integrations): AccountsRequest {
  const [first, second, third, ...extra] = args.trim().split(/\s+/).filter(Boolean);
  if (!first) return { action: "show" };
  if (extra.length) throw new Error(ACCOUNTS_USAGE);
  if (first === "remove" && isForge(second) && !third) {
    if (!integrations[second]) throw new Error(`No ${TITLE[second]} account is saved.`);
    return { action: "remove", kind: second };
  }
  if (!isForge(first) || !second) throw new Error(ACCOUNTS_USAGE);
  const host =
    third ?? integrations[first]?.host ?? (first === "github" ? "https://github.com" : undefined);
  if (!host) throw new Error("Give the Gitea base address: /accounts gitea <username> <address>.");
  return { action: "save", kind: first, username: second, host, title: TITLE[first] };
}
