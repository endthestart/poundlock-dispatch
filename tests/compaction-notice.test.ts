/**
 * What the owner is told when the manager's conversation is compacted, and how
 * they ask for it. The manager is scripted here, so these tests are about
 * Dispatch's handling; `pi-manager-compaction.test.ts` is where Pi really
 * compacts.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import { DispatchHost } from "@core/host/dispatch-host";
import {
  type ManagerCompactContext,
  type ManagerPort,
  ProjectOrchestrator,
} from "@core/orchestration";
import { ProjectLifecycle } from "@core/project-lifecycle";
import { createFolderProject } from "@core/projects";
import { hostCommandPort } from "@runtime/host-command";
import type { CompactionEvent, CompactOutcome, ContextUsage } from "@shared/compaction";
import { describe, expect, it } from "vitest";
import { engineFor, recordingWorker, workflowFixture } from "./support/workflow-fixture";

const COMPACTED = {
  status: "compacted",
  reason: "manual",
  tokensBefore: 18_340,
  tokensAfter: 5_410,
  summarisedMessages: 14,
  keptMessages: 5,
} as const satisfies CompactOutcome;

const USAGE: ContextUsage = { tokens: 23_600, windowTokens: 32_768, autoCompactAtTokens: 24_576 };

/** A manager that answers every turn and compacts as `compact` says. */
function scriptedManager(script: {
  /** What the turn reports while it runs. */
  during?: (ctx: Parameters<ManagerPort["runTurn"]>[0]) => void;
  compact?: (ctx: ManagerCompactContext) => Promise<CompactOutcome>;
  hold?: Promise<void>;
  /** Called as a turn starts, so a test can wait for it rather than for a while. */
  started?: () => void;
}) {
  const compactions: ManagerCompactContext[] = [];
  const manager: ManagerPort = {
    async runTurn(ctx) {
      script.started?.();
      await script.hold;
      script.during?.(ctx);
      return { text: "Understood.", toolTrace: [] };
    },
    ...(script.compact
      ? {
          compact: async (ctx) => {
            compactions.push(ctx);
            return script.compact!(ctx);
          },
        }
      : {}),
  };
  return { manager, compactions };
}

const notices = async (f: Awaited<ReturnType<typeof workflowFixture>>) =>
  (await f.store.getMessages(f.project.id)).filter((message) => message.kind === "notice");

describe("a compaction during a turn", () => {
  it("is written into the conversation as a notice, ahead of the reply it made room for", async () => {
    const f = await workflowFixture({ prefix: "dispatch-compaction-turn-" });
    const event: CompactionEvent = { ...COMPACTED, status: "compacted", reason: "threshold" };
    const { manager } = scriptedManager({ during: (ctx) => ctx.onCompaction?.(event) });
    const engine = engineFor(f, manager);

    await engine.sendMessage(f.project.id, "Keep going");

    const messages = await f.store.getMessages(f.project.id);
    const notice = messages.find((message) => message.kind === "notice");
    expect(notice?.role).toBe("system");
    expect(notice?.text).toContain("Conversation compacted automatically");
    expect(notice?.text).toContain("from about 18,300 to about 5,400 tokens");
    expect(notice?.text).toContain("14 earlier messages are now a summary");
    expect(notice?.text).toContain("5 most recent messages were kept as written");
    expect(notice?.text).toContain("project brief stays pinned");
    expect(messages.findIndex((message) => message.kind === "notice")).toBeLessThan(
      messages.findIndex((message) => message.role === "manager"),
    );
  });

  it("says when a compaction failed, without claiming the context shrank", async () => {
    const f = await workflowFixture({ prefix: "dispatch-compaction-failed-" });
    const { manager } = scriptedManager({
      during: (ctx) =>
        ctx.onCompaction?.({ status: "failed", reason: "threshold", error: "Model unavailable" }),
    });
    await engineFor(f, manager).sendMessage(f.project.id, "Keep going");
    const [notice] = await notices(f);
    expect(notice.text).toContain("could not be compacted (Model unavailable)");
    expect(notice.text).toContain("context is unchanged");
    expect(notice.text).not.toContain("went from");
  });

  it("passes the context use on, and drops it when a new conversation starts", async () => {
    const f = await workflowFixture({ prefix: "dispatch-compaction-usage-" });
    const seen: Array<[ContextUsage | undefined, string]> = [];
    const { manager } = scriptedManager({ during: (ctx) => ctx.onContextUsage?.(USAGE) });
    const { worker } = recordingWorker();
    const engine = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store: f.store,
      clientFor: async () => f.backend,
      manager,
      worker,
      onContextUsage: (usage, projectId) => seen.push([usage, projectId]),
    });
    await engine.sendMessage(f.project.id, "Keep going");
    expect(seen).toEqual([[USAGE, f.project.id]]);
    await engine.startFresh(f.project.id);
    expect(seen.at(-1)).toEqual([undefined, f.project.id]);
  });
});

