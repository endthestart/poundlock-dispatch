import { readFile } from "node:fs/promises";
import { FileStore } from "@core/store";
import {
  defaultPermissions,
  effectiveToolTrust,
  localToolsAutoAllow,
  normalizePermissions,
  toolTrustLabel,
} from "@shared/permissions";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

describe("permission defaults", () => {
  it("defaults to ask and ignores unknown modes", () => {
    expect(defaultPermissions()).toEqual({ defaultMode: "ask" });
    expect(normalizePermissions(undefined).defaultMode).toBe("ask");
    expect(normalizePermissions({ defaultMode: "full" }).defaultMode).toBe("full");
    expect(normalizePermissions({ defaultMode: "nope" }).defaultMode).toBe("ask");
    expect(toolTrustLabel("assist")).toBe("Approve for me");
  });

  it("lets a project override the app default", () => {
    const app = { defaultMode: "ask" as const };
    expect(effectiveToolTrust(undefined, app)).toBe("ask");
    expect(effectiveToolTrust("full", app)).toBe("full");
  });

  it("never auto-allows off-box work, including full access", () => {
    expect(localToolsAutoAllow("full", "offbox")).toBe(false);
    expect(localToolsAutoAllow("full", "write")).toBe(true);
    expect(localToolsAutoAllow("ask", "write")).toBe(true);
    expect(localToolsAutoAllow("ask", "bash")).toBe(false);
    expect(localToolsAutoAllow("assist", "read")).toBe(true);
    expect(localToolsAutoAllow("assist", "bash")).toBe(false);
  });

  it("keeps the machine's default with the machine and per-project grants with the project", async () => {
    const root = await tempDir("dispatch-perm-");
    const store = new FileStore(root);
    await store.init();
    expect(await store.getPermissions()).toEqual({ defaultMode: "ask" });
    await store.savePermissions({
      defaultMode: "assist",
      grants: { "proj-1": [{ kind: "bash", action: "npm test", cwd: "/tmp/x" }] },
    });
    expect(await store.getPermissions()).toEqual({
      defaultMode: "assist",
      grants: { "proj-1": [{ kind: "bash", action: "npm test", cwd: "/tmp/x" }] },
    });

    // The default trust mode describes this machine, so every Dispatch client
    // reads one copy; grants are keyed by project and follow the projects.
    const defaults = JSON.parse(await readFile(store.layout.config.defaults, "utf8"));
    expect(defaults).toEqual({ defaultMode: "assist" });
    const local = JSON.parse(await readFile(store.layout.permissions, "utf8"));
    expect(Object.keys(local)).toEqual(["grants"]);
    expect(local.grants["proj-1"]).toHaveLength(1);
  });

  it("shares one default between two clients while their grants stay apart", async () => {
    const shared = await tempDir("dispatch-shared-config-");
    const desktop = new FileStore(await tempDir("dispatch-desktop-"), shared);
    const terminal = new FileStore(await tempDir("dispatch-terminal-"), shared);
    await desktop.init();
    await terminal.init();

    await desktop.savePermissions({
      defaultMode: "full",
      grants: { "desktop-project": [{ kind: "bash", action: "ls", cwd: "/tmp/d" }] },
    });
    const seen = await terminal.getPermissions();
    expect(seen.defaultMode).toBe("full");
    expect(seen.grants).toBeUndefined();
  });
});
