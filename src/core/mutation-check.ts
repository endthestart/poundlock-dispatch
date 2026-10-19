/**
 * A mutation check at acceptance: break a behaviour task's new code in a few
 * small, type-preserving ways (a flipped comparison, a swapped boolean) and
 * rerun the project's checks. A change no check notices is behaviour no test
 * pins down. An app can pass every check with two keyboard shortcuts swapped;
 * a flipped key mapping is exactly the change a mutation run catches.
 *
 * Pure functions over the attempt's patch; the orchestrator applies, runs and
 * restores.
 */
import { lstat, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { freezable } from "./frozen-tests";
import { isTestPath } from "./task-size";

/** Changes tried per accepted attempt: each costs one run of the project's checks. */
export const MUTANTS_PER_ATTEMPT = 2;

export interface Mutant {
  path: string;
  /** 1-based line in the file after the attempt. */
  line: number;
  /** The line as the attempt wrote it. */
  text: string;
  /** The same line, broken. */
  mutated: string;
  /** "`a < b` → `a >= b`", for the owner and the manager. */
  change: string;
}

const CODE_FILE =
  /\.(rs|swift|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|kts|c|cc|cpp|h|hpp|m|mm|cs|rb)$/i;

/** Spaced operators only, so generics, arrows and ranges are left alone. */
const OPERATORS: Array<{ find: RegExp; replace: string; weight: number }> = [
  { find: / === /, replace: " !== ", weight: 3 },
  { find: / !== /, replace: " === ", weight: 3 },
  { find: / == /, replace: " != ", weight: 3 },
  { find: / != /, replace: " == ", weight: 3 },
  { find: / <= /, replace: " > ", weight: 3 },
  { find: / >= /, replace: " < ", weight: 3 },
  { find: / < /, replace: " >= ", weight: 3 },
  { find: / > /, replace: " <= ", weight: 3 },
  { find: / && /, replace: " || ", weight: 3 },
  { find: / \|\| /, replace: " && ", weight: 3 },
  { find: / and /, replace: " or ", weight: 3 },
  { find: / or /, replace: " and ", weight: 3 },
  { find: /\btrue\b/, replace: "false", weight: 2 },
  { find: /\bfalse\b/, replace: "true", weight: 2 },
  { find: /\bTrue\b/, replace: "False", weight: 2 },
  { find: /\bFalse\b/, replace: "True", weight: 2 },
  { find: / \+ /, replace: " - ", weight: 1 },
  { find: / - /, replace: " + ", weight: 1 },
];

const CONDITIONAL = /\b(if|guard|while|match|case|where|return|elif|unless)\b|\?/;
const SKIPPED_LINE =
  /^\s*(\/\/|\/\*|\*|#(?!\[)|--|import\b|use\b|from\b|package\b|@|#include|#\[|extern\b|mod\b|pub mod\b|print|println!|eprintln!|NSLog|console\.|logger\.|log\.|debugPrint|assert|precondition|fatalError|panic!|unreachable!|todo!)/;

/** Whether `index` in `line` falls inside a double-quoted or backtick string. */
function insideString(line: string, index: number): boolean {
  let quote: string | undefined;
  for (let at = 0; at < index; at += 1) {
    const char = line[at];
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "`") quote = char;
  }
  return quote !== undefined;
}

/** The line up to a trailing comment, so mutations never land in one. */
function codePart(line: string): string {
  const comment = /\s(\/\/|#)\s/.exec(line);
  return comment && !insideString(line, comment.index) ? line.slice(0, comment.index) : line;
}

function mutate(text: string): { mutated: string; change: string; weight: number } | undefined {
  if (SKIPPED_LINE.test(text) || text.trim().length < 3) return undefined;
  const code = codePart(text);
  for (const operator of OPERATORS) {
    const found = new RegExp(operator.find.source, "g");
    for (let match = found.exec(code); match; match = found.exec(code)) {
      if (insideString(code, match.index)) continue;
      const mutated =
        text.slice(0, match.index) + operator.replace + text.slice(match.index + match[0].length);
      return {
        mutated,
        change: `\`${match[0].trim()}\` → \`${operator.replace.trim()}\``,
        weight: operator.weight + (CONDITIONAL.test(code) ? 1 : 0),
      };
    }
  }
  return undefined;
}

/** Lines the patch adds, by file, with their line numbers after the change. */
export function addedLines(patch: string): Array<{ path: string; line: number; text: string }> {
  const added: Array<{ path: string; line: number; text: string }> = [];
  let path: string | undefined;
  let line = 0;
  for (const row of patch.split("\n")) {
    if (row.startsWith("+++ ")) {
      const target = row.slice(4).trim();
      path = target === "/dev/null" ? undefined : target.replace(/^b\//, "");
      continue;
    }
    if (row.startsWith("--- ") || row.startsWith("diff --git")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!path || !line) continue;
    if (row.startsWith("+")) {
      added.push({ path, line, text: row.slice(1) });
      line += 1;
    } else if (row.startsWith(" ")) line += 1;
  }
  return added;
}

/**
 * Mutants from the patch's added source lines (tests, build output and
 * Dispatch's own files excluded), best first: conditions and comparisons, one file at a time so a
 * single file does not take every try. The caller stops after
 * MUTANTS_PER_ATTEMPT that still apply.
 */
export function mutantsFromPatch(patch: string, limit = Number.POSITIVE_INFINITY): Mutant[] {
  const byFile = new Map<string, Array<Mutant & { weight: number }>>();
  const seen = new Set<string>();
  for (const added of addedLines(patch)) {
    // A task's patches repeat lines a later attempt kept; try each line once.
    if (seen.has(`${added.path}\n${added.text}`)) continue;
    seen.add(`${added.path}\n${added.text}`);
    // Build output (dist/, build/, .dispatch/ and the like) is rebuilt by the
    // checks, so a break in a committed bundle is never noticed: one sent a
    // passing task back.
    if (!CODE_FILE.test(added.path) || isTestPath(added.path) || !freezable(added.path)) continue;
    const result = mutate(added.text);
    if (!result) continue;
    const list = byFile.get(added.path) ?? [];
    list.push({ ...added, ...result });
    byFile.set(added.path, list);
  }
  const queues = [...byFile.values()].map((list) =>
    [...list].sort((a, b) => b.weight - a.weight || a.line - b.line),
  );
  const chosen: Mutant[] = [];
  while (chosen.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next && chosen.length < limit) {
        const { weight: _, ...mutant } = next;
        chosen.push(mutant);
      }
    }
  }
  return chosen;
}

/**
 * The file with the mutant applied, or undefined when its line is no longer
 * where (or what) the patch said, so nothing is changed blindly.
 */
export function applyMutant(content: string, mutant: Mutant): string | undefined {
  const lines = content.split("\n");
  let index = mutant.line - 1;
  if (lines[index] !== mutant.text) {
    index = lines.indexOf(mutant.text);
    if (index < 0 || lines.indexOf(mutant.text, index + 1) >= 0) return undefined;
  }
  lines[index] = mutant.mutated;
  return lines.join("\n");
}

export function survivorsRefusal(survivors: Mutant[], tried: number): string {
  return [
    ...survived(survivors, tried),
    "No test pins that behaviour down. Call request_repair asking for a test that fails when it breaks, the way a user would notice. If the line is not behaviour the owner needs, call request_apply_result again to accept it as it is; the check runs once per attempt. The code is back as the worker left it.",
  ].join("\n");
}

/**
 * The same finding told to an Autopilot worker, which has no manager to ask.
 * Told only to add a test, a worker added it to a frozen test
 * file and lost a task it had otherwise finished.
 */
export function survivorsForWorker(survivors: Mutant[], tried: number, frozen: boolean): string {
  return [
    ...survived(survivors, tried),
    `No test pins that behaviour down. Add a test that fails when it breaks, the way a user would notice${frozen ? ", in a new test file: tests accepted earlier are frozen and cannot change" : ""}. The code is back as you left it.`,
  ].join("\n");
}

function survived(survivors: Mutant[], tried: number): string[] {
  return [
    `Mutation check: Dispatch broke this attempt's code in ${tried} small way${tried === 1 ? "" : "s"} and reran the checks. They still passed for:`,
    ...survivors.map(
      (mutant) => `- ${mutant.path}:${mutant.line}: ${mutant.change} in \`${mutant.text.trim()}\``,
    ),
  ];
}

/**
 * The absolute path of a file the mutation check may read and rewrite: a
 * regular file (a symlink is not one) whose real path stays inside `root`.
 * A worker can leave a link to any file the owner can write, and the check
 * runs on the host.
 */
export async function mutableFile(root: string, path: string): Promise<string | undefined> {
  const full = join(root, path);
  const info = await lstat(full).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const [realRoot, realFull] = await Promise.all([realpath(root), realpath(full)]).catch(() => [
    undefined,
    undefined,
  ]);
  if (!realRoot || !realFull) return undefined;
  return realFull.startsWith(`${realRoot}${sep}`) ? full : undefined;
}
