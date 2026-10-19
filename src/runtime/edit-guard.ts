/**
 * The edit guard: better answers from Pi's `edit` tool for a worker whose
 * view of a file has gone stale.
 *
 * In long unattended runs about one edit in five failed. Most failures quoted text that a
 * formatter, a shell command or the model's own earlier edit had already
 * changed, or re-sent an edit that was already made, and Pi answered only
 * that the old text must match exactly. The guard keeps Pi's tool and adds
 * what the model needs to recover in one call:
 * - the file changed on disk since the model last read or wrote it, and where;
 * - the change is already applied, rather than "not found" or "no changes";
 * - on a miss, the closest region of the file, verbatim and bounded;
 * - after three failed edits in a row on one file, a firm stop until it is read.
 *
 * It costs one `stat` per edit call and one `fstat` per write. It never
 * hashes: the content of the model's last view is kept (up to a budget) and
 * compared only when that stat differs, or read again after an edit failed.
 */
import { type Stats, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { EditGuardEvidence } from "@core/interactive-worker";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  changedRange,
  editableText,
  excerpt,
  fenced,
  type LineRange,
  locate,
  type NearMatch,
  nearestRegion,
  type Occurrence,
  overlaps,
  TextIndex,
} from "./edit-match.js";

/** Consecutive failed edits on one file before the guard stops editing it. */
export const EDIT_LOOP_LIMIT = 3;
const VIEW_LIMIT = 256;
/** Larger files are tracked by their stat alone, so a change is reported without its lines. */
const VIEW_BYTES = 1 << 20;
const RETAINED_BYTES = 32 << 20;
/** A near match this close elsewhere means the old text was misquoted, not already replaced. */
const MISQUOTE_SIMILARITY = 0.6;
/** A region this like the new text suggests the change was made before, in other words. */
const RESEMBLANCE = 0.8;
/** Past this a failed edit keeps Pi's message: the analysis would cost more than it saves. */
const ANALYSIS_CHARS = 4 << 20;

export type FileStat = Pick<Stats, "size" | "mtimeMs" | "ctimeMs" | "ino">;

/** Told what the model has just read or written through Pi's file tools. */
export interface FileViews {
  viewed(path: string, content: Buffer | string, stat: FileStat): void;
}

interface View {
  stat: FileStat;
  content?: Buffer | string;
  bytes: number;
  /** The disk state the model was last told about, so it hears of each change once. */
  told?: FileStat;
}

interface Stale {
  changed?: { range: LineRange; lines: number };
}

interface EditPair {
  oldText: string;
  newText: string;
}

type Loop = EditGuardEvidence["loops"][number];

export interface EditGuardOptions {
  cwd: string;
  projectRoot: string;
  /** Reads a project file under the worker's file policy. */
  readFile(path: string): Promise<Buffer>;
}

function statOf(stat: FileStat): FileStat {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
}

function sameStat(a: FileStat, b: FileStat): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

function textOf(content: Buffer | string): string {
  return typeof content === "string" ? content : content.toString("utf8");
}

