export function isPipeTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.includes("|", 1);
}

function splitPipeRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function isPipeSeparator(line: string): boolean {
  if (!isPipeTableLine(line)) return false;
  const cells = splitPipeRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.replaceAll(" ", "")));
}

export function collectPipeTable(
  lines: string[],
  start: number,
): { end: number; headers: string[]; rows: string[][] } | null {
  if (!isPipeTableLine(lines[start] ?? "")) return null;
  const block: string[] = [];
  let index = start;
  while (index < lines.length && isPipeTableLine(lines[index])) {
    block.push(lines[index]);
    index += 1;
  }
  if (block.length < 2) return null;
  const headers = splitPipeRow(block[0]);
  const bodyStart = isPipeSeparator(block[1]) ? 2 : 1;
  const rows = block
    .slice(bodyStart)
    .filter((line) => !isPipeSeparator(line))
    .map(splitPipeRow);
  if (headers.every((cell) => !cell) && rows.length === 0) return null;
  return { end: index, headers, rows };
}
