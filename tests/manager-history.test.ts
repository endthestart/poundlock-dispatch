import { describe, expect, it } from "vitest";
import {
  condenseOldFileReads,
  historyForSummary,
  managerHistory,
} from "../src/core/manager-history";
import { type HistoryMessage, REVIEW_PACKET_OPENING } from "../src/core/review-context";

const user = (text: string): HistoryMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});
const call = (id: string, name: string, args: Record<string, unknown> = {}): HistoryMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const result = (id: string, text: string, isError = false): HistoryMessage => ({
  role: "toolResult",
  toolCallId: id,
  isError,
  content: [{ type: "text", text }],
});
const textOf = (message: HistoryMessage) =>
  (message.content as Array<{ text: string }>).map((part) => part.text).join("");

describe("condenseOldFileReads", () => {
  const big = "x".repeat(5000);

  it("reduces earlier turns' reads and listings to a line and keeps the current turn's", () => {
    const messages = [
      user("Plan the importer."),
      call("r1", "read_project_file", { path: "src/import.rs" }),
      result("r1", big),
      call("l1", "list_project_files"),
      result("l1", big),
      user("Review this attempt."),
      call("r2", "read_project_file", { path: "src/import.rs" }),
      result("r2", big),
    ];
    const out = condenseOldFileReads(messages);
    expect(textOf(out[2])).toBe(
      "[Earlier read of src/import.rs, 5000 characters, omitted. Read it again if you need it; it may have changed since.]",
    );
    expect(textOf(out[4])).toContain("[Earlier file listing, 5000 characters");
    expect(out[7]).toBe(messages[7]);
    expect(messages[2]).toEqual(result("r1", big));
  });

  it("keeps errors, short results and other tools' results", () => {
    const messages = [
      user("Go."),
      call("r1", "read_project_file", { path: "missing.rs" }),
      result("r1", big, true),
      call("r2", "read_project_file", { path: "a.rs" }),
      result("r2", "short"),
      call("i1", "investigate", { question: "why" }),
      result("i1", big),
      user("Next."),
    ];
    expect(condenseOldFileReads(messages)).toBe(messages);
  });

  it("returns the same array within the first turn", () => {
    const messages = [
      user("Go."),
      call("r1", "read_project_file", { path: "a" }),
      result("r1", big),
    ];
    expect(condenseOldFileReads(messages)).toBe(messages);
    expect(managerHistory(messages)).toBe(messages);
  });
});

describe("historyForSummary", () => {
  const packet = (task: string) =>
    user(`${REVIEW_PACKET_OPENING}\nTask ${task} (Work)\n${"evidence ".repeat(1500)}`);

  it("condenses decided review packets and earlier reads, as turns send them", () => {
    const messages = [
      packet("t1"),
      call("r1", "read_project_file", { path: "src/a.rs" }),
      result("r1", "x".repeat(5000)),
      packet("t2"),
    ];
    const summarised = historyForSummary(messages, 100_000);
    expect(textOf(summarised[0])).toMatch(/^\[Earlier review, condensed/);
    expect(textOf(summarised[2])).toMatch(/^\[Earlier read of src\/a\.rs/);
    // The undecided packet is kept, cut to the summary's per-message limit.
    expect(textOf(summarised[3])).toMatch(/^Review these worker results[\s\S]*more characters cut/);
  });

  it("cuts a single long message as Pi cuts tool results", () => {
    const [cut] = historyForSummary([user("z".repeat(20_000))], 100_000);
    expect(textOf(cut)).toMatch(/^z{8000}\n\n\[\.\.\. 12000 more characters cut/);
  });

  it("drops the oldest messages that do not fit, keeping the newest", () => {
    const messages = [user("a".repeat(3000)), user("b".repeat(3000)), user("c".repeat(3000))];
    const summarised = historyForSummary(messages, 2_100);
    expect(summarised.map((message) => textOf(message)[0])).toEqual(["b", "c"]);
    expect(historyForSummary(messages, 0)).toEqual([]);
  });
});
