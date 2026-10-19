import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import { LiveWorkBook } from "@core/live-work";
import { MemoryPoundlock } from "@core/memory-poundlock";
import { createProjectFromFiles, ProjectOrchestrator } from "@core/orchestration";
import { createFolderProject } from "@core/projects";
import { shouldDeferInfrastructureRecovery } from "@core/recovery";
import { recoveryNoticesFromSnapshot } from "@core/recovery-notices";
import { ScriptedManager } from "@core/scripted-manager";
import { FileStore } from "@core/store";
import { hostCommandPort } from "@runtime/host-command";
import { approvalIgnoresKeyboardTarget } from "@shared/approval-copy";
import { composerSendBlocked } from "@shared/composer-guard";
import { liveWorkDockView } from "@shared/live-work-view";
import {
  approvedRoutingRevisionForProfile,
  bindingForProfile,
  catalogFromProbe,
  selectedManagerAuthorizesDestination,
} from "@shared/roles";
import { describe, expect, it } from "vitest";
import { DISPATCH_USE_CASES } from "./dispatch-use-cases";
import { tempDir } from "./support/temp-dir";

function dummySource() {
  return {
    kind: "local_folder" as const,
    originalPath: "/tmp/use-case",
    capturedAt: new Date().toISOString(),
    snapshotSha256: "use-case",
    baseRevision: "",
    includedFiles: 1,
    includedBytes: 5,
    excludedPatterns: [],
    includedUncommitted: true,
    originalFingerprint: "use-case",
  };
}

describe("Dispatch use-case matrix", () => {
  it("names U1–U3 for CI and live gates", () => {
    expect(DISPATCH_USE_CASES.map((item) => item.id)).toEqual(["U1", "U2", "U3"]);
  });
});

describe("U1 discussion only", () => {
  it("replies in-session without a plan, tasks, or jobs", async () => {
    const data = await tempDir("u1-");
    const store = new FileStore(data);
    await store.init();
    const backend = new MemoryPoundlock();
    const manager = new ScriptedManager(
      async () => "This folder has one README. No work to start.",
    );
    const orchestrator = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store,
      clientFor: async () => backend,
      manager,
      worker: {
        async run() {
          throw new Error("A discussion starts no work.");
        },
      },
    });
    const project = await createProjectFromFiles({
      store,
      name: "u1",
      files: [{ path: "README.md", content: Buffer.from("hello\n"), executable: false }],
      source: dummySource(),
    });
    await orchestrator.sendMessage(project.id, "What is in this folder?");
    expect(await store.getTasks(project.id)).toEqual([]);
    expect(await store.getPlan(project.id)).toBeUndefined();
    expect(backend.submits).toBe(0);
    const messages = await store.getMessages(project.id);
    expect(messages.some((message) => message.role === "user")).toBe(true);
    expect(messages.some((message) => message.role === "manager")).toBe(true);
  });
});

describe("U2 plan and local interactive worker", () => {
  it("approves a plan and writes a file on this Mac without a durable submit", async () => {
    const root = await realpath(await tempDir("u2-"));
    const folder = join(root, "project");
    await mkdir(folder);
    await writeFile(join(folder, "README.md"), "u2\n");
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
    const command = "node --test";
    const orchestrator = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store,
      clientFor: async () => backend,
      approvals: new ApprovalBroker(),
      manager: {
        async runTurn(ctx) {
          const tasks = await store.getTasks(ctx.project.id);
          if (!tasks.length) {
            await ctx.host.proposePlan({
              summary: "Write a file",
              acceptanceCriteria: ["The file exists"],
              tasks: [
                {
                  title: "Write",
                  objective: "Write",
                  workerPrompt: "Write",
                  acceptanceCriteria: "Exists",
                  difficulty: "small",
                  route: "interactive",
                },
              ],
            });
          } else if (tasks[0].status === "needs_review")
            await ctx.host.requestApplyResult(tasks[0].id);
          else if (tasks.every((task) => task.status === "applied"))
            await ctx.host.markComplete("Verified");
          return { text: "Recorded", toolTrace: [] };
        },
      },
      worker: {
        async run(ctx) {
          await writeFile(join(ctx.cwd, "note.txt"), "u2\n");
          return {
            output: "Done",
            changedFiles: ["note.txt"],
            patch: "+u2",
            verification: {
              status: "passed",
              commands: [{ command, exitCode: 0, output: "passed" }],
            },
          };
        },
      },
    });
    await orchestrator.sendMessage(project.id, "Write a file");
    await orchestrator.approvePlan(project.id);
    await orchestrator.start(project.id);
    await orchestrator.waitForLocal(project.id);
    await orchestrator.tick(project.id);
    await orchestrator.tick(project.id);
    expect(await readFile(join(folder, "note.txt"), "utf8")).toBe("u2\n");
    expect(backend.submits).toBe(0);
    expect((await store.getTasks(project.id))[0].attempts[0].execution).toBe("interactive");
  });
});

