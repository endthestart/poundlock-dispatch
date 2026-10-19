import type { ManagerPort, ManagerTurnContext, ManagerTurnResult } from "./orchestration.js";

export class ScriptedManager implements ManagerPort {
  traces: Array<{ name: string; summary: string; error?: boolean }> = [];

  constructor(
    private readonly script: (
      ctx: ManagerTurnContext,
      trace: ScriptedManager["traces"],
    ) => Promise<string>,
  ) {}

  async runTurn(ctx: ManagerTurnContext): Promise<ManagerTurnResult> {
    this.traces = [];
    const text = await this.script(ctx, this.traces);
    return { text, toolTrace: this.traces };
  }
}
