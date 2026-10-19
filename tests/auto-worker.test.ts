import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dockerIsolation, IsolationUnavailableError } from "@core/auto/isolation";
import type { CaseAttemptInput } from "@core/auto/ports";
import { PoundlockClient } from "@core/poundlock";
import { autoProject, caseBrief, createAutoWorker, lastNotes } from "@runtime/auto-session";
import {
  type AutoAttemptRecord,
  autoAttemptHooks,
  autoContract,
  isInferenceUnavailable,
  LOOP_WINDOW,
  MAX_FINISH_NUDGES,
  newAttemptRecord,
  REPEAT_NUDGE,
  RepetitionGuard,
  timeNote,
} from "@runtime/auto-worker";
import { describe, expect, it } from "vitest";
import { fakeDocker } from "./support/fake-docker";
import {
  type ChatRequest,
  callsSinceLastUser,
  fakePoundlock,
  messageText,
  type ScriptedTurn,
} from "./support/fake-poundlock";
import { tempDir } from "./support/temp-dir";

type Tool = {
  name: string;
  execute: (id: string, params: unknown) => Promise<{ terminate?: boolean }>;
};

function handlers(
  options: Parameters<typeof autoAttemptHooks>[2] = {},
  record = newAttemptRecord(),
) {
  const hooks = autoAttemptHooks("C1", record, options);
  const on: Record<string, (event: never) => unknown> = {};
  hooks.extension({
    on: (name: string, fn: (event: never) => unknown) => (on[name] = fn),
  } as never);
  const finish = hooks.finishTool({
    defineTool: (definition: Tool) => definition,
  } as never) as Tool;
  return { hooks, on, finish, record };
}

const call = (
  on: Record<string, (event: never) => unknown>,
  id: string,
  toolName: string,
  input: unknown,
) =>
  on.tool_call({ toolCallId: id, toolName, input } as never) as
    | { block?: boolean; reason?: string; terminate?: boolean }
    | undefined;
const result = (on: Record<string, (event: never) => unknown>, id: string, text: string) =>
  on.tool_result({ toolCallId: id, content: [{ type: "text", text }] } as never);

describe("auto worker contract", () => {
  it("puts the contract in the system prompt and ends the case with finish_case", async () => {
    const { hooks, finish, record } = handlers();
    expect(hooks.systemPromptSuffix).toBe(autoContract("C1"));
    expect(hooks.systemPromptSuffix).toContain("Never end your turn without calling finish_case");
    const done = await finish.execute("x", {
      status: "blocked",
      summary: "stuck",
      blockedReason: "needs a key",
      learnings: ["a", "b", "c", "d", "e", "f"],
    });
    expect(done.terminate).toBe(true);
    expect(record.finish).toMatchObject({ status: "blocked", blockedReason: "needs a key" });
    expect(record.finish?.learnings).toHaveLength(5);
  });

  it("nudges in the same session until finish_case, at most twice, and sums usage with cache reads apart", async () => {
    const { hooks, record } = handlers();
    const prompts: string[] = [];
    const final = await hooks.afterTurn(
      {
        messages: [
          { role: "assistant", usage: { input: 10, output: 5, cacheRead: 1000, cacheWrite: 1 } },
          { role: "user" },
        ],
      },
      { role: "assistant", stopReason: "stop" } as never,
      async (text) => {
        prompts.push(text);
        return { role: "assistant", stopReason: "stop" } as never;
      },
    );
    expect(prompts).toHaveLength(MAX_FINISH_NUDGES);
    expect(record.nudges).toBe(MAX_FINISH_NUDGES);
    expect(final).toBeDefined();
    expect(record.usage).toEqual({ input: 10, output: 5, cacheWrite: 1, cacheRead: 1000 });
  });

  it("does not nudge a turn that finished, errored or was stopped by a guard", async () => {
    const finished = newAttemptRecord();
    finished.finish = { status: "done", summary: "", tests: [], learnings: [] };
    const stopped: AutoAttemptRecord = { ...newAttemptRecord(), stopped: "loop" };
    for (const [record, last] of [
      [finished, { role: "assistant", stopReason: "toolUse" }],
      [newAttemptRecord(), { role: "assistant", stopReason: "error" }],
      [stopped, { role: "assistant", stopReason: "stop" }],
    ] as const) {
      const { hooks } = handlers({}, record);
      let prompted = 0;
      await hooks.afterTurn({ messages: [] }, last as never, async () => {
        prompted++;
        return undefined;
      });
      expect(prompted).toBe(0);
    }
  });

  it("warns about the time left at 80% of the allowance and again at five minutes, once each", () => {
    let now = 0;
    const timing = { deadlineAt: 60 * 60_000, allowanceMs: 60 * 60_000, now: () => now };
    const { on } = handlers({ timing });
    const note = (id: string) =>
      (result(on, id, "ok") as { content: Array<{ text: string }> } | undefined)?.content.at(-1)
        ?.text;
    now = 40 * 60_000;
    expect(note("a")).toBeUndefined();
    now = 49 * 60_000;
    expect(note("b")).toContain("about 11 min left");
    expect(note("c")).toBeUndefined();
    now = 56 * 60_000;
    expect(note("d")).toContain("4 min left");
    expect(note("e")).toBeUndefined();
    expect(timeNote("C1", timing, 0)?.level).toBe(2);
  });

  it("blocks writes and shell from the start of a finalization attempt", () => {
    const { on } = handlers({ finalize: true });
    expect(call(on, "1", "edit", {})).toMatchObject({ block: true });
    expect(call(on, "2", "bash", { command: "ls" })).toMatchObject({ block: true });
    expect(call(on, "3", "read", { path: "a" })).toBeUndefined();
  });

  it("adds a reminder to the first tool result after a compaction, and blocks writes while finishing", async () => {
    const { hooks, on, record } = handlers();
    on.session_compact({} as never);
    expect(record.compactions).toBe(1);
    const patched = result(on, "1", "ok") as { content: Array<{ text: string }> };
    expect(patched.content.at(-1)?.text).toContain("call finish_case");
    expect(result(on, "2", "ok")).toBeUndefined();
    expect(call(on, "3", "write", { path: "a" })).toBeUndefined();
    await hooks.afterTurn(
      { messages: [] },
      { role: "assistant", stopReason: "stop" } as never,
      async () => {
        expect(call(on, "4", "edit", { path: "a" })).toMatchObject({ block: true });
        expect(call(on, "5", "read", { path: "a" })).toBeUndefined();
        return undefined;
      },
    );
  });
});

