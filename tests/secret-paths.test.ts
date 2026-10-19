import { SENSITIVE_EXCLUSIONS } from "@runtime/sandbox-policy";
import { SECRET_PATHS } from "@shared/secret-paths";
import { DEFAULT_EXCLUSIONS } from "@shared/types";
import { expect, it } from "vitest";

it("keeps snapshots and the sandbox on one list of secret paths", () => {
  for (const path of SECRET_PATHS) {
    expect(DEFAULT_EXCLUSIONS, path).toContain(path);
    expect(SENSITIVE_EXCLUSIONS, path).toContain(path);
  }
  for (const path of [".kube/", ".docker/", "**/.aws/credentials", "**/secrets/**"])
    expect(SECRET_PATHS).toContain(path);
});
