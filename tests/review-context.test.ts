import {
  buildManagerReviewPrompt,
  condenseOldReviewPackets,
  type HistoryMessage,
  limitManagerReviewTurn,
  MAX_MANAGER_REVIEW_BODY_CHARS,
  MAX_MANAGER_REVIEW_TURN_CHARS,
} from "@core/review-context";
import type { TaskRecord } from "@shared/types";
import { describe, expect, it } from "vitest";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-review",
    title: "Implement the feature",
    objective: "Build the requested feature.",
    workerPrompt: "Implement it.",
    acceptanceCriteria: "The feature works and checks pass.",
    dependsOn: [],
    difficulty: "medium",
    route: "interactive",
    contextNote: "",
    status: "needs_review",
    repairCount: 0,
    attempts: [
      {
        id: "attempt-1",
        number: 1,
        idempotencyKey: "key",
        requestHash: "hash",
        profileId: "profile",
        profileName: "vega-general",
        harnessId: "pi",
        execution: "interactive",
        status: "failed",
        failureClass: "ambiguous_inference",
        createdAt: new Date(0).toISOString(),
        selectionReason: "Interactive default",
        error: "The provider stream terminated.",
        result: {
          status: "failed",
          output: `worker-start ${"output ".repeat(20_000)} worker-end`,
          patches: [
            {
              root: ".",
              baseRevision: "base",
              patch: `patch-start\n${"+large patch line\n".repeat(20_000)}patch-end`,
              sha256: "abc123",
            },
          ],
          verification: { status: "unverified", commands: [] },
          provenance: {
            changedFiles: Array.from({ length: 100 }, (_, index) => `src/file-${index}.ts`),
          },
        },
      },
    ],
    ...overrides,
  };
}

describe("manager review context", () => {
  it("offers review-only acceptance for an SVG, but not code or required checks", () => {
    const completed = task();
    const attempt = {
      ...completed.attempts[0],
      status: "completed" as const,
      failureClass: undefined,
      error: undefined,
      result: {
        ...completed.attempts[0].result!,
        status: "completed",
        output: "Created the illustration.",
        verification: { status: "unverified", commands: [] },
        provenance: { changedFiles: ["illustration.svg"] },
      },
    };
    const artifact = task({ managerReviewOnly: true, attempts: [attempt] });
    expect(buildManagerReviewPrompt([artifact])).toContain(
      "Decision: inspect only the files needed",
    );
    const validationOnly = task({
      ...artifact,
      stuck: {
        since: new Date(0).toISOString(),
        category: "work_quality",
        reason: "No independent check",
        brief: "Choose how to proceed.",
      },
      attempts: [
        attempt,
        {
          ...attempt,
          id: "attempt-2",
          number: 2,
          result: { ...attempt.result, provenance: { changedFiles: [] } },
        },
      ],
    });
    expect(buildManagerReviewPrompt([validationOnly])).toContain("illustration.svg");
    expect(buildManagerReviewPrompt([validationOnly])).toContain(
      "Decision: inspect only the files needed",
    );
    expect(buildManagerReviewPrompt([artifact], ["xmllint --noout illustration.svg"])).toContain(
      "Required action: the saved project checks did not pass",
    );
    const code = task({
      managerReviewOnly: true,
      attempts: [
        {
          ...attempt,
          result: { ...attempt.result, provenance: { changedFiles: ["src/app.ts"] } },
        },
      ],
    });
    expect(buildManagerReviewPrompt([code])).toContain(
      "Required action: this project has no declared or discovered checks yet",
    );
  });
  it("omits Interactive patch bodies and bounds oversized worker evidence", () => {
    const prompt = buildManagerReviewPrompt([task()]);
    expect(prompt.length).toBeLessThanOrEqual(MAX_MANAGER_REVIEW_BODY_CHARS);
    expect(prompt).toContain("Changed files (100)");
    expect(prompt).toContain("src/file-0.ts");
    expect(prompt).toContain("ambiguous_inference");
    expect(prompt).toContain("freshSession=true");
    expect(prompt).toContain("read_project_file");
    expect(prompt).not.toContain("patch-start");
    expect(prompt).not.toContain("patch-end");
    expect(prompt).not.toContain("worker-end");
  });

  it("caps the complete turn", () => {
    const body = buildManagerReviewPrompt([task()]);
    const turn = limitManagerReviewTurn(`${body}\n${"conversation ".repeat(10_000)}`);
    expect(turn.length).toBeLessThanOrEqual(MAX_MANAGER_REVIEW_TURN_CHARS);
    expect(turn).toContain("[truncated]");
  });
});