describe("auto worker loop guards", () => {
  it("stops 40 calls that use at most 3 different ones", () => {
    const guard = new RepetitionGuard();
    let verdict: ReturnType<RepetitionGuard["onCall"]> = { kind: "ok" };
    for (let i = 0; i < LOOP_WINDOW && verdict.kind !== "stop"; i++) {
      verdict = guard.onCall(`c${i}`, "read", { path: `f${i % 3}`, n: i % 2 === 0 ? 1 : 1 });
      guard.onResult(`c${i}`, `changing result ${i}`);
    }
    expect(verdict).toMatchObject({
      kind: "stop",
      reason: expect.stringContaining("only 3 different"),
    });
  });

  it("nudges once when the same checks repeat with the same results, then stops", () => {
    const guard = new RepetitionGuard();
    const cycle = ["npm run lint", "git status", "npm test -- a", "npm test"];
    const verdicts: string[] = [];
    let n = 0;
    for (let round = 0; round < 6 && verdicts.at(-1) !== "stop"; round++)
      for (const command of cycle) {
        const id = `c${n++}`;
        const verdict = guard.onCall(id, "bash", { command });
        verdicts.push(verdict.kind);
        if (verdict.kind === "ok") guard.onResult(id, `${command}: 12 passed in 0.${n}3s`);
        if (verdict.kind === "stop") break;
      }
    expect(verdicts.slice(0, 8)).toEqual(Array(8).fill("ok"));
    expect(verdicts[8]).toBe("nudge");
    expect(verdicts.at(-1)).toBe("stop");
  });

  it("lets the same check run again when something changed in between", () => {
    const guard = new RepetitionGuard();
    const kinds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const edit = guard.onCall(`e${i}`, "edit", { path: "a.ts", newText: `v${i}` });
      guard.onResult(`e${i}`, "edited");
      const test = guard.onCall(`t${i}`, "bash", { command: "npm test" });
      guard.onResult(`t${i}`, i < 11 ? `${i} failing` : "all pass");
      kinds.push(edit.kind, test.kind);
    }
    expect(new Set(kinds)).toEqual(new Set(["ok"]));
  });

  it("blocks the repeated call with the nudge through the extension, and ends the attempt on a stop", () => {
    const { on, record } = handlers();
    for (let round = 0; round < 3; round++) {
      const verdict = call(on, `a${round}`, "bash", { command: "npm test" });
      if (round < 2) result(on, `a${round}`, "5 passed");
      else expect(verdict).toMatchObject({ block: true, reason: REPEAT_NUDGE });
    }
    call(on, "b0", "bash", { command: "npm test" });
    expect(record.stopped).toContain("loop");
  });

  it("keeps the worker's last few remarks for an attempt without a summary", () => {
    const said = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
    const tool = { role: "assistant", content: [{ type: "toolCall", name: "bash" }] };
    expect(
      lastNotes([
        said("one"),
        tool,
        said("two\n  three"),
        { role: "user", content: [] },
        said("four"),
      ]),
    ).toBe("one … two three … four");
    expect(lastNotes([said("x".repeat(700))], 600)).toHaveLength(601);
    expect(lastNotes([tool])).toBe("");
  });

  it("tells a missing Poundlock from the model's own failure", () => {
    for (const error of [
      "fetch failed",
      "connect ECONNREFUSED 127.0.0.1:7331",
      "Connection error.",
      // The OpenAI client's own timeout, as when this Mac lost its network (14 Oct).
      "Request timed out.",
      "The inference request may already have started. Dispatch will not retry it automatically.",
      "no progress from gate-model for 15 min",
      "Poundlock capacity_in_use wait exhausted. The original request was not resent after the deadline.",
      "502 Bad Gateway",
      // OpenRouter's in-flight credit budget, which settles.
      '402: {"error":{"message":"This request would exceed your available credits given your current in-flight requests.","metadata":{"reason":"in_flight_budget_exhausted","headers":{"Retry-After":"120"}}}}',
      "429 Too Many Requests",
    ])
      expect(isInferenceUnavailable(error), error).toBe(true);
    for (const error of [
      undefined,
      "The worker response was cut off at the output limit.",
      "loop: 40 tool calls with only 2 different ones",
      "case allowance or hard limit reached",
      "Command timed out after 20 min",
      '402: {"error":{"message":"Insufficient credits. Add more using <url>","code":402}}',
    ])
      expect(isInferenceUnavailable(error), String(error)).toBe(false);
  });
});

