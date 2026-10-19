import { wrapUntrusted } from "./untrusted.js";

/**
 * The most a project brief may hold, and the most Dispatch pins in the
 * manager's context: roughly a thousand tokens, small enough to sit in every
 * turn of a 32K manager without crowding out the work.
 */
export const PROJECT_BRIEF_MAX_CHARS = 4_000;

/**
 * Validates a brief the manager wants to save. Over the limit is refused,
 * naming the limit, rather than clipped: a silent cut would drop whatever the
 * manager wrote last, which is usually the newest decision.
 */
export function normalizeProjectBrief(text: string): string {
  const brief = text.trim();
  if (brief.length > PROJECT_BRIEF_MAX_CHARS)
    throw new Error(
      `The brief is ${brief.length.toLocaleString("en-US")} characters; the pinned limit is ${PROJECT_BRIEF_MAX_CHARS.toLocaleString("en-US")}. Condense it (objectives, requirements, an ADR index of path and one-line title) and call update_project_brief again. Detail belongs in the ADRs and requirement documents, which you read on demand.`,
    );
  return brief;
}

/**
 * The block appended to the manager's system prompt on every turn, or "" when
 * the project has no brief. It rides in the system prompt, not in the
 * conversation, so compaction cannot summarise it away and it is not repeated
 * in each turn's history. A brief over the limit, such as a file edited on
 * disk, is cut and says so; the manager is told how to fix it.
 *
 * The brief was written by the manager from repository text it read, so it is
 * fenced as untrusted like the other context Dispatch supplies.
 */
export function pinnedBriefBlock(brief: string): string {
  const text = brief.trim();
  if (!text) return "";
  const shown = text.slice(0, PROJECT_BRIEF_MAX_CHARS);
  const note =
    text.length > shown.length
      ? `\n[Brief truncated: showing the first ${PROJECT_BRIEF_MAX_CHARS.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters. Condense it with update_project_brief so nothing is lost.]`
      : "";
  return [
    "Pinned project brief. Dispatch adds it to every turn; compaction cannot drop it, and the owner can read it. Keep it current with update_project_brief.",
    wrapUntrusted("project brief", `${shown}${note}`, PROJECT_BRIEF_MAX_CHARS + 400),
  ].join("\n");
}
