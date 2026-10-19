/**
 * The command registry's argument completions: pure functions, so they are
 * tested directly rather than through a real editor and autocomplete popover.
 * `argumentText` here is exactly what pi-tui's `CombinedAutocompleteProvider`
 * passes — everything after the command name and one space, not just the
 * word under the cursor — which is why each of these has to notice for
 * itself whether it is still completing the first argument.
 */
import {
  COMMAND_DEFS,
  grantArgumentCompletions,
  reasoningArgumentCompletions,
  roleArgumentCompletions,
  toSlashCommands,
  trustArgumentCompletions,
} from "@tui/commands";
import { describe, expect, it } from "vitest";

describe("roleArgumentCompletions", () => {
  it("suggests roles by prefix", () => {
    const items = roleArgumentCompletions("man");
    expect(items?.map((item) => item.value)).toContain("manager");
  });

  it("suggests nothing once a profile name is being typed", () => {
    expect(roleArgumentCompletions("manager front")).toBeNull();
  });

  it("suggests nothing for a prefix that matches no role", () => {
    expect(roleArgumentCompletions("wizard")).toBeNull();
  });
});

describe("reasoningArgumentCompletions", () => {
  it("offers the reasoning levels and default", () => {
    const items = reasoningArgumentCompletions("")?.map((item) => item.value);
    expect(items).toContain("high");
    expect(items).toContain("default");
  });
});

describe("trustArgumentCompletions", () => {
  it("offers the trust modes and default", () => {
    const items = trustArgumentCompletions("a")?.map((item) => item.value);
    expect(items).toContain("assist");
    expect(items).not.toContain("full");
  });
});

describe("grantArgumentCompletions", () => {
  it("suggests nothing until a path and a space are typed", () => {
    expect(grantArgumentCompletions("./worktree")).toBeNull();
  });

  it("suggests read/write once the path is typed", () => {
    const items = grantArgumentCompletions("./worktree w")?.map((item) => item.value);
    expect(items).toEqual(["write"]);
  });
});

describe("toSlashCommands", () => {
  it("strips the leading slash pi-tui does not expect", () => {
    const [first] = toSlashCommands(COMMAND_DEFS);
    expect(first.name.startsWith("/")).toBe(false);
  });

  it("names every command exactly once", () => {
    const names = toSlashCommands(COMMAND_DEFS).map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("/compact", () => {
  it("is listed with a hint that it takes instructions", () => {
    const compact = COMMAND_DEFS.find((command) => command.name === "/compact");
    expect(compact?.argumentHint).toBe("[instructions]");
    expect(compact?.description).toMatch(/Summarise .* older messages/);
  });
});