async function workerSetup(
  respond: (request: ChatRequest, index: number) => ScriptedTurn,
  checks = ["test -f done.txt"],
) {
  const docker = await fakeDocker();
  const worktree = await realpath(await tempDir("auto-worker-tree-"));
  const runDir = await tempDir("auto-worker-run-");
  const name = `dispatch-auto-${runDir.split("-").at(-1)}`;
  const isolation = dockerIsolation({
    docker: docker.docker,
    image: "toolchain:test",
    name,
    worktree,
    readOnly: [],
    env: docker.env,
  });
  await isolation.start();
  const server = await fakePoundlock({ respond });
  const [model] = await new PoundlockClient(server.url, server.token).listInteractiveModels();
  const worker = createAutoWorker({
    project: autoProject({
      runId: "r1",
      worktree,
      baseCommit: "0".repeat(40),
      createdAt: new Date().toISOString(),
      checks,
      protectedPaths: [],
    }),
    model,
    controllerUrl: server.url,
    token: server.token,
    isolation,
    runDir,
    checks,
    prepare: [],
    allowDependencyDownloads: false,
    commandMs: 60_000,
    stallMs: 60_000,
  });
  const input = (extra: Partial<CaseAttemptInput> = {}): CaseAttemptInput => ({
    case: {
      id: "C1",
      title: "write done.txt",
      objective: "Create done.txt containing ok.",
      acceptanceCriteria: "done.txt exists",
      dependsOn: [],
    },
    attempt: 1,
    sessionKey: "C1-session",
    fresh: true,
    learnings: [],
    worktree,
    deadline: new Date(Date.now() + 10 * 60_000),
    signal: new AbortController().signal,
    ...extra,
  });
  return { docker, worktree, runDir, name, isolation, server, worker, input };
}

/** Write, run a command, finish: the three steps a scripted case takes. */
function script(finish: Record<string, unknown> = { status: "done", summary: "wrote done.txt" }) {
  return (request: ChatRequest): ScriptedTurn => {
    const calls = callsSinceLastUser(request);
    if (!calls.length)
      return { toolCalls: [{ name: "write", arguments: { path: "done.txt", content: "ok\n" } }] };
    if (calls.length === 1)
      return {
        toolCalls: [
          { name: "bash", arguments: { command: "cat done.txt && echo ran-in-container" } },
        ],
      };
    return { toolCalls: [{ name: "finish_case", arguments: finish }] };
  };
}

