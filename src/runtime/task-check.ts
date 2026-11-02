import type { TaskCheck, TaskCheckInput } from "@core/auto/ports";
import type { InteractiveModel } from "@shared/types";

/** Characters of test files one check reads; a local model answers in seconds at this size. */
const TEST_CHARS = 30_000;
const MAX_GAPS = 4;
const CHECK_MS = 5 * 60_000;

/**
 * Scoped to what the message itself can show. Asked to judge facts as well, a local model
 * called correct star coordinates wrong from memory; asked only this, it found tests that
 * contradicted their task's criteria, at about 7 seconds a task.
 */
const SYSTEM =
  'You have no tools; everything is in the message. You compare a finished task\'s tests with its acceptance criteria. Report only these: a number, time, tolerance or case the criteria name that no test checks; a test whose tolerance is wider than the criteria\'s; a test that asserts what the code returns instead of the criteria\'s value, or the opposite of what the criteria say. Quote the criterion each time. Never judge from memory whether a fact, constant, coordinate or formula is right. Skip criteria about documents, wording, names, file layout or style, and criteria that existing tests elsewhere cover. Reply with JSON only: {"gaps": ["..."]}, at most 4, empty when the tests check what the criteria ask.';

export function taskCheckPrompt(input: TaskCheckInput): string {
  const files = input.tests.map((test) => `\n--- ${test.path}\n${test.text}`).join("");
  return `Task: ${input.title}\n\nAcceptance criteria:\n${input.acceptanceCriteria}\n\nFiles it changed: ${input.changed.join(", ")}\n\nIts test files as they now stand:${files.slice(0, TEST_CHARS) || " none"}\n\nAnswer with the JSON only.`;
}

/** The gaps in a model's reply; throws when it holds no such JSON, so the caller can go on without. */
export function parseGaps(reply: string): string[] {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (!json) throw new Error("The task check's reply held no JSON.");
  const gaps = (JSON.parse(json) as { gaps?: unknown }).gaps;
  if (!Array.isArray(gaps)) throw new Error("The task check's reply listed no gaps.");
  return gaps
    .filter((gap): gap is string => typeof gap === "string" && Boolean(gap.trim()))
    .slice(0, MAX_GAPS);
}

/** The check after a passing task, on the run's own local worker model. Never sent off the network. */
export function createTaskCheck(options: {
  controllerUrl: string;
  token: string;
  model: Pick<InteractiveModel, "id" | "dataDestination">;
  fetch?: typeof fetch;
}): TaskCheck | undefined {
  if (options.model.dataDestination !== "operator_network") return undefined;
  const post = options.fetch ?? fetch;
  return async (input, signal) => {
    const response = await post(`${options.controllerUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
        "Poundlock-Wait": "110",
      },
      body: JSON.stringify({
        model: options.model.id,
        max_tokens: 2000,
        temperature: 0.1,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: taskCheckPrompt(input) },
        ],
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(CHECK_MS)]),
    });
    if (!response.ok) throw new Error(`The task check got HTTP ${response.status}.`);
    const answer = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseGaps(answer.choices?.[0]?.message?.content ?? "");
  };
}