describe("U3 frontier manager standing consent", () => {
  it("does not treat a project frontier override as a false route change vs Settings default", () => {
    const catalog = catalogFromProbe({
      interactiveModels: [
        {
          id: "vega-general",
          profileId: "local-id",
          name: "vega-general",
          aliases: ["vega-general"],
          routingRevision: "local-r1",
          dataDestination: "operator_network",
          context_tokens: 32768,
          max_output_tokens: 4096,
          workload_class: "interactive-coding",
        },
        {
          id: "frontier-gpt-sol",
          profileId: "frontier-id",
          name: "frontier-gpt-sol",
          aliases: ["frontier-gpt-sol"],
          routingRevision: "frontier-r1",
          dataDestination: "external",
          context_tokens: 32768,
          max_output_tokens: 4096,
          workload_class: "interactive-coding",
        },
      ],
    });
    const settingsDefault = bindingForProfile(catalog[0]);
    const frontier = catalog[1];
    expect(
      approvedRoutingRevisionForProfile({ manager: settingsDefault }, frontier),
    ).toBeUndefined();
    expect(selectedManagerAuthorizesDestination("frontier-id", frontier, "external")).toBe(true);
    expect(selectedManagerAuthorizesDestination("frontier-gpt-sol", frontier, "external")).toBe(
      true,
    );
    const roles = { manager: settingsDefault };
    expect(approvedRoutingRevisionForProfile(roles, catalog[0])).toBe("local-r1");
    expect(approvedRoutingRevisionForProfile(roles, frontier)).toBeUndefined();
  });
});

describe("infrastructure 503 copy and recovery budget", () => {
  it("names the worker profile instead of paused interactive work", () => {
    const notices = recoveryNoticesFromSnapshot({
      project: {
        status: "reviewing",
        infrastructureIssue: undefined,
        needsInput: undefined,
        budget: { managerTurnsUsed: 0, jobsSubmitted: 0 },
        integration: { headRevision: "", expectedBase: "", appliedPatchSha256: [] },
      },
      tasks: [
        {
          attempts: [
            {
              status: "failed",
              failureClass: "infrastructure",
              profileName: "vega-general",
              error:
                "HTTP 503 infrastructure_unavailable: the configured inference runtime is unavailable",
            },
          ],
        },
      ],
    } as never);
    expect(notices[0]?.title).toBe("vega-general is unavailable");
    expect(notices[0]?.title).not.toMatch(/paused/i);
  });

  it("does not consume further recoveries for identical instant 503s", () => {
    const now = Date.parse("2026-09-17T01:45:40Z");
    expect(
      shouldDeferInfrastructureRecovery(
        {
          recoveryCount: 1,
          attempts: [
            {
              failureClass: "infrastructure",
              error: "HTTP 503 infrastructure_unavailable",
              terminalAt: "2026-09-17T01:45:08Z",
            },
          ],
        },
        now,
      ),
    ).toBe(true);
    expect(
      shouldDeferInfrastructureRecovery(
        {
          recoveryCount: 0,
          attempts: [
            {
              failureClass: "infrastructure",
              error: "HTTP 503 infrastructure_unavailable",
              terminalAt: "2026-09-17T01:45:08Z",
            },
          ],
        },
        now,
      ),
    ).toBe(false);
  });
});

describe("composer and conversation activity", () => {
  it("does not treat composer Enter as an implicit allow or resume", () => {
    expect(approvalIgnoresKeyboardTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(approvalIgnoresKeyboardTarget({ tagName: "INPUT" })).toBe(true);
    expect(approvalIgnoresKeyboardTarget({ tagName: "DIV" })).toBe(false);
    expect(
      composerSendBlocked({
        approvals: [{ projectId: "p1" }],
        projectId: "p1",
      }),
    ).toMatch(/approval card/i);
    expect(
      composerSendBlocked({
        needsInput: { choices: [{ id: "run_durable" }] },
      }),
    ).toMatch(/buttons on the card/i);
    // A manager question's options don't stop an answer in words.
    expect(
      composerSendBlocked({
        needsInput: { choices: [{ id: "option:1" }], kind: "question" },
      }),
    ).toBeUndefined();
  });

  it("keeps per-project live-work history and spins only the current line", () => {
    const book = new LiveWorkBook();
    book.record("a", "Asking the Project Manager…", "2026-09-17T12:00:00Z");
    book.record("a", "vega-general is replying…", "2026-09-17T12:00:02Z");
    book.record("b", "Starting coding for Write…", "2026-09-17T12:00:03Z");
    expect(book.view("a").liveWork).toHaveLength(2);
    expect(book.view("b").liveWork).toHaveLength(1);
    book.clearActivity("a");
    const idle = liveWorkDockView(undefined, book.view("a").liveWork);
    expect(idle?.spinning).toBe(false);
    expect(idle?.earlier).toHaveLength(1);
    const busy = liveWorkDockView("vega-general is replying… · 8s", book.view("a").liveWork);
    expect(busy?.spinning).toBe(true);
  });
});
