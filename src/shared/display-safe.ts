/** What replaces a character that is removed, written as a code point so it is visible in source. */
const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * Control characters, the C1 range and bidirectional overrides. Newline and tab
 * stay; a carriage return does not, because it lets a line overwrite the one
 * before it.
 */
function terminalUnsafe(code: number): boolean {
  return (
    code <= 0x08 ||
    (code >= 0x0b && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Text that came from outside this process, made safe to print on a terminal. */
export function displaySafe(text: string): string {
  let safe = "";
  for (const char of text.replace(/\r\n/g, "\n"))
    safe += terminalUnsafe(char.codePointAt(0) ?? 0) ? REPLACEMENT : char;
  return safe;
}

/**
 * Text someone is asked to approve, with every character that could hide or
 * rewrite part of it written out instead (`\x1b`, `\r`, `\u{202e}`), so what
 * the card shows is what runs (M9).
 */
export function visibleControls(text: string): string {
  let shown = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (!terminalUnsafe(code)) shown += char;
    else if (code === 0x0d) shown += "\\r";
    else if (code <= 0xff) shown += `\\x${code.toString(16).padStart(2, "0")}`;
    else shown += `\\u{${code.toString(16)}}`;
  }
  return shown;
}
