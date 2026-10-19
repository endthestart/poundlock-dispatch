import { roleResolutionNeedsInputKind } from "@core/orchestration";
import { RoleIsolationError, RouteRevisionChangedError } from "@core/role-routing";
import { describe, expect, it } from "vitest";

describe("roleResolutionNeedsInputKind", () => {
  it("is route_change for a changed route, so the status view gives the specific Settings instruction", () => {
    expect(
      roleResolutionNeedsInputKind(
        new RouteRevisionChangedError("The route changed in Poundlock."),
      ),
    ).toBe("route_change");
  });

  it("is configuration for any other role/profile resolution failure", () => {
    expect(roleResolutionNeedsInputKind(new RoleIsolationError("Choose a worker model."))).toBe(
      "configuration",
    );
    expect(roleResolutionNeedsInputKind(new Error("something else"))).toBe("configuration");
    expect(roleResolutionNeedsInputKind("not even an Error")).toBe("configuration");
  });
});
