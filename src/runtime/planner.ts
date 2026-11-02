/**
 * The Planner (ADR 016): a fresh session for each call that reads the run's
 * worktree (read, grep, find, ls) and answers through one `submit` tool. It
 * never writes, runs commands or talks to the owner. Autopilot asks it to
 * plan a milestone's tasks and to review a finished milestone.
 */
import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { PoundlockCapabilities } from "@core/capabilities";
import { isTestFile } from "@core/frozen-tests";
import { runGit } from "@core/git";
import { acceptanceProblems } from "@core/goal/acceptance";
import type { PlannerPort } from "@core/goal/driver";
import {
  answerProblems,
  frozenDecisionPrompt,
  MAX_PLANNED_TASKS,
  milestonePlanPrompt,
  milestoneRequirements,
  milestoneReviewPrompt,
  PLANNER_SYSTEM_PROMPT,
  type PlannerAnswer,
  type PlannerSpec,
  trimPlan,
} from "@core/goal/planner-prompts";
import { sourceProblems } from "@core/goal/research";
import { reviewDepthProblems } from "@core/goal/review-depth";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OUTPUT_LIMIT, runWorkerTurn, workerResponseError } from "@runtime/pi-worker";
import {
  type PolicyExtensionOptions,
  projectFileToolDefinitions,
  projectPolicyExtension,
} from "@runtime/policy-extension";
import { workerProviderOptions } from "@runtime/poundlock-provider";
import { createDispatchPiSession } from "@runtime/sessions";
import { WEB_TOOL_NAMES, type WebTools, webToolDefinitions } from "@runtime/web-tools";
import { isSpendingRefusal, type ModelFallback } from "@shared/spending-limit";
import type {
  InteractiveModel,
  Milestone,
  ProjectRecord,
  ReasoningChoice,
  ReasoningLevel,
} from "@shared/types";
import { Type } from "typebox";

/**
 * The level a run's Planner reasons at. One milestone review replayed on the same inputs:
 * medium named more of the known defects than the default did, for $2.03 against $2.76;
 * low cost $0.15 but read 5 files and named none of them.
 */
export const PLANNER_REASONING: ReasoningLevel = "medium";

export interface PlannerOptions {
  controllerUrl: string;
  token: string;
  model: InteractiveModel;
  reasoning?: ReasoningChoice;
  capabilities?: PoundlockCapabilities;
  lastApprovedRoutingRevision?: string;
  /** The run's worktree, read-only to the Planner. */
  worktree: string;
  /** The run's own project record (`autoProject`), for the file tools' policy. */
  project: ProjectRecord;
  /** Where each call keeps its session: `<dir>/<n>`. */
  dir: string;
  onActivity?: (text: string) => void;
  /** Bounds on one call; tests shorten them. */
  maxToolCalls?: number;
  maxMs?: number;
  /** Web search and page fetch, when the project turned web search on. */
  web?: WebTools;
  /** The owner's local fallback, taken once if the provider refuses for a spending limit. */
  fallback?: InteractiveModel;
  onFallback?: (fallback: ModelFallback) => Promise<void> | void;
}

/** Times the Planner is told what to fix, or to call submit, before the call fails. */
const CORRECTIONS = 2;

/** What a session's replies cost, by the price its model definition carries. */
export function sessionCost(messages: unknown[]): number {
  let total = 0;
  for (const message of messages) {
    const usage = (message as { role?: string; usage?: { cost?: { total?: number } } }).usage;
    if (
      (message as { role?: string }).role === "assistant" &&
      typeof usage?.cost?.total === "number"
    )
      total += usage.cost.total;
  }
  return total;
}

export class PlannerError extends Error {
  constructor(
    message: string,
    /** What the failed call cost all the same, for the goal's spend cap. */
    readonly costUsd = 0,
  ) {
    super(message);
    this.name = "PlannerError";
  }
}

/**
 * Tool calls one Planner call may make: reading a project, not wandering it.
 * A review of a 23-task milestone read 81 times in five minutes of model time
 * and was stopped at the old 80 with nothing submitted.
 */
export const MAX_PLANNER_TOOL_CALLS = 120;
/**
 * How long past its time limit a Planner may still submit, reads refused: a
 * frontier Planner reasoned to the 30-minute limit and was stopped with nothing
 * submitted.
 */
const PLANNER_GRACE_MS = 5 * 60_000;
/** Reads refused past the limit before the Planner is stopped for not answering. */
const MAX_REFUSED_READS = 10;
/**
 * Reads a correction may take on top of what is left: a local Planner whose
 * M1 review was refused after its reads ran out tried to re-read before
 * correcting it, and was stopped instead.
 */