function span(range: LineRange): string {
  return range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`;
}

/** The read the model should make: the range with a little context, as Pi's read arguments. */
function rereadHint(range: LineRange): string {
  const start = Math.max(1, range.start - 3);
  const limit = range.end + 3 - start + 1;
  return `Read lines ${start}-${start + limit - 1} again (offset ${start}, limit ${limit})`;
}

function staleNote(path: string, stale: Stale, applied: boolean): string {
  const changed = stale.changed;
  const most =
    changed && changed.range.end - changed.range.start + 1 > Math.max(40, changed.lines * 0.6);
  const lead = applied ? `Note: ${path} had changed` : `${path} changed`;
  const cause = "by a formatter, a shell command or another tool";
  if (!changed)
    return `${lead} on disk after you last read or edited it, ${cause}. ${
      applied ? "This edit applied, but read the file" : "Read it"
    } again before editing it${applied ? " further" : ""}.`;
  const what = most
    ? "most of the file is different now"
    : `${span(changed.range)} ${changed.range.start === changed.range.end ? "is" : "are"} different now`;
  const reread = most ? "Read the whole file again" : rereadHint(changed.range);
  return `${lead} on disk after you last read or edited it: ${what}, changed ${cause}. ${
    applied ? `This edit applied; ${reread.charAt(0).toLowerCase()}${reread.slice(1)}` : reread
  } before editing there.`;
}

function quoted(line: string): string {
  return JSON.stringify(line.length > 200 ? `${line.slice(0, 200)}…` : line);
}

/** Pi's own edit errors that the guard can answer better. */
function piEditFailure(
  message: string,
): { kind: "not_found" | "no_change"; index: number } | undefined {
  if (message.startsWith("Could not find the exact text in "))
    return { kind: "not_found", index: 0 };
  const edit = /^Could not find edits\[(\d+)\] in /.exec(message);
  if (edit) return { kind: "not_found", index: Number(edit[1]) };
  if (message.startsWith("No changes made to ")) return { kind: "no_change", index: 0 };
  return undefined;
}

function editsOf(input: Record<string, unknown>): EditPair[] {
  return Array.isArray(input.edits)
    ? input.edits.filter(
        (edit): edit is EditPair =>
          typeof edit?.oldText === "string" && typeof edit?.newText === "string",
      )
    : [];
}

/**
 * The edit's new text, when finding it in the file would say something: not
 * blank, and not a remainder of the old text, as a deletion's is.
 */
function telltale(edit: EditPair): string | undefined {
  const newText = editableText(edit.newText).replace(/^\n+/, "").replace(/\n+$/, "");
  return newText.trim() && !editableText(edit.oldText).includes(newText) ? newText : undefined;
}

/**
 * Where the edit's new text already is, when the edit looks applied: its old
 * text is gone and its new text sits where the old text's closest match now
 * is, or is unique in the file with no close match for the old text elsewhere.
 */
function appliedAt(
  content: TextIndex,
  newText: string,
  near: NearMatch | undefined,
): Occurrence | undefined {
  const found = locate(content, newText);
  if (!found.length) return undefined;
  const there = near && found.find((item) => overlaps(item.range, near.range));
  if (there) return there;
  if (near && near.score >= MISQUOTE_SIMILARITY) return undefined;
  return found.length === 1 ? found[0] : undefined;
}

/**
 * A region that already resembles the new text, as when the model re-sends a
 * change it made earlier in other words, unless the old text's own closest
 * match is the better explanation.
 */
function resemblance(
  content: TextIndex,
  newText: string,
  near: NearMatch | undefined,
): NearMatch | undefined {
  const like = nearestRegion(content, newText);
  if (!like || like.score < RESEMBLANCE) return undefined;
  if (near && overlaps(like.range, near.range) && like.score <= near.score) return undefined;
  return like;
}

function percent(score: number): string {
  return `${Math.floor(score * 100)}% similar`;
}

function alreadyAppliedMessage(path: string, index: number, count: number, at: Occurrence): string {
  const where = `${span(at.range)}${at.exact ? "" : " (apart from whitespace)"}`;
  return count > 1
    ? `Already applied: edits[${index}].oldText is not in ${path}, but its newText is, at ${where}. Nothing was changed: send the other edits again without edits[${index}].`
    : `Already applied: the oldText is not in ${path}, but the newText is, at ${where}. This change is already made, so nothing was changed. Do not send it again; go on to your next step.`;
}

function noChangeMessage(path: string, edits: EditPair[], content: TextIndex): string {
  const at = edits.length ? locate(content, editableText(edits[0].newText))[0] : undefined;
  const lead =
    edits.length > 1
      ? `No change: every edit's newText is the same as its oldText, so this call would not change ${path}.`
      : `No change: the newText is the same as the oldText, so this edit would not change ${path}.`;
  const where = at ? ` That text is at ${span(at.range)}.` : "";
  return `${lead}${where} If the file already says what you want, the change is made: go on to your next step. Otherwise put the text you want in newText.`;
}

