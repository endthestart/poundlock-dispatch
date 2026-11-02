/**
 * `/models <profile>`: the role page's detail about one model, as lines.
 */
import type { CatalogProfile } from "@shared/roles";
import { modelDetailLines, modelListRows } from "@tui/model-detail";
import { expect, it } from "vitest";

it("names the served model, its price as an estimate, and a profile out of service", () => {
  const lines = modelDetailLines({
    id: "frontier",
    name: "frontier-gpt-sol",
    aliases: [],
    dataDestination: "external",
    servedModel: "openai/gpt-sol",
    pricing: { inputPerMtok: 1.25, outputPerMtok: 10, source: "openrouter_catalog" },
    status: "disabled",
    disabled: { reason: "three failed probes", source: "probe", since: "2026-10-28" },
  } as unknown as CatalogProfile);
  expect(lines).toContain("  Served by openai/gpt-sol");
  expect(lines).toContain(
    "  About $1.25 in / $10.00 out per million tokens (OpenRouter catalog; an estimate, not a bill)",
  );
  expect(lines).toContain("  Poundlock took this profile out of service: three failed probes");
});

it("lists long names in their own column and every role a profile holds", () => {
  const profile = (name: string, dataDestination: string) =>
    ({ id: name, name, aliases: [], dataDestination }) as unknown as CatalogProfile;
  const rows = modelListRows(
    [
      profile("hub-qwen2.5-coder-3b-instruct-q8", "operator_network"),
      profile("frontier-gpt-sol", "external"),
    ],
    { manager: { profileId: "frontier-gpt-sol" }, interactive: { profileId: "frontier-gpt-sol" } },
  );
  expect(rows[0]).toMatch(/^ {2}hub-qwen2\.5-coder-3b-instruct-q8 {2,}operator_network$/);
  expect(rows[1]).toContain("← manager, interactive");
  expect(rows[1].indexOf("external")).toBe(rows[0].indexOf("operator_network"));
});
