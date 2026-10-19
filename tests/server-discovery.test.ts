import { parseInteractiveModels } from "@core/poundlock";
import { connectionDiscoveryChanged, ServerDiscovery } from "@core/server-discovery";
import { catalogFromProbe } from "@shared/roles";
import type { ConnectionProbe, ConnectionSettings } from "@shared/types";
import { expect, it } from "vitest";

const connection: ConnectionSettings = { url: "http://fixture", token: "synthetic", roles: {} };
function probe(destination = "unknown"): ConnectionProbe {
  return {
    ok: true,
    url: connection.url,
    ready: true,
    permissions: [],
    missingPermissions: [],
    durableModels: [],
    interactiveModels: parseInteractiveModels([
      {
        id: "canonical-profile",
        poundlock: {
          profile_id: "id",
          canonical_name: "canonical-profile",
          upstream_model: "actual-model",
          data_destination: destination,
        },
      },
      {
        id: "coding",
        poundlock: {
          profile_id: "id",
          canonical_name: "canonical-profile",
          upstream_model: "actual-model",
          data_destination: destination,
        },
      },
    ]),
    harnesses: [],
    gitHosts: [],
    outboundNetworkAllowed: false,
  };
}

it("refreshes canonical profiles and destinations without duplicate aliases", async () => {
  let destination = "unknown";
  const cache = new ServerDiscovery(
    async () => probe(destination),
    () => {},
  );
  await cache.refresh(connection);
  expect(cache.probe?.interactiveModels[0].dataDestination).toBe("unknown");
  destination = "operator_network";
  await cache.refresh(connection);
  expect(catalogFromProbe(cache.probe!)).toMatchObject([
    {
      name: "canonical-profile",
      upstreamModel: "actual-model",
      dataDestination: "operator_network",
    },
  ]);
  expect(cache.updatedAt).toBeTruthy();
  expect(cache.refreshing).toBe(false);
});

it("shares concurrent refreshes and rejects responses from the previous connection", async () => {
  let resolve!: (value: ConnectionProbe) => void;
  let calls = 0;
  const cache = new ServerDiscovery(
    () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
    () => {},
  );
  const old = cache.refresh(connection);
  expect(cache.refresh(connection)).toBe(old);
  expect(calls).toBe(1);
  const finishOld = resolve;
  cache.invalidate();
  const current = cache.refresh({ ...connection, url: "http://new" });
  finishOld(probe());
  await old;
  expect(cache.probe).toBeUndefined();
  expect(cache.refreshing).toBe(true);
  resolve({ ...probe("external"), url: "http://new" });
  await current;
  expect(cache.probe?.url).toBe("http://new");
});

it("keeps last known catalog visibly stale after a failure and recovers on refresh", async () => {
  let fails = false;
  const cache = new ServerDiscovery(
    async () => (fails ? { ...probe(), ok: false, error: "Controller starting" } : probe()),
    () => {},
  );
  await cache.refresh(connection);
  const updated = cache.updatedAt;
  fails = true;
  await cache.refresh(connection);
  expect(cache.probe?.ok).toBe(false);
  expect(cache.probe?.error).toBe("Controller starting");
  expect(cache.probe?.interactiveModels).toHaveLength(1);
  expect(cache.updatedAt).toBe(updated);
  fails = false;
  await cache.refresh(connection);
  expect(cache.probe?.ok).toBe(true);
  expect(cache.probe?.error).toBeUndefined();
});

it("patches managed identity usage without a full probe", async () => {
  let remaining = 3.8;
  let probes = 0;
  const cache = new ServerDiscovery(
    async () => {
      probes += 1;
      return {
        ...probe(),
        managedIdentities: [
          {
            endpoint_id: "gw",
            status: "ready",
            usage_status: "available",
            usage: { remaining_budget: remaining },
          },
        ],
      };
    },
    () => {},
    async () => [
      {
        endpoint_id: "gw",
        status: "ready",
        usage_status: "available",
        usage: { remaining_budget: remaining },
      },
    ],
  );
  await cache.refresh(connection);
  remaining = 3.1;
  await cache.refreshUsage(connection);
  expect(probes).toBe(1);
  expect(cache.probe?.managedIdentities?.[0].usage?.remaining_budget).toBe(3.1);
});

it("preserves discovery for role-only saves but invalidates changed credentials or controller", () => {
  expect(
    connectionDiscoveryChanged(connection, {
      ...connection,
      url: "http://fixture/",
      token: "",
      roles: { manager: { profileId: "other", profileName: "other", source: "interactive" } },
    }),
  ).toBe(false);
  expect(connectionDiscoveryChanged(connection, { ...connection, token: "new" })).toBe(true);
  expect(connectionDiscoveryChanged(connection, { ...connection, url: "http://new" })).toBe(true);
});
