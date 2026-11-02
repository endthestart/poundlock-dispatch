import { permissionLabel, rememberPermissionLabels } from "@shared/types";
import { expect, it } from "vitest";

it("names a permission by the controller's label, even when a capability list is empty", () => {
  // UX review, 30 Oct: an empty token_permissions list hid the remembered labels.
  rememberPermissionLabels([
    { code: "external:invoke", label: "Send prompts and files to external services" },
  ]);
  expect(permissionLabel("external:invoke", { token_permissions: [] })).toBe(
    "Send prompts and files to external services",
  );
  expect(
    permissionLabel("external:invoke", {
      token_permissions: [{ code: "external:invoke", label: "External models" }],
    }),
  ).toBe("External models");
  expect(permissionLabel("jobs:read", { token_permissions: [] })).toBe("jobs:read");
});
