/**
 * The syntax highlighter (pi-coding-agent, over a second of loading that
 * blocks the screen) loads only once a code fence is drawn, and the screen is
 * told so it can colour the fence.
 */
import { createColours } from "@tui/colour";
import { highlighterLoaded, markdownTheme, onHighlighterLoaded } from "@tui/markdown-theme";
import { TranscriptView } from "@tui/transcript";
import { expect, it, vi } from "vitest";

const colours = createColours({ theme: "system", isTTY: false, env: {} });

it("waits for a code fence before loading the highlighter, then asks for a redraw", async () => {
  const redraw = vi.fn();
  onHighlighterLoaded(redraw);
  const transcript = new TranscriptView(markdownTheme(colours), colours);
  const message = (id: string, text: string) => ({
    id,
    role: "manager" as const,
    text,
    createdAt: "2026-10-30T00:00:00.000Z",
  });

  transcript.sync([message("m1", "No code here.")], undefined);
  transcript.render(80);
  expect(highlighterLoaded()).toBe(false);

  transcript.sync(
    [message("m1", "No code here."), message("m2", "```ts\nconst x = 1;\n```")],
    undefined,
  );
  expect(transcript.render(80).join("\n")).toContain("const x = 1;");
  await vi.waitFor(() => expect(redraw).toHaveBeenCalled(), { timeout: 20_000 });
  expect(highlighterLoaded()).toBe(true);
});
