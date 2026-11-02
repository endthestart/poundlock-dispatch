/**
 * The transcript, as components rather than one big block of text.
 *
 * The old renderer built the whole screen as a single `Text`, which meant a
 * resize or a new message re-wrapped and re-painted everything the user had
 * already read, and "add markdown" would have meant hand-rolling it inside a
 * plain-text renderer. This keeps one component per message, keyed by
 * `ChatMessage.id`: `TranscriptView.sync` adds a row for a new id, updates the
 * row already there for one whose text changed (a streaming edit, a retried
 * reply), and drops rows for messages that are gone. A row nobody touched
 * keeps whatever it last rendered — pi-tui's `Text`/`Markdown` already cache
 * on `(text, width)`, so an unrelated message arriving costs nothing for the
 * ones already on screen.
 *
 * `render.ts` keeps its own, unrelated `renderTranscript`: plain wrapped text
 * for `--json`/non-TTY output and its own tests. The two must agree on what a
 * user message looks like (right-aligned block, own margin) but are otherwise
 * free to differ — one paints, the other only ever produces a string.
 */
import { Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import { displaySafe } from "@shared/display-safe";
import { conversationTimeline, type TranscriptDensity } from "@shared/live-work-view";
import type { ChatMessage, LiveWorkEntry } from "@shared/types";
import type { Colours } from "./colour.js";
import { demoteDeepHeadings } from "./markdown-theme.js";
import { messageHead } from "./message-head.js";
import { OWN_MESSAGE_SHARE, wrap } from "./render.js";

/**
 * OSC 133 "prompt start". A line beginning with this is what
 * `TuiAltScreen`'s previous/next-prompt navigation (`ctrl+up`/`ctrl+down` by
 * default) looks for; it is a zero-width marker that pi-tui strips before the
 * line is ever drawn. Marking the first line of each user message is what
 * makes "jump to my last message" work here the way it does in a real shell.
 */
const OSC_133_PROMPT_START = "\x1b]133;A\x07";

/** A message component: what the transcript view keys, updates and drops. */
interface TranscriptRow {
  update(message: ChatMessage, density: TranscriptDensity): void;
  render(width: number): string[];
  invalidate(): void;
}

/**
 * Your own words: a block set against the right margin, left-aligned inside
 * it, the way a chat client does. True right-alignment would ragged the left
 * edge of anything that wrapped — the edge you read from — so only the block
 * moves; the text inside it stays flush left.
 */
class UserMessageRow implements TranscriptRow {
  private text = "";
  private head = "";

  constructor(private readonly colours: Colours) {}

  update(message: ChatMessage): void {
    this.text = message.text;
    this.head = messageHead(message);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const block = Math.max(20, Math.floor(width * OWN_MESSAGE_SHARE));
    const body = wrap(this.text, block - 2);
    const longest = Math.max(...body.map((line) => visibleWidth(line)), 0);
    const indent = " ".repeat(Math.max(0, width - longest - 2));
    const bar = this.colours.paint("accent", "▏");
    const head = this.colours.paint(
      "faint",
      `${" ".repeat(Math.max(0, width - visibleWidth(this.head)))}${this.head}`,
    );
    const lines = [
      `${OSC_133_PROMPT_START}${head}`,
      ...body.map((line) => `${indent}${bar} ${line}`),
    ];
    lines.push("");
    return lines;
  }
}

/**
 * A manager's reply, laid out as markdown. The streaming draft uses this same
 * class (see `TranscriptView`), so the text that appears while a turn is
 * running sits exactly where it will sit once the turn ends — nothing shifts
 * or reflows the instant the final message replaces the draft.
 */
class ManagerMessageRow implements TranscriptRow {
  private readonly markdown: Markdown;
  private lastText: string | undefined;
  private toolTraceLines: string[] = [];
  private head = "";

  constructor(
    theme: MarkdownTheme,
    private readonly colours: Colours,
  ) {
    // See `demoteDeepHeadings`: works around a pi-tui 0.86.1 rendering bug
    // for h3+ headings rather than living with a stray "### " in the output.
    this.markdown = new Markdown("", 0, 0, theme, undefined, {
      transform: (markdown) => demoteDeepHeadings(markdown),
    });
  }

  update(message: ChatMessage, density: TranscriptDensity): void {
    this.head = messageHead(message);
    // Markdown's own cache keys on `(text, width)`; only calling `setText`
    // when the text actually changed keeps a message nobody edited from ever
    // being invalidated, let alone re-parsed.
    if (message.text !== this.lastText) {
      this.lastText = message.text;
      this.markdown.setText(displaySafe(message.text));
    }
    // Normal folds the steps into one line of names; Verbose shows each step's summary.
    const trace = message.toolTrace ?? [];
    this.toolTraceLines =
      density === "verbose"
        ? trace.map((tool) =>
            this.colours.paint(
              tool.error ? "fault" : "faint",
              `${tool.error ? "!" : "·"} ${displaySafe(tool.summary)}`,
            ),
          )
        : trace.length
          ? [
              this.colours.paint(
                "faint",
                `· ${trace.map((tool) => (tool.error ? `${tool.name}!` : tool.name)).join(", ")}`,
              ),
            ]
          : [];
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  render(width: number): string[] {
    const lines = this.markdown.render(width);
    const out = [this.colours.paint("faint", this.head), ...(lines.length ? lines : [""])];
    out.push(...this.toolTraceLines, "");
    return out;
  }
}

/**
 * Machinery, not a voice: dimmed, marked, never mistaken for something said.
 * A notice (a decision Dispatch made for you) is set apart with a bar down its
 * left edge in the review colour, the way the desktop app marks it, and its
 * text is not dimmed, so it is not skimmed past like a receipt.
 */
class SystemMessageRow implements TranscriptRow {
  private text = "";
  private notice = false;

  constructor(private readonly colours: Colours) {}

  update(message: ChatMessage): void {
    this.text = message.text;
    this.notice = message.kind === "notice";
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines = wrap(this.text, width - 2);
    const out = this.notice
      ? lines.map((line) => `${this.colours.paint("review", "▎")} ${line}`)
      : lines.map((line, index) =>
          this.colours.paint("faint", index === 0 ? `· ${line}` : `  ${line}`),
        );
    out.push("");
    return out;
  }
}

/** A settled update between messages: what the work was doing, and when. */
class ActivityRow implements TranscriptRow {
  constructor(
    private readonly entry: LiveWorkEntry,
    private readonly colours: Colours,
  ) {}

  update(): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const clock = new Date(this.entry.at).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    return [
      ...wrap(`${clock}  ${displaySafe(this.entry.text)}`, width - 2).map((line, index) =>
        this.colours.paint("faint", index === 0 ? `· ${line}` : `  ${line}`),
      ),
      "",
    ];
  }
}

function createRow(message: ChatMessage, theme: MarkdownTheme, colours: Colours): TranscriptRow {
  if (message.role === "user") return new UserMessageRow(colours);
  if (message.role === "manager") return new ManagerMessageRow(theme, colours);
  return new SystemMessageRow(colours);
}

/**
 * The transcript itself: one row per message, in message order, plus the
 * streaming draft (if any) appended after them. Not a pi-tui `Container` —
 * nothing here needs mouse dispatch or a public `children` array, only
 * `render`, which `ScrollView` calls like any other component.
 */
export class TranscriptView {
  private readonly rows = new Map<string, TranscriptRow>();
  private order: string[] = [];
  private readonly draftRow: ManagerMessageRow;
  private draftActive = false;

  constructor(
    private readonly theme: MarkdownTheme,
    private readonly colours: Colours,
  ) {
    this.draftRow = new ManagerMessageRow(theme, colours);
  }

  /**
   * Reconcile against the latest messages and the work's settled updates,
   * which sit between them as the desktop app's transcript places them: one
   * per gap in Normal, every one in Verbose. Cheap when little has changed.
   */
  sync(
    messages: ChatMessage[],
    draft: string | undefined,
    density: TranscriptDensity = "normal",
    work: { entries?: LiveWorkEntry[]; activity?: string } = {},
  ): void {
    const timeline = conversationTimeline(messages, work.entries, work.activity, density);
    const seen = new Set<string>();
    this.order = [];
    for (const item of timeline) {
      const key =
        item.kind === "message" ? item.message.id : `activity:${item.entry.at}:${item.entry.text}`;
      seen.add(key);
      this.order.push(key);
      let row = this.rows.get(key);
      if (!row) {
        row =
          item.kind === "message"
            ? createRow(item.message, this.theme, this.colours)
            : new ActivityRow(item.entry, this.colours);
        this.rows.set(key, row);
      }
      if (item.kind === "message") row.update(item.message, density);
    }
    for (const id of this.rows.keys()) if (!seen.has(id)) this.rows.delete(id);

    this.draftActive = Boolean(draft?.trim());
    if (this.draftActive)
      this.draftRow.update(
        { id: "__draft__", role: "manager", text: draft ?? "", createdAt: "" },
        density,
      );
  }

  invalidate(): void {
    for (const row of this.rows.values()) row.invalidate();
    this.draftRow.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const id of this.order) {
      const row = this.rows.get(id);
      if (row) lines.push(...row.render(width));
    }
    if (this.draftActive) lines.push(...this.draftRow.render(width));
    return lines;
  }
}
