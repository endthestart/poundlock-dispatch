import { describe, expect, it } from "vitest";
import { dropGitLocation, GIT_LOCATION_VARIABLES } from "./support/git-env";

describe("tests never inherit a repository location", () => {
  it("drops every location variable and config pair, and nothing else", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", GIT_CONFIG_GLOBAL: "/dev/null" };
    for (const name of GIT_LOCATION_VARIABLES) env[name] = "/somewhere/.git";
    env.GIT_CONFIG_KEY_0 = "core.bare";
    env.GIT_CONFIG_VALUE_0 = "true";
    dropGitLocation(env);
    expect(env).toEqual({ PATH: "/usr/bin", GIT_CONFIG_GLOBAL: "/dev/null" });
  });

  it("runs before the tests, so this process carries none", () => {
    for (const name of GIT_LOCATION_VARIABLES) expect(process.env[name], name).toBeUndefined();
  });
});
