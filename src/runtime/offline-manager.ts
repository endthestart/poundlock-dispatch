import type { ManagerPort } from "@core/orchestration";
import { ScriptedManager } from "@core/scripted-manager";
import type { FileStore } from "@core/store";

export function createOfflineManager(store: FileStore): ManagerPort {
  return new ScriptedManager(async (ctx) => {
    if (ctx.prompt.includes("Review these worker")) {
      const tasks = await store.getTasks(ctx.project.id);
      const notes: string[] = [];
      for (const task of tasks.filter((item) => item.status === "needs_review")) {
        const verification = task.attempts.at(-1)?.result?.verification;
        if (verification && verification.status === "failed") {
          notes.push(
            await ctx.host.requestRepair(task.id, verification.reason || "Verification failed."),
          );
        } else {
          notes.push(await ctx.host.requestApplyResult(task.id));
        }
      }
      const remaining = (await store.getTasks(ctx.project.id)).filter(
        (task) =>
          task.status !== "applied" && task.status !== "cancelled" && task.status !== "failed",
      );
      if (remaining.length === 0) {
        await ctx.host.markComplete("The worker's changes are in the project folder.");
      }
      return notes.join("\n") || "Reviewed worker results.";
    }
    const user = ctx.prompt.slice(ctx.prompt.indexOf("The user said:")).slice(0, 4000);
    await ctx.host.proposePlan({
      summary: "One worker task will implement the request in the project folder.",
      acceptanceCriteria: [
        "The worker patch matches the request",
        "Checks recorded in the task details pass or are marked unverified",
      ],
      tasks: [
        {
          title: "Implement request",
          objective: "Implement the user's request",
          workerPrompt: user || ctx.prompt,
          acceptanceCriteria: "Produce a reviewable patch",
          difficulty: "small",
          route: "interactive",
        },
      ],
    });
    return "Here is a plan with one worker task. Review it, then start.";
  });
}