const CORRECTION_READS = 12;
/**
 * How long one Planner call may take, all turns together, waits for a busy
 * model aside. A reasoning model's reply can take minutes on its own: a
 * frontier Planner has taken about three minutes a step.
 */
export const MAX_PLANNER_MS = 30 * 60_000;
/**
 * The same for a model with no price: a local Planner costs only time, and on
 * a workstation's GPUs it read about once every 38 seconds, so a 23-task
 * review did not fit in 30 minutes.
 */
export const LOCAL_PLANNER_MS = 90 * 60_000;

/** How long one call of this Planner may take. */
export function plannerTimeLimit(model: Pick<InteractiveModel, "pricing">): number {
  return model.pricing ? MAX_PLANNER_MS : LOCAL_PLANNER_MS;
}

export type Planner = PlannerPort;

const TaskSchema = Type.Object({
  title: Type.String(),
  objective: Type.String(),
  acceptanceCriteria: Type.String(),
  requirementIds: Type.Array(Type.String()),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  filesToTouch: Type.Optional(Type.Array(Type.String())),
  writesTests: Type.Optional(Type.Boolean()),
  changesFrozenTests: Type.Optional(Type.Array(Type.String())),
  frozenChangeReason: Type.Optional(Type.String()),
  acceptanceTests: Type.Optional(
    Type.Array(Type.Object({ path: Type.String(), content: Type.String() })),
  ),
  sources: Type.Optional(Type.Array(Type.String())),
});

const AnswerSchema = Type.Object({
  tasks: Type.Array(TaskSchema),
  verdicts: Type.Array(
    Type.Object({
      requirementId: Type.String(),
      result: Type.Union([
        Type.Literal("shown"),
        Type.Literal("partly"),
        Type.Literal("not shown"),
      ]),
      note: Type.String(),
      scenarios: Type.Optional(
        Type.Array(
          Type.Object({
            scenario: Type.Number(),
            files: Type.Array(Type.String()),
            finding: Type.String(),
          }),
        ),
      ),
      promises: Type.Optional(
        Type.Array(
          Type.Object({
            promise: Type.String(),
            files: Type.Array(Type.String()),
            finding: Type.String(),
          }),
        ),
      ),
    }),
  ),
  complete: Type.Boolean(),
  notes: Type.Optional(Type.String()),
  allowFrozenTests: Type.Optional(
    Type.Array(Type.Object({ path: Type.String(), reason: Type.String() })),
  ),
  sources: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        url: Type.String(),
        title: Type.String(),
        excerpt: Type.String(),
      }),
    ),
  ),
});

/** The worktree's tracked files; none when Git cannot list them. */
async function trackedFiles(worktree: string): Promise<string[]> {
  const listed = await runGit(worktree, ["ls-files"]).catch(() => undefined);
  if (!listed || listed.code !== 0) return [];
  return listed.stdout.split("\n").filter(Boolean);
}

/** The worktree's tracked test files. */
async function testFiles(worktree: string): Promise<string[]> {
  // Workers name these files: a long name is cut, and the prompt marks them as data.
  return (await trackedFiles(worktree))
    .filter(isTestFile)
    .map((path) => (path.length > 200 ? `${path.slice(0, 200)}…` : path));
}

/**
 * What to ask a Planner whose reply ran past the model's output limit. "Shorter"
 * alone did not work: a local Planner capped at 8K tokens answered a milestone
 * in full three times and ended the run. A plan or review is asked
 * for its first few tasks, fewer each time, and the milestone's review plans the rest.
 */
export function cutOffRequest(kind: "plan" | "review" | "frozen", earlier: number): string {
  if (kind === "frozen")
    return "Your reply was cut off at the output limit. Keep your reasoning brief and call submit now.";
  const tasks = PART_TASKS[Math.min(earlier, PART_TASKS.length - 1)];
  return `Your reply was cut off at the output limit. Call submit now with at most ${tasks} tasks: the first ones in order, each with a one-sentence objective and short acceptance criteria. Leave the rest out; the milestone's review plans them.`;
}

/** The start and end of a reply cut off at the output limit, for working out why it ran long. */
async function keepCutOff(dir: string, index: number, messages: unknown[]): Promise<void> {
  const last = [...messages]
    .reverse()
    .find((item) => (item as { role?: string }).role === "assistant");
  if (!last) return;
  const text = JSON.stringify((last as { content?: unknown }).content ?? "");
  const kept = text.length > 8000 ? `${text.slice(0, 4000)}\n…\n${text.slice(-4000)}` : text;
  await writeFile(join(dir, `cut-off-${index + 1}.txt`), `${text.length} characters\n${kept}\n`, {
    mode: 0o600,
  });
}

