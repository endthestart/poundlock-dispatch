/**
 * `/project-model`: a project's own Manager and Worker, saved by profile id
 * and shown by the name `/models` lists.
 */
import type { CatalogProfile } from "@shared/roles";
import type { ProjectPolicy } from "@shared/types";
import { projectModelCommand } from "@tui/project-model";
import { expect, it } from "vitest";

it("names the project's models, not their profile ids", () => {
  const catalog = [
    {
      id: "vega-qwen",
      name: "vega-qwen",
      profileId: "69dc56fd-196a",
      aliases: [],
      dataDestination: "operator_network",
    },
  ] as unknown as CatalogProfile[];
  const policy = { workerModel: "69dc56fd-196a" } as ProjectPolicy;
  expect(projectModelCommand(policy, "", catalog).notice).toBe(
    "This project's Manager: the app default. Worker: vega-qwen.",
  );
});
