/**
 * Where an edit's text is, or nearly is, in a file: the text analysis behind
 * the edit guard. Pure, and bounded, because it runs on the failure path of a
 * live worker. Nothing here decides to apply a fuzzy match: Python indentation
 * matters, so the guard only shows the model what the file really says.
 */

/** 1-based, inclusive line numbers. */
export interface LineRange {
  start: number;
  end: number;
}

/** Pi matches edits with the BOM stripped and CRLF or CR read as LF. */
export function editableText(content: string): string {
  return (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).replace(/\r\n?/g, "\n");
}

/**
 * One line as the guard compares it: runs of whitespace, indentation, and the
 * quote and dash variants Pi already folds do not count.
 */
export function looseLine(line: string): string {
  const folded = /[^\x00-\x7f]/.test(line)
    ? line
        .normalize("NFKC")
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        .replace(/[\u2010-\u2015\u2212]/g, "-")
    : line;
  return folded.replace(/\s+/g, " ").trim();
}

/** A file's lines, loosened once for every search of one failed edit. */
export class TextIndex {
  readonly lines: string[];
  /** The non-blank lines, loosened. */
  readonly loose: string[] = [];
  /** Their 0-based line numbers. */
  readonly index: number[] = [];
  private starts?: number[];
  private byLine?: Map<string, number[]>;

  constructor(readonly content: string) {
    this.lines = content.split("\n");
    for (let i = 0; i < this.lines.length; i++) {
      const line = looseLine(this.lines[i]);
      if (!line) continue;
      this.index.push(i);
      this.loose.push(line);
    }
  }

  /** The 1-based line holding a character offset. */
  lineAt(offset: number): number {
    if (!this.starts) {
      this.starts = [0];
      for (let at = this.content.indexOf("\n"); at !== -1; at = this.content.indexOf("\n", at + 1))
        this.starts.push(at + 1);
    }
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }

  /** Where a loosened line occurs among the non-blank lines, up to a bound. */
  positions(line: string): number[] {
    if (!this.byLine) {
      this.byLine = new Map();
      for (let j = 0; j < this.loose.length; j++) {
        const list = this.byLine.get(this.loose[j]);
        if (!list) this.byLine.set(this.loose[j], [j]);
        else if (list.length < POSITIONS_PER_LINE) list.push(j);
      }
    }
    return this.byLine.get(line) ?? [];
  }
}

function indexed(content: string | TextIndex): TextIndex {
  return typeof content === "string" ? new TextIndex(content) : content;
}

export interface Occurrence {
  range: LineRange;
  /** False when it matches only apart from whitespace and indentation. */
  exact: boolean;
}

const OCCURRENCE_LIMIT = 8;
const POSITIONS_PER_LINE = 64;

/** Where `text` is in the file: exactly, or else apart from whitespace. */
export function locate(content: string | TextIndex, text: string): Occurrence[] {
  const file = indexed(content);
  const core = text.replace(/^\n+/, "").replace(/\n+$/, "");
  if (!core.trim()) return [];
  const found: Occurrence[] = [];
  for (
    let at = file.content.indexOf(core);
    at !== -1 && found.length < OCCURRENCE_LIMIT;
    at = file.content.indexOf(core, at + 1)
  ) {
    found.push({
      range: { start: file.lineAt(at), end: file.lineAt(at + core.length - 1) },
      exact: true,
    });
  }
  if (found.length) return found;
  // Apart from whitespace: inner lines whole, the first and last possibly partial.
  const wanted = core.split("\n").map(looseLine).filter(Boolean);
  if (!wanted.length) return [];
  const last = wanted.length - 1;
  const fits = (line: string, k: number) =>
    last === 0
      ? line.includes(wanted[0])
      : k === 0
        ? line.endsWith(wanted[0])
        : k === last
          ? line.startsWith(wanted[last])
          : line === wanted[k];
  for (let j = 0; j + last < file.loose.length && found.length < OCCURRENCE_LIMIT; j++) {
    let k = 0;
    while (k <= last && fits(file.loose[j + k], k)) k++;
    if (k > last)
      found.push({
        range: { start: file.index[j] + 1, end: file.index[j + last] + 1 },
        exact: false,
      });
  }
  return found;
}

export interface NearMatch {
  range: LineRange;
  /** Mean line similarity between 0 and 1. */
  score: number;
  /** Every line matches apart from whitespace, indentation or blank lines. */
  whitespaceOnly: boolean;
  /** The first line that differs, as the file has it and as the old text has it. */
  difference?: { line: number; file: string; old: string };
}

/** Below this the closest region is not worth showing. */
const MIN_SIMILARITY = 0.5;
const CANDIDATE_LIMIT = 32;

// Bigram tallies in a fixed table: exact for ASCII, approximate beyond it.
const counts = new Int32Array(1 << 16);
const taken = new Int32Array(1 << 16);

function gram(text: string, i: number): number {
  return ((text.charCodeAt(i) << 8) ^ text.charCodeAt(i + 1)) & 0xffff;
}

/**
 * Scores file lines against one old line: bigram overlap (Dice), or a little
 * less for an old line that is only part of the file's line, as quoted
 * fragments are. The old line is tallied once for all the lines it meets.
 */
