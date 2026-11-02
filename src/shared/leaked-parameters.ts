import { MAX_QUESTION_OPTIONS, type QuestionOption } from "./types.js";

/**
 * A local manager sometimes writes its next tool parameter inside the question,
 * as `…?</parameter><parameter=options>[…]`, and the owner saw the markup. The
 * question ends at the stray tag; options written after it are kept
 * when they parse, and dropped otherwise.
 */
export function splitLeakedParameters(
  question: string,
  options: QuestionOption[] | undefined,
): { question: string; options?: QuestionOption[] } {
  const cut = question.indexOf("</parameter>");
  if (cut < 0) return { question, ...(options ? { options } : {}) };
  const leaked = question.slice(cut).match(/<parameter=options>\s*(\[[\s\S]*\])/);
  let parsed: QuestionOption[] | undefined;
  try {
    const value: unknown = leaked ? JSON.parse(leaked[1]) : undefined;
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      value.every((item) => typeof item?.label === "string" && item.label.trim())
    )
      parsed = value.slice(0, MAX_QUESTION_OPTIONS).map((item) => ({
        label: item.label.trim(),
        ...(typeof item.description === "string" ? { description: item.description } : {}),
      }));
  } catch {
    parsed = undefined;
  }
  const kept = options ?? parsed;
  // Never an empty question: without text before the tag, show it with the tags removed.
  const asked =
    question.slice(0, cut).trim() || question.replace(/<\/?parameter[^>]*>/g, " ").trim();
  return { question: asked, ...(kept ? { options: kept } : {}) };
}
