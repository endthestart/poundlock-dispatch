import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ManagerToolHost } from "@core/orchestration";
import { PoundlockClient } from "@core/poundlock";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { createPiManager } from "@runtime/pi-manager";
import { expect, it, vi } from "vitest";
import { tempDir } from "./support/temp-dir";

const url = process.env.POUNDLOCK_URL;
const token = process.env.POUNDLOCK_TOKEN;
const model = process.env.POUNDLOCK_MANAGER_MODEL;
const run = url && token && model ? it : it.skip;

/**
 * Real manager turns on a live profile: a requested file is delegated; a
 * question is answered; a question about history it cannot read is
 * investigated, not planned.
 */
run.each([
  ["Generate an SVG of a pelican riding a bicycle", "delegates"],
  ["In two sentences, what is the difference between SVG and PNG for a logo?", "answers"],
  ["Review the changes in git diff 1a2b3c4..5d6e7f8 for bugs.", "investigates"],
] as const)(
  "the live manager, asked %j, %s",
  async (request, expected) => {
    const root = await tempDir("dispatch-live-delegation-");
    const folder = join(root, "project");
    await mkdir(folder);
    const store = new FileStore(join(root, "data"));
    await store.init();
    const project = await createFolderProject({ store, folder });
    const profile = (await new PoundlockClient(url!, token!).listInteractiveModels()).find(
      (item) => item.id === model,
    )!;
    const manager = await createPiManager({
      store,
      controllerUrl: url!,
      token: token!,
      modelName: profile.id,
      modelProfileId: profile.profileId,
      contextTokens: Math.min(profile.context_tokens ?? 32768, 131072),
      maxOutputTokens: Math.min(profile.max_output_tokens ?? 4096, 8192),
      dataDestination: profile.dataDestination,
      routingRevision: profile.routingRevision,
      lastApprovedRoutingRevision: profile.routingRevision,
      reasoningLevels: profile.reasoningLevels,
    });
    const host = {
      listFiles: vi.fn(async () => []),
      readFile: vi.fn(async () => ""),
      readNotes: vi.fn(async () => ""),
      writeNotes: vi.fn(async () => "Saved."),
      listProfiles: vi.fn(async () => []),
      delegateTask: vi.fn(async () => "Task recorded. Wait for the worker."),
      investigate: vi.fn(
        async () =>
          "Report from worker (read-only): the diff changes one line in app.py; no defects found.",
      ),
      proposePlan: vi.fn(async () => "Plan recorded. Wait for approval."),
      askUser: vi.fn(async () => "Waiting for the user."),
    } as unknown as ManagerToolHost;
    try {
      const result = await manager.runTurn({
        project,
        workspace: folder,
        prompt: `The user said:\n${request}`,
        host,
      });
      const tools = result.toolTrace.map((item) => item.name);
      console.log("tools", tools, "text chars", result.text.length);
      const delegated = tools.some((name) => ["delegate_task", "propose_plan"].includes(name));
      if (expected === "investigates") {
        expect(tools).toContain("investigate");
        expect(delegated).toBe(false);
      } else if (expected === "delegates") {
        expect(delegated || tools.includes("ask_user")).toBe(true);
        expect(result.text).not.toContain("<svg");
      } else {
        expect(delegated).toBe(false);
        expect(result.text.length).toBeGreaterThan(20);
      }
    } finally {
      await manager.abort?.(project.id);
    }
  },
  300_000,
);
