import { DEFAULT_APPEARANCE } from "@shared/appearance";
import { visibleComposerInfolets } from "@shared/status-infolets";
import type { AppStateView } from "@shared/types";
import { DEFAULT_UI_PREFERENCES, normalizeUiPreferences } from "@shared/ui-preferences";
import { expect, it } from "vitest";

function state(overrides: Partial<AppStateView> = {}): AppStateView {
  return {
    connection: {
      url: "",
      tokenConfigured: false,
      roles: {},
      rolesReady: false,
    },
    integrations: {},
    permissions: { defaultMode: "assist", grants: {} },
    projects: [],
    busy: false,
    ui: DEFAULT_UI_PREFERENCES,
    appearance: DEFAULT_APPEARANCE,
    ...overrides,
  };
}

it("defaults composer status to the budget and context chips", () => {
  expect(normalizeUiPreferences(undefined).composerInfolets).toEqual(["budget", "context"]);
  expect(
    normalizeUiPreferences({ composerInfolets: ["nope" as "budget"] }).composerInfolets,
  ).toEqual([]);
});

it("hides budget until Poundlock reports gateway usage", () => {
  expect(visibleComposerInfolets(state()).length).toBe(0);
});

it("shows remaining spend next to Approve for me when usage is available", () => {
  const views = visibleComposerInfolets(
    state({
      probe: {
        managedIdentities: [
          {
            endpoint_id: "gw",
            status: "ready",
            usage_status: "available",
            usage: { spend: 0.0012, max_budget: 5, remaining_budget: 4.9988 },
          },
        ],
        ok: true,
        url: "https://example.invalid",
        ready: true,
        permissions: [],
        missingPermissions: [],
        durableModels: [],
        interactiveModels: [],
        harnesses: [],
        gitHosts: [],
        outboundNetworkAllowed: false,
      },
    }),
  );
  expect(views).toEqual([
    {
      id: "budget",
      text: "$5.00 left",
      title: "$0.0012 used · $5.00 limit · $5.00 remaining",
    },
  ]);
});

it("shows the install's frontier budget ahead of a key's own, and warns before the cap", () => {
  const probe = (
    frontierBudget: NonNullable<AppStateView["probe"]>["frontierBudget"],
  ): AppStateView["probe"] => ({
    frontierBudget,
    managedIdentities: [
      {
        endpoint_id: "gw",
        status: "ready",
        usage_status: "available",
        usage: { remaining_budget: 4.5 },
      },
    ],
    ok: true,
    url: "https://example.invalid",
    ready: true,
    permissions: [],
    missingPermissions: [],
    durableModels: [],
    interactiveModels: [],
    harnesses: [],
    gitHosts: [],
    outboundNetworkAllowed: false,
  });
  const periods = [
    {
      period: "weekly" as const,
      limit_usd: 25,
      spent_usd: 21,
      resets_at: "2026-11-09T06:00:00+00:00",
    },
  ];
  const text = (frontierBudget: Parameters<typeof probe>[0]) =>
    visibleComposerInfolets(state({ probe: probe(frontierBudget) }))[0].text;
  expect(text({ configured: true, state: "ok", remaining_usd: 12.5, periods })).toBe("$12.50 left");
  expect(text({ configured: true, state: "low", remaining_usd: 4, periods })).toBe(
    "$4.00 left, running low",
  );
  expect(text({ configured: true, state: "exhausted", remaining_usd: 0, periods })).toBe(
    "Frontier budget used up",
  );
  // No ceiling set, or a controller too old to say: the key's own figure stays.
  expect(text({ configured: false, state: "unconfigured", periods: [] })).toBe("$4.50 left");
  expect(text(undefined)).toBe("$4.50 left");
});

it("omits disabled composer infolets", () => {
  const views = visibleComposerInfolets(
    state({
      ui: { composerInfolets: [], desktopNotifications: false },
      probe: {
        managedIdentities: [
          {
            endpoint_id: "gw",
            status: "ready",
            usage_status: "available",
            usage: { spend: 1, remaining_budget: 2 },
          },
        ],
        ok: true,
        url: "https://example.invalid",
        ready: true,
        permissions: [],
        missingPermissions: [],
        durableModels: [],
        interactiveModels: [],
        harnesses: [],
        gitHosts: [],
        outboundNetworkAllowed: false,
      },
    }),
  );
  expect(views).toEqual([]);
});