describe("review direction without checks", () => {
  it("tells the manager to have the worker add discoverable tests, not to ask the user", () => {
    const base = task();
    const attempt = {
      ...base.attempts[0],
      status: "completed" as const,
      failureClass: undefined,
      error: undefined,
      result: {
        status: "completed" as const,
        output: "Scaffolded the project.",
        patches: [],
        verification: {
          status: "unverified" as const,
          commands: [],
          reason: "No verification commands were declared or discovered for this project.",
        },
        provenance: { execution: "interactive", changedFiles: ["app/models.py"] },
      },
    };
    const prompt = buildManagerReviewPrompt([{ ...base, attempts: [attempt] } as TaskRecord]);
    expect(prompt).toContain("no declared or discovered checks");
    expect(prompt).toContain("add automated tests where Dispatch discovers them");
    expect(prompt).toContain("Do not ask the user to run commands");
  });
});

describe("older review packets in the manager's history", () => {
  const packet = (id: string, title: string) =>
    `${buildManagerReviewPrompt([task({ id, title })])}\n\nCurrent project status: reviewing.\n--- begin untrusted recent conversation ---\n${"chat ".repeat(500)}`;
  const user = (text: string): HistoryMessage => ({
    role: "user",
    content: [{ type: "text", text }],
  });
  const call = (name: string, args: Record<string, unknown>, id = `${name}-1`): HistoryMessage => ({
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
  });
  const textOf = (message: HistoryMessage) =>
    (message.content as Array<{ text: string }>).map((part) => part.text).join("");

  it("leaves the history alone until a second packet arrives", () => {
    const messages = [user("hello"), user(packet("task-a", "Store"))];
    expect(condenseOldReviewPackets(messages)).toBe(messages);
    expect(condenseOldReviewPackets([user("hello")])).toEqual([user("hello")]);
  });

  it("keeps the latest packet whole and reduces each earlier one to a line with its outcome", () => {
    const first = user(packet("task-a", "Store"));
    const second = user(packet("task-b", "Command line"));
    const third = user(packet("task-c", "Docs"));
    const chat = user("Please also add a README.");
    const reply = { role: "assistant", content: [{ type: "text", text: "Sure." }] };
    const messages: HistoryMessage[] = [
      first,
      call("request_apply_result", { taskId: "task-a" }),
      { role: "toolResult", toolCallId: "request_apply_result-1", isError: false, content: [] },
      chat,
      reply,
      second,
      call("request_repair", { taskId: "task-b", findings: "Tests do not run." }),
      third,
    ];
    const out = condenseOldReviewPackets(messages);

    expect(out).toHaveLength(messages.length);
    expect(textOf(out[0])).toBe(
      "[Earlier review, condensed. task-a “Store”: accepted. The evidence packet, and the conversation and task state sent with it, are omitted; your current turn carries the latest.]",
    );
    expect(textOf(out[5])).toContain("task-b “Command line”: repair requested");
    // The undecided packet, the chat and the assistant reply are the same objects.
    expect(out[7]).toBe(third);
    expect(out[3]).toBe(chat);
    expect(out[4]).toBe(reply);
    expect(out[1]).toBe(messages[1]);
    // The stored history is not rewritten.
    expect(messages[0]).toBe(first);
    expect(textOf(first)).toContain("Review these worker results");
    // A packet of thousands of characters becomes a few hundred at most.
    expect(textOf(first).length).toBeGreaterThan(3_000);
    expect(textOf(out[0]).length).toBeLessThan(300);
  });

  it("does not count a rejected decision, and says when there was none", () => {
    const messages: HistoryMessage[] = [
      user(packet("task-a", "Store")),
      call("request_apply_result", { taskId: "task-a" }, "apply-1"),
      { role: "toolResult", toolCallId: "apply-1", isError: true, content: [] },
      user(packet("task-b", "Command line")),
      user(packet("task-c", "Docs")),
    ];
    const out = condenseOldReviewPackets(messages);
    expect(textOf(out[0])).toContain("task-a “Store”: no decision recorded");
    expect(textOf(out[3])).toContain("task-b “Command line”: no decision recorded");
  });

  it("uses a question to the owner or a revised plan for every task in the packet", () => {
    const both = `${buildManagerReviewPrompt([task({ id: "task-a", title: "Store" }), task({ id: "task-b", title: "CLI" })])}`;
    const out = condenseOldReviewPackets([
      user(both),
      call("ask_user", { question: "Which database?" }),
      user(packet("task-c", "Docs")),
    ]);
    expect(textOf(out[0])).toContain(
      "task-a “Store”: asked the owner; task-b “CLI”: asked the owner",
    );
  });

  it("shortens long titles, caps the tasks it lists, and handles string content", () => {
    const tasks = Array.from({ length: 10 }, (_, index) =>
      task({ id: `task-${index}`, title: index === 0 ? `T${"x".repeat(100)}` : `Task ${index}` }),
    );
    const many = buildManagerReviewPrompt(tasks.slice(0, 1));
    const wide = tasks.map((item) => `Task ${item.id} (${item.title})`).join("\n");
    const out = condenseOldReviewPackets([
      { role: "user", content: `${many.split("\n")[0]}\n\n${wide}` },
      user(packet("task-z", "Docs")),
    ]);
    expect(typeof out[0].content).toBe("string");
    const line = out[0].content as string;
    expect(line).toContain("task-0 “T");
    expect(line).toContain("…”");
    expect(line).toContain("and 2 more");
    expect(line).not.toContain("task-9");
  });

  it("only touches messages that open with the review instruction", () => {
    const quoted = user(`The user said: "${packet("task-a", "Store")}"`);
    const messages = [quoted, user(packet("task-b", "CLI")), user(packet("task-c", "Docs"))];
    const out = condenseOldReviewPackets(messages);
    expect(out[0]).toBe(quoted);
    expect(textOf(out[1])).toContain("[Earlier review, condensed.");
  });
});