function scoring<T>(old: string, use: (score: (line: string) => number) => T): T {
  const size = old.length - 1;
  for (let i = 0; i < size; i++) counts[gram(old, i)] += 1;
  try {
    return use((line) => {
      if (line === old) return 1;
      const other = line.length - 1;
      if (size < 1 || other < 1) return 0;
      const most = Math.min(size, other);
      if (Math.max((2 * most) / (size + other), (0.9 * most) / size) < MIN_SIMILARITY) return 0;
      let shared = 0;
      for (let i = 0; i < other; i++) {
        const g = gram(line, i);
        if (taken[g] < counts[g]) {
          taken[g] += 1;
          shared += 1;
        }
      }
      for (let i = 0; i < other; i++) taken[gram(line, i)] = 0;
      return Math.max((2 * shared) / (size + other), (0.9 * shared) / size);
    });
  } finally {
    for (let i = 0; i < size; i++) counts[gram(old, i)] = 0;
  }
}

/**
 * The region of the file most like `oldText`, compared line by line apart
 * from whitespace, or undefined when nothing is similar enough.
 *
 * Candidate positions come from lines that match exactly apart from
 * whitespace; when none does, from the old text's longest lines by
 * similarity. Only those candidates are scored, so the cost stays near linear
 * in the file's length.
 */
export function nearestRegion(content: string | TextIndex, oldText: string): NearMatch | undefined {
  const file = indexed(content);
  const old: Array<{ raw: string; loose: string }> = [];
  for (const raw of oldText.split("\n")) {
    const loose = looseLine(raw);
    if (loose) old.push({ raw, loose });
  }
  const m = old.length;
  const n = file.loose.length;
  if (!m || !n) return undefined;
  const width = Math.min(m, n);
  const votes = new Map<number, number>();
  const vote = (start: number, weight: number) => {
    if (start >= 0 && start <= n - width) votes.set(start, (votes.get(start) ?? 0) + weight);
  };
  for (let k = 0; k < width; k++) for (const j of file.positions(old[k].loose)) vote(j - k, 1);
  if (!votes.size) {
    const anchors = [...old.slice(0, width).keys()]
      .sort((a, b) => old[b].loose.length - old[a].loose.length)
      .slice(0, 3);
    for (const k of anchors)
      scoring(old[k].loose, (score) => {
        for (let j = 0; j < n; j++) {
          const similar = score(file.loose[j]);
          if (similar >= MIN_SIMILARITY) vote(j - k, similar);
        }
      });
  }
  const candidates = [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CANDIDATE_LIMIT)
    .map(([start]) => start);
  const totals = new Float64Array(candidates.length);
  for (let k = 0; k < width; k++)
    scoring(old[k].loose, (score) => {
      for (let c = 0; c < candidates.length; c++) totals[c] += score(file.loose[candidates[c] + k]);
    });
  let best = -1;
  for (let c = 0; c < candidates.length; c++) if (best < 0 || totals[c] > totals[best]) best = c;
  const score = best < 0 ? 0 : totals[best] / m;
  if (score < MIN_SIMILARITY) return undefined;
  const start = candidates[best];
  const at = (k: number) => file.index[start + k];
  let difference: NearMatch["difference"];
  let whitespaceOnly = width === m;
  for (let k = 0; k < width; k++) {
    const line = file.lines[at(k)];
    if (!difference && line.trimEnd() !== old[k].raw.trimEnd())
      difference = { line: at(k) + 1, file: line, old: old[k].raw };
    if (file.loose[start + k] !== old[k].loose) whitespaceOnly = false;
  }
  return { range: { start: at(0) + 1, end: at(width - 1) + 1 }, score, whitespaceOnly, difference };
}

export function overlaps(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * The lines of `after` that differ from `before`: one span from the first
 * change to the last. Undefined when the two are the same.
 */
export function changedRange(
  before: string,
  after: string,
): { range: LineRange; lines: number } | undefined {
  if (before === after) return undefined;
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const lines = b.at(-1) === "" ? b.length - 1 : b.length;
  const start = Math.min(head + 1, Math.max(lines, 1));
  return { range: { start, end: Math.max(start, Math.min(b.length - tail, lines)) }, lines };
}

const EXCERPT_LINES = 30;
const EXCERPT_CHARS = 3_000;

/**
 * Lines of the file around `range`, verbatim so the model can copy them,
 * bounded in lines and characters. `range` in the result is what it shows.
 */
export function excerpt(
  content: string | TextIndex,
  range: LineRange,
  context = 2,
): { range: LineRange; text: string; cut: boolean } {
  const { lines } = indexed(content);
  const count = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  const start = Math.max(1, range.start - context);
  const wanted = Math.min(count, range.end + context);
  const shown: string[] = [];
  let chars = 0;
  let line = start;
  for (; line <= wanted && shown.length < EXCERPT_LINES; line++) {
    const text = lines[line - 1];
    if (shown.length && chars + text.length > EXCERPT_CHARS) break;
    shown.push(text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text);
    chars += text.length + 1;
  }
  return {
    range: { start, end: Math.max(start, line - 1) },
    text: shown.join("\n"),
    cut: line <= wanted,
  };
}

/** A Markdown fence longer than any backtick run inside `text`. */
export function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}
