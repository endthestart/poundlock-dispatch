export async function settleManagerPrompt(
  prompt: Promise<unknown>,
  hasYielded: () => boolean,
  whenYielded: Promise<void>,
  options?: { graceMs?: number; onHung?: () => void },
): Promise<"prompt" | "yielded"> {
  let settled = false;
  const finished = prompt
    .then(
      () => undefined,
      (error: unknown) => {
        if (!hasYielded()) throw error;
      },
    )
    .finally(() => {
      settled = true;
    });
  const outcome = await Promise.race([
    finished.then(() => "prompt" as const),
    whenYielded.then(() => "yielded" as const),
  ]);
  if (outcome === "prompt") {
    await finished;
    return "prompt";
  }
  await Promise.race([
    finished.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, options?.graceMs ?? 200)),
  ]);
  if (!settled) {
    const hung = options?.onHung;
    if (hung) setTimeout(hung, 0);
  }
  return "yielded";
}
