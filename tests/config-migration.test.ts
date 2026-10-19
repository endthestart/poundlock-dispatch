/**
 * Moving this machine's Poundlock connection into the config directory every
 * client reads. An existing desktop install holds the only copy of the
 * controller URL and its token, so getting this wrong means a terminal session
 * demanding all of it again — or, worse, two copies drifting apart.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrateSharedConfig } from "@core/config-migration";
import { layoutFor } from "@core/paths";
import { FileStore } from "@core/store";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

async function legacyInstall(options?: { permissions?: unknown }) {
  const root = await tempDir("dispatch-config-migration-");
  const shared = await tempDir("dispatch-shared-config-");
  await writeFile(
    join(root, "connection.json"),
    JSON.stringify({
      url: "https://poundlock.example",
      roles: { manager: { profileId: "m", profileName: "m", source: "interactive" } },
    }),
  );
  await writeFile(join(root, "connection.secret.json"), JSON.stringify({ token: "secret-token" }));
  if (options?.permissions)
    await writeFile(join(root, "permissions.json"), JSON.stringify(options.permissions));
  return { root, shared, layout: layoutFor(root, shared) };
}

describe("shared config migration", () => {
  it("moves the connection and its token, leaving no second copy behind", async () => {
    const { layout } = await legacyInstall();
    expect(migrateSharedConfig(layout)).toBe(true);

    const store = new FileStore(layout.root, layout.config.root);
    const connection = await store.getConnection();
    expect(connection.url).toBe("https://poundlock.example");
    expect(connection.token).toBe("secret-token");
    expect(connection.roles.manager?.profileId).toBe("m");
    await expect(readFile(join(layout.root, "connection.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(layout.root, "connection.secret.json"), "utf8")).rejects.toThrow();
  });

  it("splits the machine default from the grants that name projects", async () => {
    const { layout } = await legacyInstall({
      permissions: {
        defaultMode: "assist",
        grants: { "proj-1": [{ kind: "bash", action: "npm test", cwd: "/tmp/x" }] },
      },
    });
    migrateSharedConfig(layout);

    const defaults = JSON.parse(await readFile(layout.config.defaults, "utf8"));
    expect(defaults).toEqual({ defaultMode: "assist" });
    const local = JSON.parse(await readFile(layout.permissions, "utf8"));
    expect(Object.keys(local)).toEqual(["grants"]);

    // Read back through the store: the split must be invisible to callers.
    const store = new FileStore(layout.root, layout.config.root);
    expect(await store.getPermissions()).toEqual({
      defaultMode: "assist",
      grants: { "proj-1": [{ kind: "bash", action: "npm test", cwd: "/tmp/x" }] },
    });
  });

  it("runs once and never overwrites a config directory that already has one", async () => {
    const { layout } = await legacyInstall();
    expect(migrateSharedConfig(layout)).toBe(true);
    expect(migrateSharedConfig(layout)).toBe(false);

    // A second client with its own data must not overwrite the shared copy.
    const other = await tempDir("dispatch-other-client-");
    await writeFile(join(other, "connection.json"), JSON.stringify({ url: "https://wrong" }));
    expect(migrateSharedConfig(layoutFor(other, layout.config.root))).toBe(false);
    const store = new FileStore(layout.root, layout.config.root);
    expect((await store.getConnection()).url).toBe("https://poundlock.example");
  });

  it("does nothing for a client that never had a connection of its own", async () => {
    const root = await tempDir("dispatch-fresh-");
    const shared = await tempDir("dispatch-fresh-config-");
    expect(migrateSharedConfig(layoutFor(root, shared))).toBe(false);
  });
});

describe("a terminal client starting before the desktop app has migrated", () => {
  it("takes the connection from the desktop app's data directory", async () => {
    const desktop = await tempDir("dispatch-desktop-install-");
    const shared = await tempDir("dispatch-shared-");
    const terminal = await tempDir("dispatch-terminal-");
    await writeFile(
      join(desktop, "connection.json"),
      JSON.stringify({ url: "https://poundlock.example", roles: {} }),
    );
    await writeFile(join(desktop, "connection.secret.json"), JSON.stringify({ token: "t" }));
    await writeFile(join(desktop, "permissions.json"), JSON.stringify({ defaultMode: "assist" }));

    const layout = layoutFor(terminal, shared);
    // Nothing of its own to migrate, so it looks where the connection is.
    expect(migrateSharedConfig(layout)).toBe(false);
    expect(migrateSharedConfig(layout, desktop)).toBe(true);

    const store = new FileStore(terminal, shared);
    expect((await store.getConnection()).token).toBe("t");
    expect((await store.getPermissions()).defaultMode).toBe("assist");

    // The desktop app now reads the same shared copy, and its own projects
    // and grants were left where they are.
    const gui = new FileStore(desktop, shared);
    expect((await gui.getConnection()).url).toBe("https://poundlock.example");
    await expect(readFile(join(desktop, "connection.json"), "utf8")).rejects.toThrow();
    expect(JSON.parse(await readFile(join(desktop, "permissions.json"), "utf8"))).toEqual({
      defaultMode: "assist",
    });
  });
});
