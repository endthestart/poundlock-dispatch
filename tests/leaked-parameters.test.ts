import { splitLeakedParameters } from "@shared/leaked-parameters";
import { expect, it } from "vitest";

it("ends a question at a leaked parameter tag and keeps options that parse", () => {
  const leaked = `Which input formats?</parameter>
<parameter=options>
[{"label": "TIFF only", "description": "Simpler"}, {"label": "TIFF and PNG"}]`;
  expect(splitLeakedParameters(leaked, undefined)).toEqual({
    question: "Which input formats?",
    options: [{ label: "TIFF only", description: "Simpler" }, { label: "TIFF and PNG" }],
  });
  // Options given properly win; unparseable leftovers are dropped, never shown.
  expect(splitLeakedParameters("Go?</parameter><parameter=options>[oops", undefined)).toEqual({
    question: "Go?",
  });
  expect(splitLeakedParameters("Plain question?", undefined)).toEqual({
    question: "Plain question?",
  });
});