it("names the failing test from a long cargo run, not just its compile progress", async () => {
  const { failureExcerpt } = await import("@shared/failure-excerpt");
  const output = [
    ...Array.from({ length: 40 }, (_, i) => `   Compiling crate${i} v0.1.0`),
    "running 12 tests",
    "test export::tests::writes_jpeg ... ok",
    "test export::tests::refuses_overwrite ... FAILED",
    "failures:",
    "---- export::tests::refuses_overwrite stdout ----",
    "thread 'export::tests::refuses_overwrite' panicked at crates/lrc-export/src/lib.rs:88:9:",
    "  left: true",
    " right: false",
    "test result: FAILED. 11 passed; 1 failed; 0 ignored",
  ].join("\n");
  const excerpt = failureExcerpt(output);
  expect(excerpt).toContain("refuses_overwrite ... FAILED");
  expect(excerpt).toContain("panicked at crates/lrc-export/src/lib.rs:88:9");
  expect(excerpt).toContain("left: true");
  expect(excerpt).not.toContain("Compiling crate0");
});

describe("a check that runs no tests", () => {
  it("is told apart from one that ran some", async () => {
    const { ranNoTests } = await import("@shared/failure-excerpt");
    expect(
      ranNoTests("Building for debugging...\n✔ Test run with 0 tests passed after 0.001 seconds."),
    ).toBe(true);
    expect(ranNoTests("Executed 0 tests, with 0 failures\n✔ Test run with 3 tests passed")).toBe(
      false,
    );
    expect(ranNoTests("running 0 tests\n\nrunning 16 tests\ntest result: ok. 16 passed")).toBe(
      false,
    );
    expect(ranNoTests("running 0 tests\ntest result: ok. 0 passed")).toBe(true);
    expect(ranNoTests("Finished dev [unoptimized] target(s)")).toBe(false);
  });
});
