import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import type { WorkerContext, WorkerPort } from "@core/interactive-worker";
import { MemoryPoundlock } from "@core/memory-poundlock";
import { type ManagerPort, ProjectOrchestrator, type ProposePlanInput } from "@core/orchestration";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { hostCommandPort } from "@runtime/host-command";
import { workerBrief } from "@runtime/pi-worker";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

async function fixture() {
  const root = await realpath(await tempDir("dispatch-hints-"));
  const folder = join(root, "project");
  await mkdir(folder);
  const store = new FileStore(join(root, "data"));
  await store.init();
  await store.saveConnection({
    url: "http://fixture",
    token: "fixture",
    roles: {
      manager: { profileId: "coding", profileName: "coding", source: "interactive" },
      interactive: { profileId: "coding", profileName: "coding", source: "interactive" },
    },
  });
  const backend = new MemoryPoundlock();
  backend.listInteractiveModels = async () => [
    {
      id: "coding",
      context_tokens: 32768,
      max_output_tokens: 4096,
      dataDestination: "operator_network",
      workload_class: "interactive-coding",
    },
  ];
  const project = await createFolderProject({ store, folder });
  return { folder, store, backend, project };
}

const task = (extra: Partial<ProposePlanInput["tasks"][number]> = {}) => ({
  title: "Add slugs",
  objective: "Add URL slugs",
  workerPrompt: "Implement slugs and test them.",
  acceptanceCriteria: "Slugs are unique",
  difficulty: "small" as const,
  route: "interactive" as const,
  ...extra,
});

function proposing(input: ProposePlanInput): ManagerPort {
  return {
    async runTurn(ctx) {
      await ctx.host.proposePlan(input);
      return { text: "Here is a plan.", toolTrace: [] };
    },
  };
}

describe("the manager's hints reach the worker", () => {
  it("stores a task's note, files and reuse, and puts them in the brief of the worker that runs it", async () => {
    const f = await fixture();
    const contexts: WorkerContext[] = [];
    const worker: WorkerPort = {
      async run(ctx) {
        contexts.push(ctx);
        await writeFile(join(ctx.cwd, "slug.txt"), "x\n");
        return {
          output: "Done",
          changedFiles: ["slug.txt"],
          patch: "+x",
          verification: {
            status: "passed",
            commands: [{ command: "npm test", exitCode: 0, output: "ok" }],
          },
        };
      },
    };
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: proposing({
        summary: "Add slugs",
        acceptanceCriteria: ["Slugs work"],
        tasks: [
          task({
            contextNote: "Slugs are lowercase ASCII.",
            filesToTouch: ["src/core/slug.ts"],
            reuse: ["slugify() in src/util/text.ts"],
          }),
        ],
      }),
      worker,
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Add slugs");
    expect((await f.store.getTasks(f.project.id))[0]).toMatchObject({
      contextNote: "Slugs are lowercase ASCII.",
      filesToTouch: ["src/core/slug.ts"],
      reuse: ["slugify() in src/util/text.ts"],
    });
    await engine.approvePlan(f.project.id);
    await engine.start(f.project.id);
    await engine.waitForLocal(f.project.id);
    expect(contexts).toHaveLength(1);
    const sent = JSON.parse(
      workerBrief({
        task: contexts[0].task,
        project: contexts[0].project,
        cwd: contexts[0].cwd,
        allowDependencyDownloads: contexts[0].allowDependencyDownloads,
        files: [],
      }),
    ) as Record<string, unknown>;
    expect(sent.contextFromManager).toBe("Slugs are lowercase ASCII.");
    expect(sent.filesToTouch).toEqual(["src/core/slug.ts"]);
    expect(sent.reuseExistingCode).toEqual(["slugify() in src/util/text.ts"]);
  });

  it("refuses a plan with an unusable hint and records nothing", async () => {
    const f = await fixture();
    const messages: string[] = [];
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: {
        async runTurn(ctx) {
          await ctx.host
            .proposePlan({
              summary: "Add slugs",
              acceptanceCriteria: ["Slugs work"],
              tasks: [task({ filesToTouch: ["../outside.ts"] })],
            })
            .catch((error: Error) => messages.push(error.message));
          return { text: "Tried.", toolTrace: [] };
        },
      },
      worker: {
        run: async () => {
          throw new Error("no worker expected");
        },
      },
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Add slugs");
    expect(messages).toEqual([
      expect.stringMatching(
        /Task “Add slugs”: filesToTouch entry .* must stay inside the project folder/,
      ),
    ]);
    expect(await f.store.getPlan(f.project.id)).toBeUndefined();
    expect(await f.store.getTasks(f.project.id)).toEqual([]);
  });

  it("keeps a plan stored before these fields working: no hints in the brief", async () => {
    const f = await fixture();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager: proposing({ summary: "Add slugs", acceptanceCriteria: ["Works"], tasks: [task()] }),
      worker: {
        run: async () => {
          throw new Error("no worker expected");
        },
      },
      approvals: new ApprovalBroker(),
    });
    await engine.sendMessage(f.project.id, "Add slugs");
    const [stored] = await f.store.getTasks(f.project.id);
    // Simulate the stored shape of an older plan: no hint fields at all.
    const { filesToTouch: _f, reuse: _r, ...legacy } = stored;
    await f.store.saveTasks(f.project.id, [legacy]);
    const [loaded] = await f.store.getTasks(f.project.id);
    const sent = JSON.parse(
      workerBrief({
        task: loaded,
        project: (await f.store.getProject(f.project.id))!,
        cwd: f.folder,
        allowDependencyDownloads: false,
        files: [],
      }),
    ) as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain("filesToTouch");
    expect(Object.keys(sent)).not.toContain("reuseExistingCode");
    expect(Object.keys(sent)).not.toContain("contextFromManager");
  });
});
