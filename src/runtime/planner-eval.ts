/**
 * Runs one Planner evaluation (`core/goal/planner-eval.ts`): the fixture's
 * commit checked out read-only in a scratch worktree, one Planner call with
 * the chosen model through Poundlock, the session's time, calls and tokens
 * read back, and the answer scored.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  PLANNER_EVAL_SCHEMA,
  type PlannerEvalFixture,
  type PlannerEvalResult,
  type PlannerEvalRun,
  scorePlannerEval,
} from "@core/goal/planner-eval";
import { PoundlockClient } from "@core/poundlock";
import { autoProject } from "@runtime/auto-session";
import { createPlanner, PlannerError } from "@runtime/planner";
import type { ConnectionSettings } from "@shared/types";

const run = promisify(execFile);

/** The fixture's commit as a full id, refused unless it names a commit. */
async function resolveCommit(repo: string, commit: string): Promise<string> {
  if (!/^[0-9a-f]{4,64}$/i.test(commit))
    throw new Error("The fixture's commit must be a hex commit id.");
  const { stdout } = await run("git", [
    "-C",
    repo,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${commit}^{commit}`,
  ]);
  return stdout.trim();
}

export async function runPlannerEval(
  fixture: PlannerEvalFixture,
  options: {
    connection: ConnectionSettings;
    model: string;
    /** A scratch folder for the worktree and the Planner's session; emptied first. */
    dir: string;
    fetch?: typeof fetch;
    onActivity?: (text: string) => void;
  },
): Promise<PlannerEvalResult> {
  if (fixture.schema !== PLANNER_EVAL_SCHEMA)
    throw new Error(`The fixture is not a ${PLANNER_EVAL_SCHEMA} fixture.`);
  if (!options.connection.url || !options.connection.token)
    throw new Error("No Poundlock connection is saved on this machine.");
  const client = new PoundlockClient(
    options.connection.url,
    options.connection.token,
    options.fetch,
  );
  const model = (await client.listInteractiveModels()).find((item) => item.id === options.model);
  if (!model) throw new Error(`Poundlock does not serve ${options.model}.`);
  const capabilities = await client.capabilities().catch(() => undefined);

  await rm(options.dir, { recursive: true, force: true });
  await mkdir(options.dir, { recursive: true });
  const worktree = join(options.dir, "work");
  await run("git", [
    "-C",
    fixture.repo.path,
    "worktree",
    "add",
    "--detach",
    worktree,
    // Only a commit: the fixture's value never reaches git as an option.
    `${await resolveCommit(fixture.repo.path, fixture.repo.commit)}`,
  ]);
  const plannerDir = join(options.dir, "planner");
  const started = Date.now();
  let answer: PlannerEvalRun["answer"];
  let error: string | undefined;
  let failedCost = 0;
  try {
    const planner = createPlanner({
      controllerUrl: options.connection.url,
      token: options.connection.token,
      model,
      capabilities,
      lastApprovedRoutingRevision: model.routingRevision,
      worktree,
      project: autoProject({
        runId: `eval-${fixture.name}`,
        worktree,
        baseCommit: fixture.repo.commit,
        createdAt: new Date().toISOString(),
        checks: fixture.spec.checks,
        protectedPaths: [],
      }),
      dir: plannerDir,
      onActivity: options.onActivity,
    });
    const milestone = fixture.spec.milestones.find((item) => item.id === fixture.milestone);
    if (!milestone) throw new Error(`The spec has no milestone ${fixture.milestone}.`);
    answer =
      fixture.kind === "review"
        ? await planner.reviewMilestone({
            spec: fixture.spec,
            milestone,
            accepted: fixture.accepted ?? [],
            unfinished: fixture.unfinished ?? [],
          })
        : await planner.decideFrozenTests({
            spec: fixture.spec,
            milestone,
            task: { title: fixture.frozen?.task ?? "", failure: fixture.frozen?.failure ?? "" },
            tests: fixture.frozen?.tests ?? [],
          });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    if (caught instanceof PlannerError) failedCost = caught.costUsd ?? 0;
  } finally {
    await run("git", ["-C", fixture.repo.path, "worktree", "remove", "--force", worktree]).catch(
      () => undefined,
    );
  }
  const stats = await sessionStats(plannerDir);
  return scorePlannerEval(fixture, {
    model: model.id,
    ...(answer ? { answer } : {}),
    ...(error ? { error } : {}),
    seconds: (Date.now() - started) / 1000,
    ...stats,
    costUsd: answer?.costUsd ?? failedCost,
  });
}

/** Replies, tool calls, cut-offs and tokens across a Planner's saved sessions. */
async function sessionStats(
  dir: string,
): Promise<Pick<PlannerEvalRun, "replies" | "toolCalls" | "cutOffs" | "tokens">> {
  const stats = {
    replies: 0,
    toolCalls: 0,
    cutOffs: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
  };
  const files = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
    for (const line of (await readFile(join(dir, file), "utf8")).split("\n")) {
      if (!line.trim()) continue;
      let message: {
        role?: string;
        stopReason?: string;
        content?: Array<{ type?: string }>;
        usage?: { input?: number; output?: number; cacheRead?: number; reasoning?: number };
      };
      try {
        message = JSON.parse(line).message ?? {};
      } catch {
        continue;
      }
      if (message.role !== "assistant") continue;
      stats.replies++;
      stats.toolCalls += (message.content ?? []).filter((part) => part.type === "toolCall").length;
      if (message.stopReason === "length") stats.cutOffs++;
      stats.tokens.input += message.usage?.input ?? 0;
      stats.tokens.output += message.usage?.output ?? 0;
      stats.tokens.cacheRead += message.usage?.cacheRead ?? 0;
      stats.tokens.reasoning += message.usage?.reasoning ?? 0;
    }
  }
  return stats;
}
