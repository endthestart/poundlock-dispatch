/**
 * Compaction the owner can see and start, against the real Pi manager: Pi's
 * own summary requests reach a synthetic server, so what is reported is what
 * Pi did rather than what a stub says it did.
 */
import type { ManagerToolHost } from "@core/orchestration";
import { compactionReserve } from "@runtime/pi-manager";
import type { CompactionEvent, CompactOutcome, ContextUsage } from "@shared/compaction";
import { expect, it } from "vitest";
import {
  isSummary,
  occurrences,
  storedSessions,
  systemOf,
  text,
  withManager,
} from "./support/synthetic-manager";

const host = {} as ManagerToolHost;
const BRIEF = "Objective: survive compaction.";
/**
 * Long enough that a few turns fill the window, but each under the recent
 * tokens Pi keeps: since 0.87 Pi keeps a single message whole rather than
 * summarising part of it, so a bigger one would survive compaction intact.
 */
const long = (marker: string) => `${marker} ${"detail ".repeat(400)}`;
/** A window small enough that a few long turns fill it. */
const SMALL = { contextTokens: 8192, maxOutputTokens: 1024 };

function listeners() {
  const events: CompactionEvent[] = [];
  const usages: Array<ContextUsage | undefined> = [];
  return {
    events,
    usages,
    onCompaction: (event: CompactionEvent) => events.push(event),
    onContextUsage: (usage: ContextUsage | undefined) => usages.push(usage),
  };
}

it("reports a compaction Pi runs on its own, with what it replaced and what it kept", async () => {
  await withManager(
    // Every reply reports a nearly full window, so Pi compacts after each turn.
    // Leave headroom over the system prompt and kept turns, which Pi estimates.
    { ...SMALL, usage: () => 7500 },
    async ({ manager, project, folder, requests }) => {
      const seen = listeners();
      for (const marker of ["one", "two", "three", "four"])
        await manager.runTurn({
          project,
          workspace: folder,
          prompt: long(marker),
          host,
          projectBrief: BRIEF,
          ...seen,
        });

      expect(requests.filter(isSummary).length).toBeGreaterThan(0);
      expect(seen.events.length).toBe(requests.filter(isSummary).length);
      for (const event of seen.events) {
        expect(event.status).toBe("compacted");
        if (event.status !== "compacted") continue;
        expect(event.reason).toBe("threshold");
        expect(event.tokensBefore).toBeGreaterThan(0);
        expect(event.tokensAfter).toBeGreaterThan(0);
        expect(event.tokensAfter).toBeLessThan(event.tokensBefore);
        expect(event.summarisedMessages).toBeGreaterThanOrEqual(1);
        expect(event.keptMessages).toBeGreaterThanOrEqual(1);
      }

      // The brief is in the system prompt of every turn, compacted or not.
      const turns = requests.filter((request) => !isSummary(request));
      expect(turns).toHaveLength(4);
      for (const request of turns) {
        expect(systemOf(request)).toContain(BRIEF);
        expect(occurrences(JSON.stringify(request.messages), BRIEF)).toBe(1);
      }

      // Context use is reported after each turn, against the real window and
      // the size Pi compacts at.
      const last = seen.usages.at(-1);
      expect(last?.windowTokens).toBe(8192);
      expect(last?.autoCompactAtTokens).toBe(8192 - compactionReserve(8192, 1024));
      expect(last?.tokens).toBeGreaterThan(0);
    },
  );
}, 30000);

