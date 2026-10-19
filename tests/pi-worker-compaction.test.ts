/**
 * A worker that compacts says so, in its activity trail and with its attempt.
 * The session is the one a worker gets from `createDispatchPiSession`, and Pi
 * really compacts it against a synthetic server.
 */
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { bindWorkerActivity, LiveWorkBook, workerActivityPhase } from "@core/live-work";
import { recordWorkerCompactions } from "@runtime/pi-worker";
import { workerProviderOptions } from "@runtime/poundlock-provider";
import { createDispatchPiSession } from "@runtime/sessions";
import {
  type CompactionSummary,
  compactionEvidenceText,
  compactionsFromProvenance,
} from "@shared/compaction";
import type { InteractiveModel } from "@shared/types";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const MODEL: InteractiveModel = { id: "fixture", context_tokens: 8192, max_output_tokens: 1024 };

it("puts a worker's compaction in its activity trail and keeps the numbers with the attempt", async () => {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ api_major: 1, contract_revision: 2, features: [] }));
      return;
    }
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: `Answer ${requests.length}.` }, finish_reason: null }] })}\n\n`,
    );
    // Every reply reports a nearly full window, so Pi compacts after each turn.
    res.end(
      `data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 6980, completion_tokens: 20, total_tokens: 7000 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const controllerUrl = `http://127.0.0.1:${port}`;
  const root = await tempDir("dispatch-worker-compaction-");
  const cwd = join(root, "project");
  await mkdir(cwd);
  const { session } = await createDispatchPiSession({
    cwd,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    model: MODEL,
    controllerUrl,
    token: "synthetic",
    systemPrompt: "You are a worker.",
    tools: ["read"],
    customTools: [],
    provider: workerProviderOptions({
      controllerUrl,
      token: "synthetic",
      model: MODEL,
      capabilities: { api_major: 1, contract_revision: 2, features: [] },
    }),
  });
  const trail = new LiveWorkBook();
  const stopActivity = bindWorkerActivity((listener) => session.subscribe(listener), {
    modelId: MODEL.id,
    cwd,
    initial: "Waiting for fixture",
    intervalMs: 3_600_000,
    onActivity: (text) => trail.record("project", text, "2026-01-01T00:00:00.000Z"),
  });
  const result: { compactions?: CompactionSummary[] } = {};
  recordWorkerCompactions((listener) => session.subscribe(listener), result);
  try {
    for (const marker of ["one", "two", "three", "four"])
      await session.prompt(`${marker} ${"detail ".repeat(1500)}`);
  } finally {
    stopActivity();
    session.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const summaries = requests.filter((request) =>
    JSON.stringify(request.messages).includes("context summarization assistant"),
  );
  expect(summaries.length).toBeGreaterThan(0);

  const lines = trail.view("project").liveWork.map((entry) => entry.text);
  expect(lines).toContain("fixture: compacting its conversation");
  expect(
    lines.some((line) =>
      /^fixture: compacted its conversation \(about [\d,]+ down to about [\d,]+ tokens\)$/.test(
        line,
      ),
    ),
  ).toBe(true);

  expect(result.compactions?.length).toBe(summaries.length);
  for (const compaction of result.compactions ?? []) {
    expect(compaction.reason).toBe("threshold");
    expect(compaction.tokensBefore).toBeGreaterThan(0);
    expect(compaction.tokensAfter).toBeLessThan(compaction.tokensBefore);
  }
});

it("reads a compaction's phase, and ignores one nobody needs told about", () => {
  const phase = (event: Record<string, unknown>) =>
    workerActivityPhase("qwen", { type: "compaction_end", reason: "threshold", ...event }, "/tmp");
  expect(phase({ result: { tokensBefore: 24_040, estimatedTokensAfter: 6_120 } })).toBe(
    "qwen: compacted its conversation (about 24,000 down to about 6,100 tokens)",
  );
  expect(phase({ errorMessage: "Auto-compaction failed: boom" })).toBe(
    "qwen: compaction failed, continuing with its full conversation",
  );
  // Cancelled by a pause or an abort: not news.
  expect(phase({ aborted: true })).toBeUndefined();
  expect(
    workerActivityPhase("qwen", { type: "compaction_start", reason: "threshold" }, "/tmp"),
  ).toBe("qwen: compacting its conversation");
});

it("puts the attempt's compactions in its evidence", () => {
  const recorded = [
    { status: "compacted", reason: "threshold", tokensBefore: 24_040, tokensAfter: 6_120 },
    { status: "compacted", reason: "threshold", tokensBefore: 23_900, tokensAfter: 7_300 },
  ];
  const parsed = compactionsFromProvenance({ model: "qwen", compactions: recorded });
  expect(compactionEvidenceText(parsed)).toBe(
    "Compacted 2 times (about 23,900 down to about 7,300 tokens the last time): older steps were summarised.",
  );
  expect(compactionEvidenceText(parsed.slice(0, 1))).toBe(
    "Compacted once (about 24,000 down to about 6,100 tokens): older steps were summarised.",
  );
  expect(compactionEvidenceText(compactionsFromProvenance({ model: "qwen" }))).toBeUndefined();
  expect(compactionsFromProvenance({ compactions: "not a list" })).toEqual([]);
});