describe("auto worker through Poundlock", () => {
  it("runs a case through Poundlock with its preflight, and every command in the container", async () => {
    const env = await workerSetup(script());
    try {
      const outcome = await env.worker.runCase(env.input());
      expect(outcome).toMatchObject({
        finish: "done",
        summary: "wrote done.txt",
        inferenceUnavailable: false,
      });
      expect(outcome.error).toBeUndefined();
      expect(outcome.usage).toMatchObject({ input: 300, output: 60 });
      expect(await readFile(join(env.worktree, "done.txt"), "utf8")).toBe("ok\n");
      expect(await env.docker.calls()).toContainEqual([
        "exec",
        "-w",
        env.worktree,
        "-e",
        "HOME=/tmp",
        env.name,
        "bash",
        "-c",
        "cat done.txt && echo ran-in-container",
      ]);
      const [first, , third] = env.server.requests;
      expect(first.model).toBe("gate-model");
      const tools = (first.tools ?? []).map((tool) => tool.function?.name);
      expect(tools).toEqual(
        expect.arrayContaining(["read", "write", "edit", "bash", "finish_case"]),
      );
      expect(tools).not.toContain("run_command");
      expect(tools).not.toContain("git_inspect");
      const system = messageText(first.messages[0]);
      expect(system).toContain("Never end your turn without calling finish_case");
      expect(system).toContain("Commands run in a container (toolchain:test), no network.");
      expect(messageText(first.messages.at(-1) ?? {})).toContain(
        "Dispatch accepts the case when these checks pass: `test -f done.txt`.",
      );
      expect(third.messages.map(messageText).join("\n")).toContain("ran-in-container");
      expect(env.server.counts.preflight).toBe(1);
      expect(await env.worker.verify(env.worktree, new AbortController().signal)).toMatchObject({
        passed: true,
        commands: [{ command: "test -f done.txt", exitCode: 0 }],
      });
    } finally {
      await env.server.close();
    }
  });

  it("answers a re-sent edit with the edit guard, and records what it saw", async () => {
    const edit = { oldText: "'hello ' + name", newText: "f'hello {name}'" };
    const env = await workerSetup((request) =>
      callsSinceLastUser(request).length < 2
        ? { toolCalls: [{ name: "edit", arguments: { path: "app.py", edits: [edit] } }] }
        : {
            toolCalls: [
              { name: "finish_case", arguments: { status: "done", summary: "used an f-string" } },
            ],
          },
    );
    try {
      await writeFile(
        join(env.worktree, "app.py"),
        "def greet(name):\n    return 'hello ' + name\n",
      );
      const outcome = await env.worker.runCase(env.input());
      expect(outcome.finish).toBe("done");
      expect(await readFile(join(env.worktree, "app.py"), "utf8")).toBe(
        "def greet(name):\n    return f'hello {name}'\n",
      );
      const told = (env.server.requests.at(-1)?.messages ?? []).map(messageText).join("\n");
      expect(told).toContain(
        "Already applied: the oldText is not in app.py, but the newText is, at line 2.",
      );
      expect(told).not.toContain("must match exactly");
      expect(outcome.editGuard).toMatchObject({ edits: 2, failed: 1, alreadyApplied: 1 });
    } finally {
      await env.server.close();
    }
  });

  it("continues the case's session in a repair, and starts afresh under a new key", async () => {
    const env = await workerSetup(script());
    try {
      await env.worker.runCase(env.input());
      await env.worker.runCase(
        env.input({ attempt: 2, fresh: false, repairFindings: "check failed" }),
      );
      await env.worker.runCase(env.input({ attempt: 3, sessionKey: "C1-session-3", fresh: true }));
      const briefs = (request: ChatRequest) =>
        request.messages.filter((m) => m.role === "user" && messageText(m).includes("## Case C1"))
          .length;
      const firsts = env.server.requests.filter((r) => callsSinceLastUser(r).length === 0);
      expect(firsts.map(briefs)).toEqual([1, 2, 1]);
      expect(messageText(firsts[1].messages.at(-1) ?? {})).toContain("check failed");
    } finally {
      await env.server.close();
    }
  });

  it("nudges a turn that ends without finish_case, and blocks its writes", async () => {
    const env = await workerSetup((request, index) => {
      if (index === 0) return { text: "All done, I think." };
      if (callsSinceLastUser(request).length === 0)
        return { toolCalls: [{ name: "write", arguments: { path: "sneaky.txt", content: "x" } }] };
      return {
        toolCalls: [
          { name: "finish_case", arguments: { status: "partial", summary: "not really" } },
        ],
      };
    });
    try {
      const outcome = await env.worker.runCase(env.input());
      expect(outcome.finish).toBe("partial");
      expect(existsSync(join(env.worktree, "sneaky.txt"))).toBe(false);
      expect(messageText(env.server.requests[1].messages.at(-1) ?? {})).toContain(
        "You ended without calling finish_case",
      );
    } finally {
      await env.server.close();
    }
  });

  it("reports a missing Poundlock as unavailable rather than as the model's failure", async () => {
    const env = await workerSetup(script());
    await env.server.close();
    const outcome = await env.worker.runCase(env.input());
    expect(outcome.finish).toBe("none");
    expect(outcome.inferenceUnavailable, outcome.error).toBe(true);
  });

  it("stops what an interrupted attempt left running and names it", async () => {
    const env = await workerSetup(script());
    try {
      await mkdir(join(env.runDir, "inflight"), { recursive: true });
      await writeFile(
        join(env.runDir, "inflight", "x.json"),
        JSON.stringify({ command: "pytest -x", caseId: "C1", attempt: 1 }),
      );
      const outcome = await env.worker.runCase(env.input({ attempt: 2, fresh: false }));
      expect(outcome.interruptedActions).toEqual(["pytest -x"]);
      const calls = await env.docker.calls();
      expect(calls.some((c) => c.includes("sh") && c.at(-1)?.startsWith("kill -9 -1"))).toBe(true);
      expect(existsSync(join(env.runDir, "inflight", "x.json"))).toBe(false);
    } finally {
      await env.server.close();
    }
  });

  it("leaves nothing an attempt started running once it ends, and clears /tmp before the checks", async () => {
    const env = await workerSetup((request) =>
      callsSinceLastUser(request).length === 0
        ? {
            toolCalls: [
              {
                name: "bash",
                arguments: {
                  command: "(sleep 0.5; echo late > late.txt) >/dev/null 2>&1 & echo started",
                },
              },
            ],
          }
        : { toolCalls: [{ name: "finish_case", arguments: { status: "done", summary: "s" } }] },
    );
    try {
      await env.worker.runCase(env.input());
      await new Promise((done) => setTimeout(done, 900));
      expect(existsSync(join(env.worktree, "late.txt"))).toBe(false);
      await env.worker.verify(env.worktree, new AbortController().signal);
      const calls = (await env.docker.calls()).map((c) => c.at(-1) ?? "");
      const cleared = calls.lastIndexOf("find /tmp -mindepth 1 -delete 2>/dev/null; true");
      expect(cleared).toBeGreaterThan(-1);
      expect(calls.slice(cleared).at(1)).toBe("test -f done.txt");
    } finally {
      await env.server.close();
    }
  });

  it("restarts a stopped container for the checks, and reports a runtime that is down", async () => {
    const env = await workerSetup(script(), ["echo checked"]);
    try {
      const file = join(env.docker.state, "containers", `${env.name}.json`);
      const saved = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...saved, running: false }));
      expect(await env.worker.verify(env.worktree, new AbortController().signal)).toMatchObject({
        passed: true,
      });
      expect((await env.docker.calls()).some((c) => c[0] === "start")).toBe(true);
      await writeFile(join(env.docker.state, "down"), "");
      await expect(env.worker.verify(env.worktree, new AbortController().signal)).rejects.toThrow(
        IsolationUnavailableError,
      );
    } finally {
      await env.server.close();
    }
  });

  it("briefs a repair, a finalization and the case's own scope", () => {
    const base = {
      case: {
        id: "C2",
        title: "t",
        objective: "o",
        acceptanceCriteria: "a",
        dependsOn: [],
        writable: ["src/"],
      },
      attempt: 2,
      sessionKey: "s",
      fresh: false,
      learnings: ["use the helper"],
      worktree: "/w",
      deadline: new Date(),
      signal: new AbortController().signal,
    };
    const repair = caseBrief(
      { ...base, repairFindings: "check failed" },
      { checks: ["npm test"], writable: ["x/"] },
    );
    expect(repair).toContain("You may change only: src/.");
    expect(repair).toContain("- use the helper");
    expect(repair).toContain("## Your previous attempt was not accepted");
    const finalize = caseBrief({ ...base, finalize: true }, { checks: ["npm test"] });
    expect(finalize).toContain("## Time is up for this case");
  });
});