it("compacts now when asked, sending one summary request that carries the instructions", async () => {
  await withManager(
    // Replies report a context that grows but stays under the size Pi compacts
    // at, so nothing compacts until asked.
    { ...SMALL, usage: (request) => 300 + 900 * request },
    async ({ manager, project, folder, data, requests }) => {
      for (const marker of ["first-topic", "second-topic", "third-topic"])
        await manager.runTurn({
          project,
          workspace: folder,
          prompt: long(marker),
          host,
          projectBrief: BRIEF,
        });
      expect(requests.filter(isSummary)).toHaveLength(0);

      const seen = listeners();
      const outcome = await manager.compact!({
        project,
        host,
        instructions: "Keep every decision about slugs.",
        ...seen,
      });

      expect(outcome.status).toBe("compacted");
      if (outcome.status !== "compacted") return;
      expect(outcome.reason).toBe("manual");
      expect(outcome.summarisedMessages).toBeGreaterThanOrEqual(1);
      expect(outcome.keptMessages).toBeGreaterThanOrEqual(1);
      // What the server last reported, which is what Pi sizes the context by.
      expect(outcome.tokensBefore).toBeGreaterThanOrEqual(3000);
      expect(outcome.tokensAfter).toBeGreaterThan(0);

      const summaries = requests.filter(isSummary);
      expect(summaries).toHaveLength(1);
      expect(JSON.stringify(summaries[0].messages)).toContain("Keep every decision about slugs.");
      // The caller that asked is told through the return value, not twice.
      expect(seen.events).toEqual([]);
      // The size Pi estimates right after compacting stands in until the model answers.
      expect(seen.usages.at(-1)?.tokens).toBe(outcome.tokensAfter);
      expect(await storedSessions(data)).toContain('"type":"compaction"');

      // The next turn still has the brief in its system prompt and the recent
      // turn in its messages; the oldest turn is now only in the summary.
      await manager.runTurn({
        project,
        workspace: folder,
        prompt: "What did we decide?",
        host,
        projectBrief: BRIEF,
      });
      const next = requests.at(-1)!;
      expect(isSummary(next)).toBe(false);
      expect(systemOf(next)).toContain(BRIEF);
      expect(occurrences(JSON.stringify(next.messages), BRIEF)).toBe(1);
      const sent = next.messages.filter((m) => m.role !== "system").map((m) => text(m.content));
      expect(sent.join("")).toContain("third-topic");
      expect(sent.join("")).not.toContain("first-topic");
      expect(sent.join("")).toContain("Answer");
    },
  );
}, 30000);

it("says so when there is nothing to compact, without sending a request", async () => {
  await withManager(
    { ...SMALL, usage: () => 500 },
    async ({ manager, project, folder, requests }) => {
      const ask = (): Promise<CompactOutcome> => manager.compact!({ project, host });

      expect(await ask()).toEqual({ status: "nothing", why: "too_small" });

      for (const marker of ["one", "two", "three"])
        await manager.runTurn({ project, workspace: folder, prompt: long(marker), host });
      expect((await ask()).status).toBe("compacted");
      const sent = requests.length;
      expect(await ask()).toEqual({ status: "nothing", why: "already_compacted" });
      expect(requests).toHaveLength(sent);
    },
  );
}, 30000);

it("compacts a conversation restored from disk, before any turn this session", async () => {
  await withManager(
    { ...SMALL, usage: () => 500 },
    async ({ manager, restart, project, folder, requests }) => {
      for (const marker of ["one", "two", "three"])
        await manager.runTurn({ project, workspace: folder, prompt: long(marker), host });

      const restarted = await restart();
      const outcome = await restarted.compact!({ project, host });
      expect(outcome.status).toBe("compacted");
      expect(requests.filter(isSummary)).toHaveLength(1);
    },
  );
}, 30000);

it("stops a compaction in flight when it is cancelled, and changes nothing", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withManager(
    {
      ...SMALL,
      usage: () => 500,
      // Hold only Pi's summary request, which is the first one after the turns.
      hold: (request) => (request === 4 ? held : undefined),
    },
    async ({ manager, project, folder, data, requests }) => {
      for (const marker of ["one", "two", "three"])
        await manager.runTurn({ project, workspace: folder, prompt: long(marker), host });
      const controller = new AbortController();
      const asked = manager.compact!({ project, host, signal: controller.signal });
      const failure = asked.then(
        () => undefined,
        (error: Error) => error,
      );
      while (requests.length < 4) await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      release();
      expect((await failure)?.message).toMatch(/cancel/i);
      expect(await storedSessions(data)).not.toContain('"type":"compaction"');
    },
  );
}, 30000);

it("forgets the conversation's context use when it is reset", async () => {
  await withManager({}, async ({ manager, project, folder }) => {
    const seen = listeners();
    await manager.runTurn({ project, workspace: folder, prompt: "Hello", host, ...seen });
    expect(seen.usages.at(-1)?.tokens).toBeGreaterThan(0);
    await manager.reset?.(project.id);
    expect(seen.usages.at(-1)).toBeUndefined();
  });
}, 30000);
