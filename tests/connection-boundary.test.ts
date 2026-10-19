import { FileStore } from "@core/store";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

it("preserves same-controller credentials but never carries them or destination preferences to a new address", async () => {
  const store = new FileStore(await tempDir("dispatch-connection-"));
  await store.init();
  await store.saveConnection({
    url: "https://first.example",
    token: "synthetic",
    roles: {},
    profiles: { coding: { approvedDestination: "operator_network" } },
  });
  await store.saveConnection({ url: "https://first.example/", token: "", roles: {} });
  expect((await store.getConnection()).token).toBe("synthetic");
  expect((await store.getConnection()).profiles?.coding.approvedDestination).toBe(
    "operator_network",
  );
  await store.saveConnection({ url: "https://second.example", token: "", roles: {} });
  expect((await store.getConnection()).token).toBe("");
  expect((await store.getConnection()).profiles).toEqual({});
});

it("keeps the owner's search engine across connection changes, and checks its address", async () => {
  const store = new FileStore(await tempDir("dispatch-web-search-"));
  await store.init();
  await store.saveConnection({ url: "http://controller-a", token: "a", roles: {} });
  await store.saveWebSearch({ url: "http://127.0.0.1:8888/" });
  expect((await store.getConnection()).webSearch).toEqual({ url: "http://127.0.0.1:8888" });
  // A new controller keeps it: it is the owner's own engine, not the controller's.
  await store.saveConnection({ url: "http://controller-b", token: "b", roles: {} });
  expect((await store.getConnectionPublic()).webSearch).toEqual({ url: "http://127.0.0.1:8888" });
  await expect(store.saveWebSearch({ url: "ftp://nope" })).rejects.toThrow(/http/);
  await store.saveWebSearch(null);
  expect((await store.getConnection()).webSearch).toBeUndefined();
});
