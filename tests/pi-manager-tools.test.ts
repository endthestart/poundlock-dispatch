import { buildTools, MANAGER_TOOLS, TERMINATING_MANAGER_TOOLS } from "@runtime/pi-manager";
import { expect, it } from "vitest";

it("enables every manager tool it defines, so none is invisible to the model", async () => {
  const pi = await import("@earendil-works/pi-coding-agent");
  const defined = buildTools(pi, { host: {} as never }).map((tool) => tool.name);
  const enabled: readonly string[] = MANAGER_TOOLS;
  expect(defined.filter((name) => !enabled.includes(name))).toEqual([]);
  expect(TERMINATING_MANAGER_TOOLS.filter((name) => !enabled.includes(name))).toEqual([]);
  expect(enabled).toContain("request_folder_access");
});

it("holds changes that last until the owner agrees, once a turn has read web content", async () => {
  const pi = await import("@earendil-works/pi-coding-agent");
  const calls: string[] = [];
  const host = {
    delegateTask: async () => calls.push("delegate") && "Task added.",
    writeBrief: async () => calls.push("brief") && "Brief saved.",
    writeNotes: async () => calls.push("notes") && "Notes saved.",
    waiveRequirement: async () => calls.push("waive") && "Waived.",
  };
  const guard = { read: true };
  const tools = buildTools(pi, { host: host as never }, guard);
  const run = async (name: string, params: Record<string, unknown>) => {
    const tool = tools.find((item) => item.name === name) as unknown as {
      execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    return (await tool.execute("call", params)).content[0].text;
  };
  for (const [name, params] of [
    ["delegate_task", { title: "t" }],
    ["update_project_brief", { brief: "b" }],
    ["write_notes", { notes: "n" }],
    ["waive_requirement", { id: "R1", ownerWords: "drop it" }],
  ] as const)
    expect(await run(name, params)).toContain("read web content");
  expect(calls).toEqual([]);
  // A turn that read nothing from the web changes them as before.
  guard.read = false;
  expect(await run("write_notes", { notes: "n" })).toBe("Notes saved.");
  expect(calls).toEqual(["notes"]);
});