/** A connection that broke mid-call, as the provider's stream or the HTTP client reports it. */
export const isDroppedConnection = (reason: string) =>
  /^ambiguous_inference: The provider stream ended|^Connection error/.test(reason);
/** Dropped connections one Planner call gets past. */
const MAX_DROPS = 2;

/** How many tasks a cut-off Planner is asked for, the first time and after. */
const PART_TASKS = [8, 4];

export function createPlanner(options: PlannerOptions): Planner {
  let calls = 0;
  let model = options.model;
  let approvedRevision = options.lastApprovedRoutingRevision;
  const askOnce = async (
    kind: "plan" | "review" | "frozen",
    milestone: Milestone,
    prompt: string,
    signal?: AbortSignal,
    unfinished: string[] = [],
    blocked: string[] = [],
    /** More problems the answer must be free of: a gating Planner's acceptance tests. */
    moreProblems: (
      answer: PlannerAnswer,
      cut: boolean,
      wasRead: (path: string) => boolean,
    ) => string[] = () => [],
  ): Promise<PlannerAnswer> => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const dir = join(options.dir, String(++calls));
    // Each Planner call gets its own allowance of searches and fetches.
    options.web?.resetLimits();
    let answer: PlannerAnswer | undefined;
    const policy: PolicyExtensionOptions = {
      projectRoot: options.worktree,
      cwd: options.worktree,
      project: options.project,
      trust: "full",
      bashEnabled: false,
      signal,
    };
    // The Planner's minutes stop while its model is busy with other work, such
    // as another client's durable job.
    let waitingSince: number | undefined;
    let waitedMs = 0;
    const provider = workerProviderOptions({
      controllerUrl: options.controllerUrl,
      token: options.token,
      model,
      capabilities: options.capabilities,
      lastApprovedRoutingRevision: approvedRevision,
      session: `planner-${milestone.id}`,
      onCapacityWait: () => {
        waitingSince ??= Date.now();
        options.onActivity?.(`Planner: waiting for ${model.id}`);
      },
    });
    const maxMs = options.maxMs ?? plannerTimeLimit(model);
    const startedAt = Date.now();
    let warnedTime = false;
    const maxCalls = options.maxToolCalls ?? MAX_PLANNER_TOOL_CALLS;
    let allowance = maxCalls;
    let refused = 0;
    let rejected: string | undefined;
    const projectPath = (path: string) =>
      relative(options.worktree, resolve(options.worktree, path));
    const readFiles = new Set<string>();
    const { session } = await createDispatchPiSession({
      cwd: options.worktree,
      agentDir: dir,
      sessionDir: join(dir, "session"),
      model,
      // Only a level this model lists: the local fallback may list none.
      reasoning: (model.reasoningLevels as readonly string[] | undefined)?.includes(
        options.reasoning ?? "",
      )
        ? options.reasoning
        : undefined,
      controllerUrl: options.controllerUrl,
      token: options.token,
      systemPrompt: options.web
        ? `${PLANNER_SYSTEM_PROMPT} You can also search the web (web_search, web_fetch) for public facts, such as how the product being built behaves or what a library offers; never put the project's code, paths or names in a query.`
        : PLANNER_SYSTEM_PROMPT,
      tools: ["read", "grep", "find", "ls", "submit", ...(options.web ? WEB_TOOL_NAMES : [])],
      excludeTools: ["powershell", "bash", "write", "edit"],
      customTools: [
        ...projectFileToolDefinitions(pi, policy),
        ...(options.web ? webToolDefinitions(pi.defineTool, options.web) : []),
        pi.defineTool({
          name: "submit",
          label: "Submit",
          description: "Your answer: tasks, verdicts, complete, and notes for the owner.",
          parameters: AnswerSchema,
          // The answer ends the turn: a local Planner submitted at 43 minutes and
          // then submitted again 32 times until its 90 ran out.
          execute: async (_id: string, params: PlannerAnswer) => {
            answer = params;
            return {
              content: [{ type: "text" as const, text: "Recorded." }],
              details: {},
              terminate: true,
            };
          },
        }),
      ],
      extensionFactories: [
        projectPolicyExtension(policy),
        // Told once, at half its time, to decide: a frontier Planner reasoned 12–15K
        // tokens between reads and reached the limit with nothing submitted.
        // Past its tool calls, reading stops and only submit is left: told
        // in a note, a frontier Planner read on for 40 more calls.
        (pi: ExtensionAPI) =>
          pi.on("tool_call", (event) => {
            const outOfTime = Date.now() - startedAt - waitedMs > maxMs;
            if (event.toolName === "submit" || (toolCalls < allowance && !outOfTime))
              return undefined;
            if (++refused > MAX_REFUSED_READS)
              stopWith(
                rejected
                  ? `The Planner's answer cannot be used (${rejected}), and it read on instead of correcting it.`
                  : `The Planner made ${maxCalls} tool calls without answering.`,
              );
            // A correction says again what to fix: a local Planner sent back for
            // one missing field re-read the project and never resubmitted.
            return {
              block: true,
              reason: rejected
                ? `No more reading: call submit now with your earlier answer, corrected. ${rejected}`
                : outOfTime
                  ? "Time is up for this answer: call submit now with what you have found."
                  : "No more reading for this answer: call submit now with what you have found.",
            };
          }),
        // Also told at two thirds of its tool calls.
        (pi: ExtensionAPI) =>
          pi.on("tool_result", (event) => {
            if (event.toolName === "read" && !event.isError)
              readFiles.add(projectPath(String(event.input.path)));
            const left = maxMs - (Date.now() - startedAt - waitedMs);
            const callsLeft = allowance - toolCalls;
            if (warnedTime || (left > maxMs / 2 && callsLeft > maxCalls / 3)) return undefined;
            warnedTime = true;
            const minutes = Math.max(1, Math.round(left / 60_000));
            return {
              content: [
                ...(event.content ?? []),
                {
                  type: "text" as const,
                  text: `\n[About ${minutes} min and ${callsLeft} tool calls left for this answer. Read nothing more unless you must: decide, and call submit.]`,
                },
              ],
            };
          }),
      ],
      fresh: true,
      // Planning unblocks the workers, so it goes ahead of them in Poundlock's line.
      provider: { ...provider, queue: { priority: "planner", session: `planner-${milestone.id}` } },
    });
    // Bounded by itself: the run's hour limits and spend cap are checked only
    // between calls, and a Planner that keeps reading would never reach them.
    let toolCalls = 0;
    let bounded: string | undefined;
    const stopWith = (reason: string) => {
      bounded ??= reason;
      void session.abort();
    };
    const timer = setInterval(
      () => {
        const waiting = waitingSince === undefined ? 0 : Date.now() - waitingSince;
        const used = Date.now() - startedAt - waitedMs - waiting;
        // At the limit reading stops (below) and submit is still taken; only a
        // Planner that has not answered a grace period later is stopped.
        if (used > maxMs + Math.min(PLANNER_GRACE_MS, maxMs / 4))
          stopWith(`The Planner took longer than ${maxMs / 60_000} minutes.`);
      },
      Math.min(5_000, Math.max(10, maxMs / 4)),
    );
    const unsubscribe = session.subscribe((event: { type: string }) => {
      if (waitingSince !== undefined) {
        waitedMs += Date.now() - waitingSince;
        waitingSince = undefined;
      }
      if (event.type === "tool_execution_start") toolCalls++;
    });
    const abort = () => void session.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const fail = (message: string) => new PlannerError(message, sessionCost(session.messages));
    try {
      if (signal?.aborted) throw fail("The Planner was stopped.");
      options.onActivity?.(
        kind === "frozen"
          ? `Planner: deciding on frozen tests ${blocked.join(", ")}`
          : `Planner: ${kind === "plan" ? "planning" : "reviewing"} ${milestone.id}`,
      );
      let last = await runWorkerTurn(session, prompt);
      let cutOffs = 0;
      let drops = 0;
      for (let round = 0; round <= CORRECTIONS; round++) {
        if (signal?.aborted) throw fail("The Planner was stopped.");
        if (bounded) throw fail(bounded);
        if (answer) {
          let cut = false;
          // Still too long after the corrections: keep the first tasks, and the review plans the rest.
          if (
            round === CORRECTIONS &&
            kind !== "frozen" &&
            answer.tasks.length > MAX_PLANNED_TASKS
          ) {
            const planned = answer.tasks.length;
            answer = { ...answer, tasks: trimPlan(answer.tasks) };
            cut = true;
            options.onActivity?.(
              `Planner: kept the first ${answer.tasks.length} of ${planned} tasks; the review plans the rest`,
            );
          }
          const problems = [
            ...answerProblems(answer, milestone, kind, unfinished, blocked),
            ...moreProblems(answer, cut, (path) => readFiles.has(projectPath(path))),
          ];
          if (!problems.length) return { ...answer, costUsd: sessionCost(session.messages) };
          if (round === CORRECTIONS)
            throw fail(`The Planner's answer cannot be used: ${problems.join(" ")}`);
          answer = undefined;
          rejected = problems.join(" ");
          allowance = Math.max(allowance, toolCalls + CORRECTION_READS);
          refused = 0;
          last = await runWorkerTurn(
            session,
            `Your answer cannot be used: ${problems.join(" ")} Call submit again with the corrected answer.`,
          );
          continue;
        }
        const failed = workerResponseError(last, session.getContextUsage());
        // A reply cut off at the output limit is asked again, shorter: a frontier
        // Planner's reasoning ran past 8K tokens and ended a run.
        const cutOff = failed === OUTPUT_LIMIT;
        // What ran long is otherwise lost with the session: keep its ends beside the call.
        if (cutOff) await keepCutOff(dir, cutOffs, session.messages).catch(() => undefined);
        // Planner calls only read, so asking again is safe, and the session keeps what it read:
        // a reset connection ended a BM-D review replay four minutes in (2 Nov).
        if (failed && isDroppedConnection(failed) && drops < MAX_DROPS) {
          drops++;
          round--;
          options.onActivity?.("Planner: the provider dropped the connection; asking again");
          last = await runWorkerTurn(
            session,
            "The connection dropped before your reply arrived. Carry on, and call submit when you are ready.",
          );
          continue;
        }
        if (failed && failed !== "Incomplete model response" && !cutOff) throw fail(failed);
        if (round === CORRECTIONS) throw fail(cutOff ? failed : "The Planner did not call submit.");
        last = await runWorkerTurn(
          session,
          cutOff ? cutOffRequest(kind, cutOffs++) : "Call submit now with your answer.",
        );
      }
      throw fail("The Planner did not call submit.");
    } finally {
      clearInterval(timer);
      if (typeof unsubscribe === "function") unsubscribe();
      signal?.removeEventListener("abort", abort);
      session.dispose();
    }
  };
  // A spending refusal does not pass with waiting: the call is asked again,
  // once, of the owner's local fallback, which the rest of the run keeps.
  const ask: typeof askOnce = async (...args) => {
    try {
      return await askOnce(...args);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const fallback = options.fallback;
      if (!fallback || model === fallback || !isSpendingRefusal(reason)) throw error;
      const from = model.id;
      model = fallback;
      approvedRevision = fallback.routingRevision;
      await options.onFallback?.({ role: "planner", from, to: fallback.id, reason });
      return askOnce(...args);
    }
  };
  // A gating Planner's acceptance tests, and the excerpts it saves, which must be text it read.
  const checks = async (spec: PlannerSpec, milestone: Milestone, kind: "plan" | "review") => {
    const tracked = spec.acceptanceFirst ? await trackedFiles(options.worktree) : [];
    const web = spec.research ? options.web : undefined;
    return (answer: PlannerAnswer, cut: boolean, wasRead: (path: string) => boolean) => [
      ...(spec.acceptanceFirst
        ? acceptanceProblems(answer, milestone, tracked, kind === "plan" && !cut)
        : []),
      ...(spec.acceptanceFirst && kind === "review"
        ? reviewDepthProblems(answer, milestoneRequirements(spec, milestone), wasRead)
        : []),
      ...(web ? sourceProblems(answer, (url) => web.read(url)) : []),
    ];
  };
  return {
    planMilestone: async (input) =>
      ask(
        "plan",
        input.milestone,
        milestonePlanPrompt(input.spec, input.milestone, input.done, input.ownerNotes),
        input.signal,
        [],
        [],
        await checks(input.spec, input.milestone, "plan"),
      ),
    reviewMilestone: async (input) =>
      ask(
        "review",
        input.milestone,
        milestoneReviewPrompt(
          input.spec,
          input.milestone,
          input.accepted,
          input.ownerNotes,
          input.unfinished,
          await testFiles(options.worktree),
          input.unchanged,
        ),
        input.signal,
        input.unfinished,
        [],
        await checks(input.spec, input.milestone, "review"),
      ),
    decideFrozenTests: (input) =>
      ask(
        "frozen",
        input.milestone,
        frozenDecisionPrompt(input.spec, input.milestone, input.task, input.tests),
        input.signal,
        [],
        input.tests,
      ),
  };
}
