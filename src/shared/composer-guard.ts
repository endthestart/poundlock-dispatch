export function composerSendBlocked(input: {
  approvals?: { projectId?: string }[];
  needsInput?: { choices?: { id: string }[]; kind?: string };
  projectId?: string;
  /** A card button sends its choice id; that is a decision, not free text. */
  choiceId?: string;
}): string | undefined {
  const pending = (input.approvals ?? []).filter(
    (item) => !input.projectId || !item.projectId || item.projectId === input.projectId,
  );
  if (pending.length)
    return "Decide the approval card before sending. Sending does not allow the action.";
  // A manager question's options are suggestions; words answer it too.
  if (
    input.needsInput?.choices?.length &&
    input.needsInput.kind !== "question" &&
    !input.needsInput.choices.some((choice) => choice.id === input.choiceId)
  )
    return "Use the buttons on the card. Sending does not resume or allow.";
  return undefined;
}

/**
 * Submit composer text without losing it on failure. The draft is cleared
 * optimistically and restored if sending fails, unless the user already typed
 * something new in the meantime.
 */
export async function submitComposerDraft(
  text: string,
  draft: {
    clear: () => void;
    restore: (text: string) => void;
    current: () => string;
    send: (text: string) => Promise<unknown>;
  },
): Promise<{ ok: boolean; error?: string }> {
  draft.clear();
  try {
    await draft.send(text);
    return { ok: true };
  } catch (error) {
    if (!draft.current().trim()) draft.restore(text);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
