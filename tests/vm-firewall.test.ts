import { colimaProfileOf, vmFirewallCommand, vmFirewallFix } from "@core/auto/vm-firewall";
import { expect, it } from "vitest";

it("names the VM a run actually uses in the firewall command", () => {
  expect(colimaProfileOf("colima-dispatch-test-2")).toBe("dispatch-test-2");
  expect(colimaProfileOf("colima")).toBe("default");
  expect(colimaProfileOf(undefined)).toBe("dispatch-auto");
  expect(vmFirewallFix("colima-dispatch-test")).toBe(vmFirewallCommand("dispatch-test"));
  // Not a colima VM: no colima command, the rules to run inside it instead.
  expect(colimaProfileOf("orbstack")).toBeUndefined();
  expect(vmFirewallFix("orbstack")).toMatch(
    /^inside the VM behind Docker context orbstack, as root: sh -c '/,
  );
});
