/**
 * Four representative edit failures, replayed through Dispatch's worker file
 * tools with and without the edit guard.
 *
 * Each fixture in `fixtures/edit-replays` is synthetic: a small recipe-search
 * project's file as the model last saw it, and the read, write and edit calls a
 * worker made on it, with the message Pi's own tools give each one. Replaying
 * the calls without the guard reproduces those messages; the tests below show
 * what the model is told instead.
 */
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EDIT_LOOP_LIMIT } from "@runtime/edit-guard";
import { describe, expect, it } from "vitest";
import { type ToolOutcome, workerFileTools } from "./support/edit-guard-harness";
import { tempDir } from "./support/temp-dir";

interface Step {
  call: number;
  tool: "read" | "write" | "edit";
  edits?: Array<{ oldText: string; newText: string }>;
  content?: string;
  /** Pi's message for this call without the guard, with the project path removed. */
  piResult?: string;
}

interface Example {
  example: string;
  model: string;
  transcript: string;
  file: string;
  content: string;
  steps: Step[];
}

async function load(name: string): Promise<Example> {
  const url = new URL(`./fixtures/edit-replays/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as Example;
}

type Tools = ReturnType<typeof workerFileTools>;

function run(tools: Tools, path: string, step: Step): Promise<ToolOutcome> {
  if (step.tool === "read") return tools.read(path);
  if (step.tool === "write") return tools.write(path, step.content ?? "");
  return tools.edit(path, step.edits ?? []);
}

async function project(example: Example) {
  const root = await realpath(await tempDir("dispatch-edit-replay-"));
  const path = join(root, example.file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, example.content);
  return { root, path, shown: (text: string) => text.replaceAll(`${root}/`, "") };
}

/**
 * The message Pi gave one recorded call, and the guard's message for it: the
 * calls before it replayed without the guard, then a guarded worker whose last
 * view is the file as it stands (nothing else changed these files).
 */
async function oldAndNew(example: Example, call: number) {
  const { root, path, shown } = await project(example);
  const plain = workerFileTools(root, { guard: false });
  for (const step of example.steps) {
    if (step.call >= call) break;
    await run(plain, path, step);
  }
  const step = example.steps.find((item) => item.call === call);
  if (!step) throw new Error(`No call ${call}`);
  const original = await run(workerFileTools(root, { guard: false }), path, step);
  const guarded = workerFileTools(root);
  await guarded.read(path);
  const outcome = await run(guarded, path, step);
  expect(original.isError && outcome.isError).toBe(true);
  return { old: shown(original.text), now: shown(outcome.text), recorded: step.piResult };
}

/** The whole recorded sequence through one worker, and the longest run of failed edits. */
async function sequence(example: Example, guard: boolean) {
  const { root, path } = await project(example);
  const tools = workerFileTools(root, { guard });
  if (example.steps[0].tool !== "read") await tools.read(path);
  let streak = 0;
  let longest = 0;
  let blocked = 0;
  for (const step of example.steps) {
    const outcome = await run(tools, path, step);
    if (step.tool !== "edit") continue;
    if (outcome.blocked) blocked += 1;
    else streak = outcome.isError ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  return { longest, blocked, evidence: tools.guard?.evidence() };
}

const PI_NOT_FOUND = "The old text must match exactly including all whitespace and newlines.";

describe("edit failures, replayed", () => {
  it("reproduces Pi's messages without the guard", async () => {
    for (const name of ["loop-on-stale-tracker", "reapplied-fix", "misquote", "indentation"]) {
      const example = await load(name);
      const { root, path, shown } = await project(example);
      const tools = workerFileTools(root, { guard: false });
      for (const step of example.steps) {
        const outcome = await run(tools, path, step);
        if (step.piResult !== undefined)
          expect(shown(outcome.text), `${name} call ${step.call}`).toBe(step.piResult);
      }
    }
  });

  it("1. a loop on its own stale text: already applied, then stopped at three", async () => {
    const example = await load("loop-on-stale-tracker");
    const tracker = "changes/search-filters/progress.md";
    // The edit it keeps sending: the row already has this wording.
    const repeated = await oldAndNew(example, 2);
    expect(repeated.old).toBe(repeated.recorded);
    expect(repeated.old).toBe(`Could not find the exact text in ${tracker}. ${PI_NOT_FOUND}`);
    expect(repeated.now).toBe(
      `Already applied: the oldText is not in ${tracker}, but the newText is, at line 11. This change is already made, so nothing was changed. Do not send it again; go on to your next step.`,
    );
    // Its no-op edits.
    const noop = await oldAndNew(example, 3);
    expect(noop.old).toContain("This might indicate an issue with special characters");
    expect(noop.now).toBe(
      `No change: the newText is the same as the oldText, so this edit would not change ${tracker}. That text is at line 12. If the file already says what you want, the change is made: go on to your next step. Otherwise put the text you want in newText.`,
    );
    // Its edit of a row it had already rewritten in other words.
    const reworded = await oldAndNew(example, 5);
    expect(reworded.old).toBe(`Could not find the exact text in ${tracker}. ${PI_NOT_FOUND}`);
    expect(reworded.now).toContain(
      "Line 11 already looks like your newText (98% similar), so this change may already be made: check before sending it again.",
    );
    expect(reworded.now).toContain("Lines 9-13 as the file has them now:");

    const before = await sequence(example, false);
    const after = await sequence(example, true);
    expect(before.longest).toBe(16);
    expect(after.longest).toBe(EDIT_LOOP_LIMIT);
    expect(after.evidence?.loops).toEqual([{ path: tracker, failures: 3, blocked: 13 }]);
  });

  it("2. re-applying a fix already made: already applied, not special characters", async () => {
    const example = await load("reapplied-fix");
    const file = "tests/test_search_filters.py";
    const noop = await oldAndNew(example, 3);
    expect(noop.old).toBe(noop.recorded);
    expect(noop.old).toBe(
      `No changes made to ${file}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
    expect(noop.now).toBe(
      `No change: the newText is the same as the oldText, so this edit would not change ${file}. That text is at lines 22-27. If the file already says what you want, the change is made: go on to your next step. Otherwise put the text you want in newText.`,
    );
    const resent = await oldAndNew(example, 4);
    expect(resent.old).toBe(resent.recorded);
    expect(resent.old).toBe(`Could not find the exact text in ${file}. ${PI_NOT_FOUND}`);
    expect(resent.now).toBe(
      `Already applied: the oldText is not in ${file}, but the newText is, at lines 22-27. This change is already made, so nothing was changed. Do not send it again; go on to your next step.`,
    );
    const before = await sequence(example, false);
    const after = await sequence(example, true);
    expect(before.longest).toBe(7);
    expect(after.longest).toBe(EDIT_LOOP_LIMIT);
    expect(after.evidence).toMatchObject({ alreadyApplied: 2, noChange: 1, blocked: 8 });
  });

  it("3. a misquote: the closest lines and the first difference", async () => {
    const example = await load("misquote");
    const file = "changes/search-filters/decisions.md";
    const misquote = await oldAndNew(example, 2);
    expect(misquote.old).toBe(misquote.recorded);
    expect(misquote.old).toBe(`Could not find the exact text in ${file}. ${PI_NOT_FOUND}`);
    expect(misquote.now).toBe(
      [
        `Could not find the oldText in ${file}. The closest text is lines 7-8 (98% similar).`,
        "First difference, line 7:",
        '  file:    "- **D-03** Pantry matching is exact by ingredient name for now. Synonyms"',
        '  oldText: "- **D-03** pantry matching is exact by ingredient name for now. Synonyms"',
        "Lines 5-9 as the file has them now:",
        "```",
        "- **D-02** The slider rounds up to five-minute steps, so a recipe listed at",
        "  23 minutes appears under 25. Cook times in the data stay exact.",
        "- **D-03** Pantry matching is exact by ingredient name for now. Synonyms",
        '  ("scallion", "spring onion") wait for the ingredient index, which is not',
        "  built yet, so this slice treats them as different ingredients.",
        "```",
        "Nothing was changed. Copy oldText exactly from these lines, indentation included; do not retype it from memory.",
      ].join("\n"),
    );
  });

  it("4. indentation only: the exact lines to copy", async () => {
    const example = await load("indentation");
    const file = "src/pantry/search.py";
    const indented = await oldAndNew(example, 2);
    expect(indented.old).toBe(indented.recorded);
    expect(indented.old).toBe(
      `Could not find edits[2] in ${file}. The oldText must match exactly including all whitespace and newlines.`,
    );
    expect(indented.now).toBe(
      [
        `Could not find edits[2].oldText in ${file} exactly: lines 21-23 match it apart from whitespace or indentation.`,
        "First difference, line 21:",
        '  file:    "def _matches("',
        '  oldText: "    def _matches("',
        "Lines 19-25 as the file has them now:",
        "```",
        "",
        "",
        "def _matches(",
        "    recipe: dict, state: FilterState, cap: int | None",
        ") -> bool:",
        '    """True when the recipe passes every active filter."""',
        '    if state.tags and not state.tags <= set(recipe["tags"]):',
        "```",
        "Nothing was changed. Copy oldText exactly from these lines, indentation included; do not retype it from memory.",
      ].join("\n"),
    );
  });
});
