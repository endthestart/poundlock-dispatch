import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const script = "scripts/npm-audit-gate.cjs";
const fixture = (name: string) => `tests/fixtures/npm-audit/${name}`;
const load = (name: string) => JSON.parse(readFileSync(fixture(name), "utf8"));
const { gate, localDate } = createRequire(import.meta.url)(`../${script}`);

function run(audit: string, allow: string) {
  return spawnSync(process.execPath, [script, audit, allow], { encoding: "utf8" });
}

describe("the npm audit gate", () => {
  it("allows a listed advisory until the end of its expiry day, then fails it", () => {
    const report = load("report.json");
    const allow = load("allow.json");
    expect(gate(report, allow, "2026-10-21").failures).toEqual([]);
    expect(gate(report, allow, "2026-10-21").allowed).toEqual([
      "allowed until 2026-10-21: GHSA-aaaa-aaaa-aaaa (Pinned by a dependency's shrinkwrap.)",
      "allowed until 2999-12-31: GHSA-bbbb-bbbb-bbbb (Development dependency only.)",
    ]);
    expect(gate(report, allow, "2026-10-22").failures).toEqual([
      "npm advisory: GHSA-aaaa-aaaa-aaaa: exception expired 2026-10-21 (Quadratic expansion)",
    ]);
  });

  it("fails an advisory that is not listed", () => {
    const { failures } = gate(
      load("report.json"),
      { "GHSA-bbbb-bbbb-bbbb": load("allow.json")["GHSA-bbbb-bbbb-bbbb"] },
      "2026-10-01",
    );
    expect(failures).toEqual(["npm advisory: GHSA-aaaa-aaaa-aaaa: Quadratic expansion"]);
  });

  it("fails an exception without an expiry date or a reason", () => {
    const allow = load("allow-future.json");
    allow["GHSA-aaaa-aaaa-aaaa"] = { reason: "No date." };
    allow["GHSA-bbbb-bbbb-bbbb"] = { expires: "2999-12-31" };
    expect(gate(load("report.json"), allow, "2026-10-01").failures).toHaveLength(2);
  });

  it("fails when npm audit produced no report", () => {
    expect(gate(load("error.json"), {}, "2026-10-01").failures[0]).toMatch(
      /did not produce a report.*ENOAUDIT/,
    );
    expect(gate({}, {}, "2026-10-01").failures).toHaveLength(1);
  });

  it("passes a clean report with an empty allow list", () => {
    expect(gate(load("clean.json"), {}, "2026-10-01")).toEqual({ allowed: [], failures: [] });
  });

  it("formats today as the local calendar date", () => {
    expect(localDate(new Date(2026, 9, 1, 23, 30))).toBe("2026-10-01");
  });

  it("exits non-zero from the command line only when something is not allowed", () => {
    expect(run(fixture("report.json"), fixture("allow-future.json")).status).toBe(0);
    const failed = run(fixture("report.json"), fixture("clean.json"));
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("npm advisory: GHSA-bbbb-bbbb-bbbb: Host case normalization");
    expect(run(fixture("error.json"), fixture("allow-future.json")).status).toBe(1);
    expect(run(fixture("report.json"), "").status).toBe(2);
  });

  it("keeps every entry in the repository's allow file dated and explained", () => {
    const allow = JSON.parse(readFileSync("security/npm-audit-allow.json", "utf8"));
    for (const [advisory, entry] of Object.entries(allow) as [
      string,
      { expires: string; reason: string },
    ][]) {
      expect(advisory).toMatch(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
      expect(entry.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });
});
