import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyData } from "@core/brand-migration";
import { describe, expect, it } from "vitest";

describe("Dispatch data migration", () => {
  it("preserves credentials, project history and frozen requests while retaining the original", () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-migration-test-"));
    const old = join(root, "Lockkeep"),
      next = join(root, "Poundlock Dispatch");
    mkdirSync(join(old, "projects", "one"), { recursive: true });
    writeFileSync(join(old, "connection.secret.json"), '{"token":"fixture-only"}', { mode: 0o600 });
    const history = '{"idempotencyKey":"lockkeep:original","path":"/unchanged/workspace"}';
    writeFileSync(join(old, "projects", "one", "tasks.json"), history);
    expect(migrateLegacyData(old, next)).toBe(true);
    expect(readFileSync(join(next, "connection.secret.json"), "utf8")).toBe(
      '{"token":"fixture-only"}',
    );
    expect(readFileSync(join(next, "projects", "one", "tasks.json"), "utf8")).toBe(history);
    expect(readFileSync(join(old, "projects", "one", "tasks.json"), "utf8")).toBe(history);
    writeFileSync(join(next, "connection.secret.json"), "new-settings");
    expect(migrateLegacyData(old, next)).toBe(false);
    expect(readFileSync(join(next, "connection.secret.json"), "utf8")).toBe("new-settings");
  });
  it("recovers from an interrupted staging copy without promoting its partial content", () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-interrupted-"));
    const old = join(root, "old"),
      next = join(root, "next"),
      stale = join(root, ".dispatch-migration-interrupted");
    mkdirSync(old);
    mkdirSync(stale);
    writeFileSync(join(old, "projects.json"), "complete");
    writeFileSync(join(stale, "projects.json"), "partial");
    expect(migrateLegacyData(old, next)).toBe(true);
    expect(readFileSync(join(next, "projects.json"), "utf8")).toBe("complete");
    expect(existsSync(stale)).toBe(true);
    expect(readFileSync(join(old, "projects.json"), "utf8")).toBe("complete");
  });
  it("supports fresh installs and an empty destination without overwriting existing data", () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch-fresh-test-"));
    const old = join(root, "old"),
      next = join(root, "next");
    expect(migrateLegacyData(old, next)).toBe(false);
    mkdirSync(old);
    mkdirSync(next);
    writeFileSync(join(old, "projects.json"), "[]");
    expect(migrateLegacyData(old, next)).toBe(true);
    expect(readFileSync(join(next, "projects.json"), "utf8")).toBe("[]");
  });
});
