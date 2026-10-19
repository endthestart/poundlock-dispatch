import {
  COMPACT_OFFER_PERCENT,
  type CompactionEvent,
  compactionFromPiEvent,
  compactionLine,
  compactionNoticeText,
  compactionSkippedText,
  contextUsageView,
} from "@shared/compaction";
import { projectMenuActions } from "@shared/project-actions";
import { compactOffered, visibleComposerInfolets } from "@shared/status-infolets";
import { DEFAULT_UI_PREFERENCES } from "@shared/ui-preferences";
import { expect, it } from "vitest";
import { snapshot, state } from "./support/tui-fixtures";

const automatic: CompactionEvent = {
  status: "compacted",
  reason: "threshold",
  tokensBefore: 18_340,
  tokensAfter: 5_410,
  summarisedMessages: 14,
  keptMessages: 5,
};

it("tells the owner what happened, how much, and that the brief and recent turns were kept", () => {
  expect(compactionNoticeText(automatic)).toBe(
    "Conversation compacted automatically, because the context was nearing the model's limit. The manager's context went from about 18,300 to about 5,400 tokens: 14 earlier messages are now a summary, and the 5 most recent messages were kept as written. The project brief stays pinned, and the conversation shown here is unchanged.",
  );
});

it("says who asked, and how the model's own report differs from a nearing limit", () => {
  expect(compactionNoticeText({ ...automatic, reason: "manual" })).toContain(
    "compacted at your request.",
  );
  expect(compactionNoticeText({ ...automatic, reason: "overflow" })).toContain(
    "after the model reported its context was full.",
  );
});

it("reads in the singular, and without figures it does not have", () => {
  const one = compactionNoticeText({ ...automatic, summarisedMessages: 1, keptMessages: 1 });
  expect(one).toContain("1 earlier message is now a summary");
  expect(one).toContain("the most recent message was kept as written");
  const bare = compactionNoticeText({
    status: "compacted",
    reason: "manual",
    tokensBefore: 9_000,
  });
  expect(bare).toContain("held about 9,000 tokens: older messages are now a summary");
  expect(bare).toContain("the most recent ones were kept as written");
  expect(bare).not.toMatch(/undefined|NaN/);
});

it("does not claim the context shrank when the compaction failed", () => {
  const text = compactionNoticeText({ status: "failed", reason: "threshold", error: "boom" });
  expect(text).toContain("could not be compacted (boom)");
  expect(text).toContain("context is unchanged");
});

it("has a short line for the notice a client keeps on screen, and a reason for doing nothing", () => {
  expect(compactionLine(automatic)).toBe(
    "Conversation compacted: about 18,300 down to about 5,400 tokens.",
  );
  expect(compactionSkippedText({ status: "nothing", why: "too_small" })).toMatch(/still short/);
  expect(compactionSkippedText({ status: "nothing", why: "already_compacted" })).toMatch(
    /Already compacted/,
  );
  expect(compactionSkippedText({ status: "unsupported" })).toMatch(/keeps no conversation/);
});

it("reads Pi's compaction_end, dropping what was cancelled and other events", () => {
  const end = { type: "compaction_end", reason: "manual" as const };
  expect(
    compactionFromPiEvent(
      { ...end, result: { tokensBefore: 10, estimatedTokensAfter: 4 } },
      { summarisedMessages: 3 },
    ),
  ).toEqual({
    status: "compacted",
    reason: "manual",
    tokensBefore: 10,
    tokensAfter: 4,
    summarisedMessages: 3,
  });
  expect(compactionFromPiEvent({ ...end, aborted: true })).toBeUndefined();
  expect(compactionFromPiEvent({ ...end })).toBeUndefined();
  expect(compactionFromPiEvent({ type: "compaction_start", reason: "manual" })).toBeUndefined();
  expect(
    compactionFromPiEvent({ ...end, errorMessage: "Auto-compaction failed: no route" }),
  ).toEqual({ status: "failed", reason: "manual", error: "no route" });
});

it("reports context use as a share of the window, and offers to compact past the threshold", () => {
  const usage = (tokens: number) => ({
    tokens,
    windowTokens: 32_768,
    autoCompactAtTokens: 24_576,
  });
  const view = contextUsageView(usage(23_600));
  expect(view.text).toBe("context 72% used");
  expect(view.title).toBe(
    "About 23,600 of 32,768 tokens. The manager compacts the conversation on its own at about 75%.",
  );
  expect(view.offerCompact).toBe(true);
  expect(contextUsageView(usage(8_000)).offerCompact).toBe(false);
  const edge = Math.ceil((COMPACT_OFFER_PERCENT / 100) * 32_768);
  expect(contextUsageView(usage(edge)).offerCompact).toBe(true);
  expect(contextUsageView(usage(edge - 400)).offerCompact).toBe(false);
  // An estimate can run past the window; the chip does not say 130%.
  expect(contextUsageView(usage(42_000)).percent).toBe(100);
});

it("shows the context chip by default, only once there is something to show, and offers compaction past the threshold", () => {
  expect(DEFAULT_UI_PREFERENCES.composerInfolets).toContain("context");
  const base = state({ ui: DEFAULT_UI_PREFERENCES });
  expect(visibleComposerInfolets(base)).toEqual([]);
  const quiet = state({
    ui: DEFAULT_UI_PREFERENCES,
    contextUsage: { tokens: 8_000, windowTokens: 32_768, autoCompactAtTokens: 24_576 },
  });
  expect(visibleComposerInfolets(quiet).map((item) => item.text)).toEqual(["context 24% used"]);
  expect(compactOffered(quiet)).toBe(false);
  const full = state({
    ui: DEFAULT_UI_PREFERENCES,
    contextUsage: { tokens: 23_600, windowTokens: 32_768, autoCompactAtTokens: 24_576 },
  });
  expect(compactOffered(full)).toBe(true);
  // Turned off in Settings, it is gone, offer and all.
  expect(compactOffered({ ...full, ui: { ...full.ui, composerInfolets: ["budget"] } })).toBe(false);
});

it("lists Compact conversation in the project menu once there is a conversation and no turn", () => {
  const withMessages = snapshot({
    messages: [{ id: "m1", role: "user", text: "Hello", createdAt: "2026-01-01T00:00:00.000Z" }],
  });
  const ids = (input: Parameters<typeof projectMenuActions>[0]) =>
    projectMenuActions(input).actions.map((action) => action.id);
  expect(ids({ snapshot: withMessages })).toContain("compact");
  // Beside the conversation actions, before History.
  const order = ids({ snapshot: withMessages });
  expect(order.indexOf("compact")).toBeGreaterThan(order.indexOf("newRun"));
  expect(order.indexOf("compact")).toBeLessThan(order.indexOf("history"));
  const action = projectMenuActions({ snapshot: withMessages }).actions.find(
    (item) => item.id === "compact",
  );
  expect(action?.label).toBe("Compact conversation");
  expect(action?.confirm).toBeUndefined();
  expect(ids({ snapshot: snapshot() })).not.toContain("compact");
  expect(ids({ snapshot: withMessages, busy: true })).not.toContain("compact");
  // The manager is answering: a compaction would only be refused.
  const answering = snapshot({
    ...withMessages,
    project: { ...withMessages.project, status: "planning" },
  });
  expect(ids({ snapshot: answering })).not.toContain("compact");
});