function notFoundMessage(
  path: string,
  subject: string,
  near: NearMatch | undefined,
  like: NearMatch | undefined,
  content: TextIndex,
): string {
  if (!near && !like)
    return `Could not find ${subject} in ${path}, and no part of the file is similar to it: the text may have been replaced, or be in another file. Nothing was changed. Read the part of ${path} you mean to change, then quote oldText exactly from that read.`;
  const lead = !near
    ? `Could not find ${subject} in ${path}.`
    : near.whitespaceOnly
      ? `Could not find ${subject} in ${path} exactly: ${span(near.range)} match it apart from ${
          near.difference ? "whitespace or indentation" : "blank lines"
        }.`
      : `Could not find ${subject} in ${path}. The closest text is ${span(near.range)} (${percent(
          near.score,
        )}).`;
  const resembles = like
    ? ` ${capitalized(span(like.range))} already look${
        like.range.start === like.range.end ? "s" : ""
      } like your newText (${percent(like.score)}), so this change may already be made: check before sending it again.`
    : "";
  const difference = near?.difference
    ? `\nFirst difference, line ${near.difference.line}:\n  file:    ${quoted(
        near.difference.file,
      )}\n  oldText: ${quoted(near.difference.old)}`
    : "";
  // One excerpt: both regions when they are close together.
  const range =
    near && like
      ? Math.max(near.range.end, like.range.end) - Math.min(near.range.start, like.range.start) < 24
        ? {
            start: Math.min(near.range.start, like.range.start),
            end: Math.max(near.range.end, like.range.end),
          }
        : near.range
      : (near ?? like)!.range;
  const shown = excerpt(content, range);
  const cut = shown.cut ? `\n(Cut short at line ${shown.range.end}; read on from there.)` : "";
  return `${lead}${resembles}${difference}\n${capitalized(span(shown.range))} as the file has them now:\n${fenced(
    shown.text,
  )}${cut}\nNothing was changed. Copy oldText exactly from these lines, indentation included; do not retype it from memory.`;
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function loopMessage(path: string, failures: number): string {
  return `This is failed edit ${failures} in a row on ${path}. Stop retrying from memory. Read ${path} (the lines you need are enough), then change approach: quote a few unique lines exactly from that read, or rewrite the section with write. Edits to ${path} are blocked until you read it.`;
}

function blockedMessage(path: string, failures: number): string {
  return `Edit not run: the last ${failures} edits to ${path} failed, and it has not been read since. Read ${path} with the read tool first (the lines you need are enough), then quote oldText exactly from that read, or rewrite the section with write.`;
}

/**
 * One worker session's edit guard. Pi's file tools report views through
 * `viewed`; `editGuardExtension` feeds it Pi's tool events.
 */
export class EditGuard implements FileViews {
  private readonly views = new Map<string, View>();
  private retained = 0;
  private readonly pending = new Map<string, { path: string; stale?: Stale }>();
  private readonly streaks = new Map<string, number>();
  private readonly blocked = new Set<string>();
  private readonly openLoops = new Map<string, Loop>();
  private readonly counts: Omit<EditGuardEvidence, "loops"> = {
    edits: 0,
    failed: 0,
    stale: 0,
    alreadyApplied: 0,
    noChange: 0,
    nearestMatch: 0,
    blocked: 0,
  };
  private readonly loops: Loop[] = [];

  constructor(private readonly options: EditGuardOptions) {}

  viewed(path: string, content: Buffer | string, stat: FileStat): void {
    this.forget(path);
    const bytes = typeof content === "string" ? content.length : content.byteLength;
    const kept = bytes <= VIEW_BYTES;
    this.views.set(path, {
      stat: statOf(stat),
      content: kept ? content : undefined,
      bytes: kept ? bytes : 0,
    });
    this.retained += kept ? bytes : 0;
    // Oldest first: past the file limit forget a view, past the byte budget keep only its stat.
    for (const [key, view] of this.views) {
      if (key === path || (this.views.size <= VIEW_LIMIT && this.retained <= RETAINED_BYTES)) break;
      if (this.views.size > VIEW_LIMIT) this.forget(key);
      else {
        this.retained -= view.bytes;
        view.content = undefined;
        view.bytes = 0;
      }
    }
  }

  /** Before an edit runs. Returns a reason to block it while its file is in an edit loop. */
  async beforeEdit(toolCallId: string, requested: string): Promise<string | undefined> {
    const path = resolve(this.options.cwd, requested);
    if (this.blocked.has(path)) {
      this.counts.blocked += 1;
      const loop = this.openLoops.get(path);
      if (loop) loop.blocked += 1;
      return blockedMessage(this.display(path), this.streaks.get(path) ?? EDIT_LOOP_LIMIT);
    }
    this.pending.set(toolCallId, { path, stale: await this.staleness(path) });
    return undefined;
  }

  /** After an edit ran. Returns the text to give the model instead of Pi's, if any. */
  async afterEdit(
    toolCallId: string,
    input: Record<string, unknown>,
    isError: boolean,
    text: string,
  ): Promise<string | undefined> {
    const pending = this.pending.get(toolCallId);
    this.pending.delete(toolCallId);
    if (!pending || (isError && text.startsWith("Operation aborted"))) return undefined;
    const { path, stale } = pending;
    const shown = this.display(path);
    this.counts.edits += 1;
    if (stale) this.counts.stale += 1;
    if (!isError) {
      this.settle(path);
      return stale ? `${text}\n\n${staleNote(shown, stale, true)}` : undefined;
    }
    this.counts.failed += 1;
    const streak = (this.streaks.get(path) ?? 0) + 1;
    this.streaks.set(path, streak);
    const parts = [
      stale ? staleNote(shown, stale, false) : undefined,
      await this.explain(path, shown, editsOf(input), text),
    ];
    if (streak >= EDIT_LOOP_LIMIT) {
      this.blocked.add(path);
      let loop = this.openLoops.get(path);
      if (!loop) {
        loop = { path: shown, failures: streak, blocked: 0 };
        this.openLoops.set(path, loop);
        this.loops.push(loop);
      }
      loop.failures = streak;
      parts.push(loopMessage(shown, streak));
    }
    return parts.filter(Boolean).join("\n\n");
  }

  /** A read lifts an edit-loop block; the failure count stands until an edit succeeds. */
  afterRead(requested: string, isError: boolean): void {
    if (!isError) this.blocked.delete(resolve(this.options.cwd, requested));
  }

  /** A whole-file write is a change of approach: the run of failures is over. */
  afterWrite(requested: string, isError: boolean): void {
    if (!isError) this.settle(resolve(this.options.cwd, requested));
  }

  evidence(): EditGuardEvidence | undefined {
    if (!this.counts.edits && !this.counts.blocked) return undefined;
    return { ...this.counts, loops: this.loops.map((loop) => ({ ...loop })) };
  }

  private settle(path: string): void {
    this.streaks.delete(path);
    this.blocked.delete(path);
    this.openLoops.delete(path);
  }

  private forget(path: string): void {
    const view = this.views.get(path);
    if (!view) return;
    this.retained -= view.bytes;
    this.views.delete(path);
  }

  private display(path: string): string {
    const shown = relative(this.options.projectRoot, path);
    return shown && !shown.startsWith("..") && !isAbsolute(shown) ? shown : path;
  }

  /**
   * Whether the file changed since the model's last view, and which lines,
   * unless the model was already told about this state. One stat when not.
   */
  private async staleness(path: string): Promise<Stale | undefined> {
    const view = this.views.get(path);
    if (!view) return undefined;
    let stat: Stats;
    try {
      stat = statSync(path);
    } catch {
      return undefined;
    }
    if (sameStat(view.stat, stat) || (view.told && sameStat(view.told, stat))) return undefined;
    view.told = statOf(stat);
    if (view.content === undefined) return {};
    let current: string;
    try {
      current = (await this.options.readFile(path)).toString("utf8");
    } catch {
      return undefined;
    }
    const before = textOf(view.content);
    if (before === current) {
      // Touched but not changed, as `sed -i` with no match does.
      view.stat = statOf(stat);
      view.told = undefined;
      return undefined;
    }
    return { changed: changedRange(editableText(before), editableText(current)) };
  }

  private async explain(
    path: string,
    shown: string,
    edits: EditPair[],
    message: string,
  ): Promise<string> {
    const failure = piEditFailure(message);
    if (!failure) return message;
    let content: TextIndex;
    try {
      const text = editableText((await this.options.readFile(path)).toString("utf8"));
      if (text.length > ANALYSIS_CHARS) return message;
      content = new TextIndex(text);
    } catch {
      return message;
    }
    if (failure.kind === "no_change") {
      this.counts.noChange += 1;
      return noChangeMessage(shown, edits, content);
    }
    const edit = edits[failure.index];
    if (!edit) return message;
    const near = nearestRegion(content, editableText(edit.oldText));
    const newText = telltale(edit);
    const applied = newText ? appliedAt(content, newText, near) : undefined;
    if (applied) {
      this.counts.alreadyApplied += 1;
      return alreadyAppliedMessage(shown, failure.index, edits.length, applied);
    }
    const like = newText ? resemblance(content, newText, near) : undefined;
    if (near || like) this.counts.nearestMatch += 1;
    const subject = edits.length > 1 ? `edits[${failure.index}].oldText` : "the oldText";
    return notFoundMessage(shown, subject, near, like, content);
  }
}

function pathOf(input: unknown): string | undefined {
  const path = (input as { path?: unknown } | undefined)?.path;
  return typeof path === "string" && path ? path : undefined;
}

/**
 * Pi's hooks for the guard. Load it after the policy extension, which
 * resolves each tool's path first. The guard only advises: if it fails, the
 * edit runs and Pi's own result stands.
 */
export function editGuardExtension(guard: EditGuard) {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event) => {
      const path = event.toolName === "edit" ? pathOf(event.input) : undefined;
      if (!path) return undefined;
      try {
        const reason = await guard.beforeEdit(event.toolCallId, path);
        return reason ? { block: true, reason } : undefined;
      } catch {
        return undefined;
      }
    });
    pi.on("tool_result", async (event) => {
      const path = pathOf(event.input);
      if (!path) return undefined;
      if (event.toolName === "read") guard.afterRead(path, event.isError);
      if (event.toolName === "write") guard.afterWrite(path, event.isError);
      if (event.toolName !== "edit") return undefined;
      const text = event.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      const replaced = await guard.afterEdit(event.toolCallId, event.input, event.isError, text);
      if (replaced === undefined) return undefined;
      return {
        content: [
          { type: "text" as const, text: replaced },
          ...event.content.filter((part) => part.type !== "text"),
        ],
      };
    });
  };
}
