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
