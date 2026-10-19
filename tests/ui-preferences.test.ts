/**
 * Composer status chips are added over time. A preferences file saved before a
 * chip existed has never offered it, so the owner could not have turned it off:
 * it is on. A chip the owner turned off in a file that knew it stays off.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { FileStore } from "@core/store";
import {
  DEFAULT_UI_PREFERENCES,
  readSavedUiPreferences,
  savedUiPreferences,
  UI_PREFERENCES_VERSION,
} from "@shared/ui-preferences";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

describe("reading a saved preferences file", () => {
  it("adds a chip introduced after the file was saved, to a file from before versions", () => {
    // What the owner's Appearance page wrote before the context chip existed.
    const old = { composerInfolets: ["budget"], desktopNotifications: true };
    expect(readSavedUiPreferences(old)).toEqual({
      composerInfolets: ["budget", "context"],
      desktopNotifications: true,
    });
  });

  it("does not bring back a chip that file turned off, only the new one", () => {
    const old = { composerInfolets: [], desktopNotifications: false };
    expect(readSavedUiPreferences(old).composerInfolets).toEqual(["context"]);
  });

  it("leaves a chip off that the owner turned off in a file that already knew it", () => {
    const current = {
      version: UI_PREFERENCES_VERSION,
      composerInfolets: ["budget"],
      desktopNotifications: false,
    };
    expect(readSavedUiPreferences(current).composerInfolets).toEqual(["budget"]);
    expect(readSavedUiPreferences({ ...current, composerInfolets: [] }).composerInfolets).toEqual(
      [],
    );
  });

  it("uses the defaults when there is no file, and ignores a file that is not an object", () => {
    expect(readSavedUiPreferences(undefined)).toEqual(DEFAULT_UI_PREFERENCES);
    expect(readSavedUiPreferences(null)).toEqual(DEFAULT_UI_PREFERENCES);
    expect(readSavedUiPreferences("nope")).toEqual(DEFAULT_UI_PREFERENCES);
  });

  it("drops chips it does not know, and keeps the version out of the preferences it returns", () => {
    const read = readSavedUiPreferences({
      version: UI_PREFERENCES_VERSION,
      composerInfolets: ["budget", "sparkles"],
      desktopNotifications: false,
    });
    expect(read.composerInfolets).toEqual(["budget"]);
    expect(read).not.toHaveProperty("version");
  });

  it("stamps what it writes with the current version", () => {
    expect(savedUiPreferences(DEFAULT_UI_PREFERENCES).version).toBe(UI_PREFERENCES_VERSION);
  });
});

describe("the preferences file on disk", () => {
  async function storeWith(file?: unknown) {
    const root = await tempDir("dispatch-ui-prefs-");
    const store = new FileStore(root);
    await store.init();
    if (file !== undefined) {
      await mkdir(dirname(store.layout.ui), { recursive: true });
      await writeFile(store.layout.ui, JSON.stringify(file));
    }
    return store;
  }

  it("shows an owner who saved Appearance before the context chip the chip, without rewriting their file", async () => {
    const old = { composerInfolets: ["budget"], desktopNotifications: true };
    const store = await storeWith(old);
    expect(await store.getUiPreferences()).toEqual({
      composerInfolets: ["budget", "context"],
      desktopNotifications: true,
    });
    expect(JSON.parse(await readFile(store.layout.ui, "utf8"))).toEqual(old);
  });

  it("keeps a chip off once the owner has turned it off, across reads", async () => {
    const store = await storeWith({ composerInfolets: ["budget"], desktopNotifications: true });
    const shown = await store.getUiPreferences();
    // The owner unticks the new chip on the Appearance page, which saves the lot.
    await store.saveUiPreferences({
      ...shown,
      composerInfolets: shown.composerInfolets.filter((id) => id !== "context"),
    });
    expect(JSON.parse(await readFile(store.layout.ui, "utf8")).version).toBe(
      UI_PREFERENCES_VERSION,
    );
    expect((await store.getUiPreferences()).composerInfolets).toEqual(["budget"]);
    expect((await store.getUiPreferences()).composerInfolets).toEqual(["budget"]);
  });

  it("keeps the new chip when only another preference is saved", async () => {
    const store = await storeWith({ composerInfolets: ["budget"], desktopNotifications: false });
    const shown = await store.getUiPreferences();
    await store.saveUiPreferences({ ...shown, desktopNotifications: true });
    expect(await store.getUiPreferences()).toEqual({
      composerInfolets: ["budget", "context"],
      desktopNotifications: true,
    });
  });

  it("starts a new install with every chip", async () => {
    const store = await storeWith();
    expect(await store.getUiPreferences()).toEqual(DEFAULT_UI_PREFERENCES);
  });
});