describe("compacting on request", () => {
  it("writes the same notice into the conversation, after the manager has compacted", async () => {
    const f = await workflowFixture({ prefix: "dispatch-compaction-ask-" });
    const { manager, compactions } = scriptedManager({ compact: async () => COMPACTED });
    const engine = engineFor(f, manager);

    const outcome = await engine.compactConversation(f.project.id, "  Keep the slug decisions.  ");

    expect(outcome.status).toBe("compacted");
    // The instructions are trimmed before they reach the manager.
    expect(compactions[0].instructions).toBe("Keep the slug decisions.");
    const [notice] = await notices(f);
    expect(notice.text).toContain("Conversation compacted at your request");
    expect(notice.text).toContain("14 earlier messages");
  });

  it("writes nothing into the conversation when there was nothing to compact", async () => {
    const f = await workflowFixture({ prefix: "dispatch-compaction-nothing-" });
    const { manager } = scriptedManager({
      compact: async () => ({ status: "nothing", why: "too_small" }),
    });
    const outcome = await engineFor(f, manager).compactConversation(f.project.id);
    expect(outcome).toEqual({ status: "nothing", why: "too_small" });
    expect(await notices(f)).toEqual([]);
  });

  it("reports a manager that keeps no conversation", async () => {
    const f = await workflowFixture({ prefix: "dispatch-compaction-none-" });
    const { manager } = scriptedManager({});
    expect(await engineFor(f, manager).compactConversation(f.project.id)).toEqual({
      status: "unsupported",
    });
  });

  it("refuses while the manager is mid-turn, and leaves the turn alone", async () => {
    const f = await workflowFixture({ prefix: "dispatch-compaction-busy-" });
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const inTurn = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { manager, compactions } = scriptedManager({
      hold,
      started,
      compact: async () => COMPACTED,
    });
    const engine = engineFor(f, manager);
    const turn = engine.sendMessage(f.project.id, "Keep going");
    await inTurn;

    await expect(engine.compactConversation(f.project.id)).rejects.toThrow(
      /working on this conversation/,
    );
    expect(compactions).toHaveLength(0);
    release();
    await turn;
    expect((await f.store.getMessages(f.project.id)).some((m) => m.role === "manager")).toBe(true);
  });

  it("holds the project as mid-turn while it compacts, so nothing starts under it", async () => {
    const f = await workflowFixture({ prefix: "dispatch-compaction-hold-" });
    let release: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const inCompaction = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { manager } = scriptedManager({
      compact: async () => {
        started();
        await running;
        return COMPACTED;
      },
    });
    const engine = engineFor(f, manager);
    const compacting = engine.compactConversation(f.project.id);
    await inCompaction;
    expect(engine.isBusy(f.project.id)).toBe(true);
    await expect(engine.compactConversation(f.project.id)).rejects.toThrow(/working/);
    release();
    await compacting;
    expect(engine.isBusy(f.project.id)).toBe(false);
  });

  it("names the failure and writes no notice when the summary could not be made", async () => {
    const f = await workflowFixture({ prefix: "dispatch-compaction-error-" });
    const { manager } = scriptedManager({
      compact: async () => {
        throw new Error("The model did not answer.");
      },
    });
    await expect(engineFor(f, manager).compactConversation(f.project.id)).rejects.toThrow(
      "The conversation could not be compacted: The model did not answer.",
    );
    expect(await notices(f)).toEqual([]);
  });

  it("limits the instructions to a line or two", async () => {
    const f = await workflowFixture({ prefix: "dispatch-compaction-long-" });
    const { manager, compactions } = scriptedManager({ compact: async () => COMPACTED });
    await expect(
      engineFor(f, manager).compactConversation(f.project.id, "x".repeat(1001)),
    ).rejects.toThrow(/limited to 1,000 characters/);
    expect(compactions).toHaveLength(0);
  });
});

describe("the host", () => {
  async function hostFor(manager: ManagerPort) {
    const f = await workflowFixture({ prefix: "dispatch-compaction-host-" });
    const host = new DispatchHost(
      { dataRoot: f.store.layout.root },
      f.store,
      new ApprovalBroker(),
      {
        worker: () => recordingWorker().worker,
        managerProvider: () => ({
          get: async () => manager,
          reset: async () => undefined,
          abort: () => undefined,
          clear: () => undefined,
        }),
        orchestrator: (dependencies) =>
          new ProjectOrchestrator({
            hostCommands: hostCommandPort,
            ...dependencies,
            clientFor: async () => f.backend,
          }),
        lifecycle: (dependencies) => new ProjectLifecycle(dependencies),
      },
    );
    await host.selectProject(f.project.id);
    return { f, host };
  }

  it("compacts the selected project and leaves a one-line notice for the client to show", async () => {
    const { manager } = scriptedManager({
      compact: async (ctx) => {
        ctx.onContextUsage?.({ ...USAGE, tokens: 5_410 });
        return COMPACTED;
      },
    });
    const { f, host } = await hostFor(manager);

    const state = await host.compactConversation("Keep the decisions.");

    expect(state.notice).toEqual({
      kind: "info",
      text: "Conversation compacted: about 18,300 down to about 5,400 tokens.",
    });
    expect(state.snapshot?.messages.some((message) => message.kind === "notice")).toBe(true);
    expect(state.contextUsage?.tokens).toBe(5_410);
    expect(await notices(f)).toHaveLength(1);
  });

  it("shows the selected project's context use, and only its own", async () => {
    const { manager } = scriptedManager({ during: (ctx) => ctx.onContextUsage?.(USAGE) });
    const { f, host } = await hostFor(manager);
    expect((await host.getState()).contextUsage).toBeUndefined();

    await host.sendMessage("Keep going");
    expect((await host.getState()).contextUsage).toEqual(USAGE);

    const folder = join(f.root, "other");
    await mkdir(folder);
    const other = await createFolderProject({ store: f.store, folder });
    await host.selectProject(other.id);
    expect((await host.getState()).contextUsage).toBeUndefined();
    await host.selectProject(f.project.id);
    expect((await host.getState()).contextUsage).toEqual(USAGE);
  });

  it("says a compaction that had nothing to do, rather than staying silent", async () => {
    const { manager } = scriptedManager({
      compact: async () => ({ status: "nothing", why: "already_compacted" }),
    });
    const { host } = await hostFor(manager);
    const state = await host.compactConversation();
    expect(state.notice?.text).toBe(
      "Already compacted: nothing has been added since the last summary.",
    );
    expect(state.notice?.kind).toBe("info");
  });
});
