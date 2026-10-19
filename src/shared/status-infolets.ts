import { contextUsageView } from "./compaction";
import type { AppStateView, ManagedIdentityUsage } from "./types";
import type { ComposerInfoletId } from "./ui-preferences";

interface StatusInfoletView {
  id: ComposerInfoletId;
  text: string;
  title: string;
  /** Set when the chip should offer to compact the conversation. */
  compactOffer?: boolean;
}

interface StatusInfoletDefinition {
  id: ComposerInfoletId;
  label: string;
  description: string;
  resolve: (state: AppStateView) => Omit<StatusInfoletView, "id"> | null;
}

/** The one money format for gateway spend/limit figures: fewer digits once the amount clears $1. */
export function formatMoney(value: number): string {
  const digits = Math.abs(value) >= 1 ? 2 : 4;
  return `$${value.toFixed(digits)}`;
}

function budgetInfolet(rows: ManagedIdentityUsage[]): Omit<StatusInfoletView, "id"> | null {
  const row = rows.find((item) => item.usage_status === "available" && item.usage);
  const usage = row?.usage;
  if (!usage) return null;
  const remaining = usage.remaining_budget;
  const spend = usage.spend;
  const maximum = usage.max_budget ?? row?.budget?.max_budget;
  const text =
    typeof remaining === "number"
      ? `${formatMoney(remaining)} left`
      : typeof spend === "number"
        ? `${formatMoney(spend)} used`
        : null;
  if (!text) return null;
  const title = [
    typeof spend === "number" ? `${formatMoney(spend)} used` : undefined,
    typeof maximum === "number" ? `${formatMoney(maximum)} limit` : undefined,
    typeof remaining === "number" ? `${formatMoney(remaining)} remaining` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return { text, title: title || text };
}

function contextInfolet(usage: AppStateView["contextUsage"]): Omit<StatusInfoletView, "id"> | null {
  if (!usage) return null;
  const view = contextUsageView(usage);
  return { text: view.text, title: view.title, compactOffer: view.offerCompact };
}

/** Register composer status chips here. Resolve returns null to hide. */
export const STATUS_INFOLET_CATALOG: StatusInfoletDefinition[] = [
  {
    id: "budget",
    label: "Budget",
    description: "Application gateway spend from Poundlock / LiteLLM.",
    resolve: (state) => budgetInfolet(state.probe?.managedIdentities ?? []),
  },
  {
    id: "context",
    label: "Context",
    description:
      "How full the Project Manager's conversation is, with an offer to compact it before it fills.",
    resolve: (state) => contextInfolet(state.contextUsage),
  },
];

export function visibleComposerInfolets(state: AppStateView): StatusInfoletView[] {
  const enabled = new Set(state.ui.composerInfolets);
  const views: StatusInfoletView[] = [];
  for (const item of STATUS_INFOLET_CATALOG) {
    if (!enabled.has(item.id)) continue;
    const resolved = item.resolve(state);
    if (!resolved) continue;
    views.push({ id: item.id, ...resolved });
  }
  return views;
}

/** Whether the context chip is showing and past the point of offering to compact. */
export function compactOffered(state: AppStateView): boolean {
  return visibleComposerInfolets(state).some((item) => item.compactOffer);
}
