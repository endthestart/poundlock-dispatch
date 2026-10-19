const SHELL_META = /[\n\r;&|<>`$(){}\\*?\[\]~]/;

export function compileArgv(command: string): { program: string; arguments: string[] } {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("Command is empty.");
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (const ch of trimmed) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (SHELL_META.test(ch)) {
      throw new Error("Unsupported shell syntax. Provide a program and argument list.");
    }
    current += ch;
  }
  if (quote) throw new Error("Unclosed quote in command.");
  if (current) tokens.push(current);
  if (!tokens.length) throw new Error("Command is empty.");
  return { program: tokens[0], arguments: tokens.slice(1) };
}
