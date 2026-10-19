import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProjectFromFiles, ProjectOrchestrator } from "@core/orchestration";
import { PoundlockClient } from "@core/poundlock";
import { ScriptedManager } from "@core/scripted-manager";
import { FileStore } from "@core/store";
import { hostCommandPort } from "@runtime/host-command";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

/**
 * Live proofs through the same Dispatch orchestrator + Poundlock client the GUI uses.
 * Skip unless POUNDLOCK_URL and POUNDLOCK_TOKEN are set. Do not point these at recipe-box.
 */
const url = process.env.POUNDLOCK_URL;
const token = process.env.POUNDLOCK_TOKEN;
const run = url && token ? it : it.skip;

async function liveStore() {
  const data = await tempDir("dispatch-live-uc-");
  const store = new FileStore(data);
  await store.init();
  return store;
}

describe("live Dispatch use cases (Poundlock backend)", () => {
  run(
    "U1 discussion only lists profiles through Poundlock and does not start work",
    async () => {
      const client = new PoundlockClient(url!, token!);
      const probe = await client.probe();
      expect(probe.ok, probe.error).toBe(true);
      expect(probe.interactiveModels.length).toBeGreaterThan(0);
      const store = await liveStore();
      let listed = 0;
      const manager = new ScriptedManager(async (ctx) => {
        listed = (await ctx.host.listProfiles()).length;
        return "Listed advertised profiles. No plan.";
      });
      const orchestrator = new ProjectOrchestrator({
        hostCommands: hostCommandPort,
        store,
        clientFor: async () => client,
        manager,
        worker: {
          async run() {
            throw new Error("A discussion starts no work.");
          },
        },
      });
      const project = await createProjectFromFiles({
        store,
        name: "u1-live",
        files: [{ path: "README.md", content: Buffer.from("u1\n"), executable: false }],
        source: {
          kind: "local_folder",
          originalPath: dataRoot(store),
          capturedAt: new Date().toISOString(),
          snapshotSha256: "u1",
          baseRevision: "",
          includedFiles: 1,
          includedBytes: 3,
          excludedPatterns: [],
          includedUncommitted: true,
          originalFingerprint: "u1",
        },
      });
      await orchestrator.sendMessage(project.id, "What models are advertised? Do not plan.");
      expect(listed).toBeGreaterThan(0);
      expect(await store.getTasks(project.id)).toEqual([]);
      expect(await store.getPlan(project.id)).toBeUndefined();
    },
    120_000,
  );

  run(
    "U3 live catalog has a frontier manager and a local interactive worker",
    async () => {
      const client = new PoundlockClient(url!, token!);
      const probe = await client.probe();
      expect(probe.ok, probe.error).toBe(true);
      const local = probe.interactiveModels.find(
        (model) => model.dataDestination === "operator_network" || !model.dataDestination,
      );
      const frontier = probe.interactiveModels.find(
        (model) => model.dataDestination === "external" || /frontier/i.test(model.name ?? model.id),
      );
      expect(local, "need a local interactive profile").toBeTruthy();
      expect(frontier, "need a frontier/external manager profile").toBeTruthy();
      expect(local!.id).not.toBe(frontier!.id);
    },
    60_000,
  );

  run(
    "U2 interactive worker goes through Poundlock /v1 (prepare_profile) into the attached folder",
    async () => {
      const client = new PoundlockClient(url!, token!);
      const probe = await client.probe();
      expect(probe.ok, probe.error).toBe(true);
      const interactive = probe.interactiveModels.find(
        (model) =>
          model.workload_class !== "fast-code-completion" && (model.context_tokens ?? 0) >= 4096,
      );
      expect(interactive, "need an interactive coding profile").toBeTruthy();
      const root = await tempDir("dispatch-live-u2-");
      const folder = join(root, "project");
      await mkdir(folder);
      await writeFile(join(folder, "README.md"), "u2 live\n");
      const store = new FileStore(join(root, "data"));
      await store.init();
      await store.saveConnection({
        url: url!,
        token: token!,
        roles: {
          manager: {
            profileId: interactive!.id,
            profileName: interactive!.name ?? interactive!.id,
            source: "interactive",
          },
          interactive: {
            profileId: interactive!.id,
            profileName: interactive!.name ?? interactive!.id,
            source: "interactive",
          },
        },
      });
      const { createPiWorker } = await import("@runtime/pi-worker");
      const { ApprovalBroker } = await import("@core/approval-broker");
      const { createFolderProject } = await import("@core/projects");
      const project = await createFolderProject({
        store,
        folder,
        policy: { toolTrust: "full" },
      });
      const command = "node --test";
      const orchestrator = new ProjectOrchestrator({
        hostCommands: hostCommandPort,
        store,
        clientFor: async () => client,
        approvals: new ApprovalBroker(),
        worker: createPiWorker(),
        manager: {
          async runTurn(ctx) {
            const tasks = await store.getTasks(ctx.project.id);
            if (!tasks.length) {
              await ctx.host.proposePlan({
                summary: "Write live-u2.txt",
                acceptanceCriteria: ["live-u2.txt exists"],
                tasks: [
                  {
                    title: "Write live-u2.txt",
                    objective: "Create live-u2.txt containing ok",
                    workerPrompt: "Create live-u2.txt containing exactly: ok",
                    acceptanceCriteria: "file exists",
                    difficulty: "small",
                    route: "interactive",
                  },
                ],
              });
            } else if (tasks[0].status === "needs_review") {
              const last = tasks[0].attempts.at(-1);
              if (last?.failureClass === "infrastructure") {
                throw new Error(
                  last.error ||
                    "Interactive worker could not prepare its Poundlock profile. The controller did not admit /v1.",
                );
              }
              await ctx.host.requestApplyResult(tasks[0].id);
            } else if (tasks.every((task) => task.status === "applied")) {
              await ctx.host.markComplete("Verified");
            }
            return { text: "Recorded", toolTrace: [] };
          },
        },
      });
      await orchestrator.sendMessage(project.id, "Write live-u2.txt");
      await orchestrator.approvePlan(project.id);
      await orchestrator.start(project.id);
      const deadline = Date.now() + 12 * 60 * 1000;
      while (Date.now() < deadline) {
        const current = await store.getProject(project.id);
        if (current?.status === "completed" || current?.status === "failed") break;
        const tasks = await store.getTasks(project.id);
        const last = tasks[0]?.attempts.at(-1);
        if (last?.failureClass === "infrastructure") {
          throw new Error(
            last.error ||
              "Poundlock returned infrastructure_unavailable while preparing the interactive worker.",
          );
        }
        await orchestrator.tick(project.id);
        await orchestrator.waitForLocal(project.id).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      const tasks = await store.getTasks(project.id);
      expect(tasks[0]?.attempts[0]?.execution).toBe("interactive");
      expect(tasks[0]?.attempts[0]?.failureClass).not.toBe("infrastructure");
      expect(
        await import("node:fs/promises").then((fs) =>
          fs.readFile(join(folder, "live-u2.txt"), "utf8"),
        ),
      ).toMatch(/ok/);
    },
    15 * 60 * 1000,
  );
});

function dataRoot(store: FileStore): string {
  return store.layout.root;
}
