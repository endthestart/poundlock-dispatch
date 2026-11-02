import {
  appendLiveWork,
  bindWorkerActivity,
  describeWorkerTool,
  formatLiveWorkActivity,
  GLOBAL_LIVE_WORK,
  LiveWorkBook,
  workerActivityPhase,
} from "@core/live-work";
import { conversationTimeline } from "@shared/live-work-view";
import { expect, it } from "vitest";

it("describes worker tools with project-relative paths and commands", () => {
  expect(describeWorkerTool("write", { path: "/tmp/app/tasks/forms.py" }, "/tmp/app")).toBe(
    "writing tasks/forms.py",
  );
  expect(
    describeWorkerTool(
      "run_command",
      { program: "python", arguments: ["-c", "import django"] },
      "/tmp/app",
    ),
  ).toBe("running python -c import django");
});

it("keeps the last tool action while the model thinks", () => {
  expect(
    workerActivityPhase(
      "vega-general",
      { type: "tool_execution_end", toolName: "write" },
      "/tmp/app",
    ),
  ).toBeUndefined();
  expect(
    workerActivityPhase(
      "vega-general",
      {
        type: "tool_execution_start",
        toolName: "write",
        args: { path: "/tmp/app/tasks/forms.py" },
      },
      "/tmp/app",
    ),
  ).toBe("vega-general: writing tasks/forms.py");
});

it("holds the last tool action across idle waiting events", () => {
  const seen: string[] = [];
  const listeners: Array<(event: { type: string; toolName?: string; args?: unknown }) => void> = [];
  const stop = bindWorkerActivity(
    (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
    {
      modelId: "vega-general",
      cwd: "/tmp/app",
      initial: "Waiting for vega-general",
      onActivity: (text) => {
        seen.push(text);
      },
      now: () => 0,
      intervalMs: 60_000,
    },
  );
  listeners[0]({
    type: "tool_execution_start",
    toolName: "read",
    args: { path: "/tmp/app/requirements.txt" },
  });
  listeners[0]({ type: "tool_execution_end", toolName: "read" });
  listeners[0]({ type: "turn_start" });
  listeners[0]({ type: "agent_start" });
  stop();
  expect(seen.at(-1)).toBe("vega-general: reading requirements.txt");
});

it("adds an elapsed clock only after the worker has been in the same phase", () => {
  expect(formatLiveWorkActivity("Waiting for vega-general", 1200)).toBe("Waiting for vega-general");
  expect(formatLiveWorkActivity("Waiting for vega-general", 9000)).toBe(
    "Waiting for vega-general · 9s",
  );
});

it("keeps one settled status in chronological order and the active status out of history", () => {
  const messages = [
    { id: "user", createdAt: "2026-09-23T15:24:29.000Z" },
    { id: "reply", createdAt: "2026-09-23T15:41:40.000Z" },
  ];
  const entries = [
    { at: "2026-09-23T15:24:30.000Z", text: "Waiting for vega-manager…" },
    { at: "2026-09-23T15:36:00.000Z", text: "vega-manager is replying…" },
    { at: "2026-09-23T15:40:00.000Z", text: "Waiting for vega-manager…" },
    { at: "2026-09-23T15:41:00.000Z", text: "vega-manager is replying…" },
  ];
  // Normal keeps the last step between messages and says how many it folded.
  expect(conversationTimeline(messages, entries, undefined, "normal")).toEqual([
    { kind: "message", message: messages[0] },
    { kind: "activity", entry: entries[3], hidden: 3 },
    { kind: "message", message: messages[1] },
  ]);
  expect(
    conversationTimeline(messages.slice(0, 1), entries, "vega-manager is replying…", "normal"),
  ).toEqual([{ kind: "message", message: messages[0] }]);
  // Verbose shows every settled status in order, still leaving out the one that is live.
  expect(conversationTimeline(messages, entries, undefined, "verbose")).toEqual([
    { kind: "message", message: messages[0] },
    ...entries.map((entry) => ({ kind: "activity", entry })),
    { kind: "message", message: messages[1] },
  ]);
  expect(
    conversationTimeline(messages.slice(0, 1), entries, "vega-manager is replying…", "verbose"),
  ).toEqual([
    { kind: "message", message: messages[0] },
    ...entries.slice(0, 3).map((entry) => ({ kind: "activity", entry })),
  ]);
});

it("does not duplicate heartbeat ticks in the live-work log", () => {
  const first = appendLiveWork([], "vega-general: writing tasks/forms.py", "2026-09-15T22:33:00Z");
  const second = appendLiveWork(
    first,
    "vega-general: writing tasks/forms.py · 8s",
    "2026-09-15T22:33:08Z",
  );
  expect(second).toEqual(first);
  expect(appendLiveWork(second, "Waiting for vega-general", "2026-09-15T22:33:09Z")).toEqual(
    second,
  );
});

it("keeps project-independent activity out of whatever project is currently selected", () => {
  // "Testing the connection" or "Cloning the repository" (before the new
  // project even exists) must never be attributed to whichever other
  // project the user happens to have open — record them against the
  // global bucket explicitly instead of relying on the selected-project
  // fallback.
  const book = new LiveWorkBook();
  book.record("project-a", "Doing project A work", "2026-09-18T20:00:00.000Z");
  book.record(GLOBAL_LIVE_WORK, "Testing the Poundlock connection…", "2026-09-18T20:00:01.000Z");
  expect(book.view("project-a").liveWork).toEqual([
    { at: "2026-09-18T20:00:00.000Z", text: "Doing project A work" },
  ]);
  expect(book.view(GLOBAL_LIVE_WORK).liveWork).toEqual([
    { at: "2026-09-18T20:00:01.000Z", text: "Testing the Poundlock connection…" },
  ]);
});
