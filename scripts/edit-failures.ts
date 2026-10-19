/**
 * Counts Pi `edit` calls in worker sessions, as the study behind the edit
 * guard counted them: failures, edits the edit guard refused, and the longest run
 * of failed edits on one file. Works on sessions with or without the guard.
 *
 *   node --experimental-strip-types scripts/edit-failures.ts <Dispatch data dir or sessions dir>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: edit-failures.ts <Dispatch data dir or sessions dir>");
  process.exit(2);
}

interface Part {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  arguments?: { path?: string };
}

let edits = 0;
let failed = 0;
let refused = 0;
let longest = 0;
const files = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".jsonl") && file.includes("sessions"))
  .sort();
for (const file of files) {
  const paths = new Map<string, string | undefined>();
  const runs = new Map<string | undefined, number>();
  for (const line of readFileSync(join(root, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const message = (JSON.parse(line) as { message?: Record<string, unknown> }).message;
    const content = Array.isArray(message?.content) ? (message.content as Part[]) : [];
    for (const part of content)
      if (part.type === "toolCall" && part.name === "edit" && part.id)
        paths.set(part.id, part.arguments?.path);
    if (message?.role !== "toolResult" || message.toolName !== "edit") continue;
    if (content.some((part) => part.text?.startsWith("Edit not run:"))) {
      refused += 1;
      continue;
    }
    const path = paths.get(String(message.toolCallId));
    const run = message.isError ? (runs.get(path) ?? 0) + 1 : 0;
    runs.set(path, run);
    edits += 1;
    if (message.isError) failed += 1;
    longest = Math.max(longest, run);
  }
}
const rate = edits ? ((100 * failed) / edits).toFixed(1) : "0.0";
console.log(
  `${files.length} sessions: ${edits} edits, ${failed} failed (${rate}%), ${refused} refused by the guard, longest run of failures on one file ${longest}`,
);
