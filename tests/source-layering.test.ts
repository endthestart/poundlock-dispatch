/**
 * The dependency direction that lets more than one front end share one manager.
 *
 * ADR 001 defines the shared runtime behaviourally — "project state,
 * manager/worker lifecycle, policies, approvals, events, persistence and API
 * integration must keep working without Electron or React" — which is a
 * property of who imports whom. It held by discipline and nothing enforced it,
 * so a single stray import could have quietly ended it. This is that
 * enforcement, and it exists before the Pi adapters move out of `src/main` so
 * the move cannot break it unnoticed.
 */
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

function sourceFiles(directory: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(SRC, directory), { withFileTypes: true });
  } catch (error) {
    // A layer that does not exist yet has no imports to police.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

/**
 * Every module specifier this file imports from, including dynamic imports.
 *
 * Type-only references are removed first. `import type { X } from "y"` and
 * `import("y").X` erase at compile time, so they cannot make a layer stop
 * working — and the property being policed is exactly "still works without
 * that layer". A value import of the same module would not be removed.
 */
function importsOf(relative: string): string[] {
  const text = readFileSync(join(SRC, relative), "utf8")
    .replace(/\bimport\s+type\s[^;]*?;/gs, "")
    .replace(/\btypeof\s+import\s*\(\s*["'][^"']+["']\s*\)/g, "")
    .replace(/\bimport\s*\(\s*["'][^"']+["']\s*\)\s*\./g, "");
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g))
    specifiers.push(match[1]);
  return specifiers;
}

function offenders(directory: string, disallowed: (specifier: string) => boolean) {
  return sourceFiles(directory)
    .map((file) => ({ file, bad: importsOf(file).filter(disallowed) }))
    .filter((entry) => entry.bad.length > 0)
    .map((entry) => `src/${entry.file}: ${entry.bad.join(", ")}`);
}

const electron = (specifier: string) => specifier === "electron";
const node = (specifier: string) => specifier.startsWith("node:");
const upward = (specifier: string) =>
  /(^|\/)(main|renderer|preload)\//.test(specifier) ||
  specifier.startsWith("@renderer/") ||
  /(^|\/)(main|renderer|preload)$/.test(specifier);
/** `core` decides policy; `runtime` runs it. Only one of those may name the other. */
const runtimeLayer = (specifier: string) => specifier.startsWith("@runtime/");
/** `shared` is the bottom: pure derivations any presentation can build on. */
const belowShared = (specifier: string) =>
  specifier.startsWith("@core/") || specifier.startsWith("@runtime/");

describe("source layering", () => {
  it("finds source to police", () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(sourceFiles("core").length).toBeGreaterThan(30);
    expect(sourceFiles("shared").length).toBeGreaterThan(15);
    expect(sourceFiles("runtime").length).toBeGreaterThan(5);
  });

  it("keeps Electron out of every layer a second front end links", () => {
    for (const layer of ["core", "shared", "runtime", "tui"])
      expect(offenders(layer, electron), `src/${layer} must not import electron`).toEqual([]);
  });

  it("keeps shared free of host APIs so any presentation can derive from it", () => {
    expect(offenders("shared", node)).toEqual([]);
  });

  it("points every layer's imports downward, never at a host", () => {
    for (const layer of ["core", "shared", "runtime", "tui"])
      expect(offenders(layer, upward), `src/${layer} must not import a host`).toEqual([]);
  });

  it("keeps core deciding policy and runtime running it, not the other way round", () => {
    // The guard only looked for Electron, so it read clean while
    // `orchestration.ts` imported three runtime modules directly — the exact
    // direction it exists to stop. A host concern reaches the orchestrator
    // through `OrchestratorDeps`, the way the worker and the clock already do.
    expect(offenders("core", runtimeLayer), "src/core must not import @runtime").toEqual([]);
  });

  it("keeps shared at the bottom, depending on nothing above it", () => {
    expect(offenders("shared", belowShared)).toEqual([]);
  });

  it("detects a violation rather than passing vacuously", () => {
    expect(runtimeLayer("@runtime/host-command")).toBe(true);
    // A value import is caught; the erased type reference beside it is not.
    expect(importsOf("core/orchestration.ts")).not.toContain("@runtime/host-command");
    expect(importsOf("main/index.ts")).toContain("@runtime/host-command");
    expect(runtimeLayer("@core/orchestration")).toBe(false);
    expect(belowShared("@core/ids")).toBe(true);
    expect(belowShared("@shared/types")).toBe(false);
    expect(electron("electron")).toBe(true);
    expect(node("node:fs")).toBe(true);
    expect(upward("../main/pi-worker")).toBe(true);
    expect(upward("@renderer/App")).toBe(true);
    expect(upward("./main")).toBe(true);
    expect(upward("@shared/types")).toBe(false);
    expect(upward("@core/orchestration")).toBe(false);
    // "domain" must not trip the (main|renderer|preload) word match.
    expect(upward("@core/domain/thing")).toBe(false);
  });
});
