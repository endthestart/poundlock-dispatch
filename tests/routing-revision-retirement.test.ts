import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { retireLegacyRoutingRevision } from "@core/routing-revision-retirement";
import { FileStore } from "@core/store";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

async function storeWith(saved: unknown, mode = 0o600) {
  const root = await tempDir("dispatch-routing-revision-");
  const store = new FileStore(join(root, "data"), join(root, "config"));
  await store.init();
  const file = store.layout.config.connection;
  await writeFile(file, `${JSON.stringify(saved, null, 2)}\n`);
  await chmod(file, mode);
  return { store, file };
}

const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));

describe("retiring the saved bindings' legacy routingRevision", () => {
  it("drops the old field and keeps every other one, in the role map and the ladder", async () => {
    const { store, file } = await storeWith(
      {
        url: "http://controller",
        roles: {
          manager: {
            profileId: "m",
            profileName: "Manager",
            source: "interactive",
            lastApprovedRoutingRevision: "m1",
            routingRevision: "m1",
            approvedDataDestination: "operator_network",
            reasoning: "high",
          },
          interactive: { profileId: "w", profileName: "Worker", source: "interactive" },
        },
        escalation: {
          profiles: [
            {
              profileId: "e",
              profileName: "Esc",
              source: "interactive",
              lastApprovedRoutingRevision: "e1",
              routingRevision: "e1",
            },
          ],
          mode: "standing",
          maxTransitionsPerRun: 3,
        },
        webSearch: { url: "http://search" },
        note: "kept",
      },
      0o640,
    );
    await retireLegacyRoutingRevision(store);
    expect(await read(file)).toEqual({
      url: "http://controller",
      roles: {
        manager: {
          profileId: "m",
          profileName: "Manager",
          source: "interactive",
          lastApprovedRoutingRevision: "m1",
          approvedDataDestination: "operator_network",
          reasoning: "high",
        },
        interactive: { profileId: "w", profileName: "Worker", source: "interactive" },
      },
      escalation: {
        profiles: [
          {
            profileId: "e",
            profileName: "Esc",
            source: "interactive",
            lastApprovedRoutingRevision: "e1",
          },
        ],
        mode: "standing",
        maxTransitionsPerRun: 3,
      },
      webSearch: { url: "http://search" },
      note: "kept",
    });
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect((await store.getConnection()).roles.manager?.lastApprovedRoutingRevision).toBe("m1");
  });

  it("keeps the approval of a binding saved with only the old field", async () => {
    const { store, file } = await storeWith({
      url: "",
      roles: {
        verifier: {
          profileId: "v",
          profileName: "V",
          source: "interactive",
          routingRevision: "v1",
        },
      },
    });
    await retireLegacyRoutingRevision(store);
    expect((await read(file)).roles.verifier).toEqual({
      profileId: "v",
      profileName: "V",
      source: "interactive",
      lastApprovedRoutingRevision: "v1",
    });
  });

  it("leaves a file without the old field, or no file, untouched", async () => {
    const { store, file } = await storeWith({
      url: "",
      roles: { manager: { profileId: "m", profileName: "M", source: "interactive" } },
    });
    const before = await stat(file);
    await retireLegacyRoutingRevision(store);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect((await stat(file)).ino).toBe(before.ino);

    const empty = new FileStore(join(await tempDir("dispatch-routing-none-"), "data"));
    await expect(retireLegacyRoutingRevision(empty)).resolves.toBeUndefined();
  });
});
