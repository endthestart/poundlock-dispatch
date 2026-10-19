import type { defineTool as DefineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type HostCommandContext, runHostCommand } from "./host-command.js";
import type { RunCommandInput } from "./run-command.js";

type RunCommandToolOptions = HostCommandContext;

export function createRunCommandTool(
  defineTool: typeof DefineTool,
  options: RunCommandToolOptions,
) {
  return defineTool({
    name: "run_command",
    label: "Run command",
    description:
      'Run one program with an argument array in the attached project. Do not pass a shell string. `arguments` are what follows the program name, so do not repeat the program: program git, arguments ["diff", "--stat"]. Working directory is already the project unless a relative subdirectory is supplied; do not cd or pass git -C for it.',
    parameters: Type.Object({
      program: Type.String(),
      arguments: Type.Array(Type.String(), { default: [] }),
      cwd: Type.Optional(Type.String()),
      timeout: Type.Optional(Type.Number()),
      capability: Type.Union([
        Type.Literal("inspect"),
        Type.Literal("test"),
        Type.Literal("build"),
        Type.Literal("install_deps"),
        Type.Literal("migrate"),
        Type.Literal("generate"),
        Type.Literal("arbitrary"),
      ]),
      effect: Type.Union(
        [Type.Literal("inspect"), Type.Literal("project_change"), Type.Literal("destructive")],
        {
          description:
            "The intended persistent effect: inspect makes no intentional project change; project_change creates or updates ordinary project artifacts; destructive discards work, data, or history and requires a decision.",
        },
      ),
      networkMode: Type.Optional(
        Type.Union([Type.Literal("deny"), Type.Literal("dependency"), Type.Literal("allow")], {
          description:
            "Omit it, or allow, for what the project's network switches allow. deny for no network. dependency only with capability install_deps, which reaches package registries.",
        }),
      ),
    }),
    execute: async (id, params: RunCommandInput & { timeout?: number }, signal, onUpdate) => {
      let streamed = "";
      const effectiveSignal = signal ? AbortSignal.any([options.signal, signal]) : options.signal;
      const result = await runHostCommand(
        {
          program: params.program,
          arguments: params.arguments ?? [],
          cwd: params.cwd,
          timeoutMs: (params.timeout ?? 600) * 1000,
          capability: params.capability,
          effect: params.effect,
          networkMode: params.networkMode,
        },
        {
          ...options,
          signal: effectiveSignal,
          journalMeta: { ...options.journalMeta, toolCallId: id },
          onOutput: (chunk) => {
            streamed = (streamed + chunk).slice(-24_000);
            onUpdate?.({
              content: [{ type: "text" as const, text: streamed }],
              details: {
                cwd: params.cwd ?? options.cwd ?? options.projectRoot,
                networkMode: params.networkMode ?? "allow",
              },
            });
          },
        },
      );
      if (result.error) throw new Error(`${result.error}\n${result.output}`);
      return {
        content: [{ type: "text" as const, text: `Exit ${result.exitCode}\n${result.output}` }],
        details: {
          cwd: params.cwd ?? options.cwd ?? options.projectRoot,
          networkMode: params.networkMode ?? "allow",
        },
      };
    },
  });
}
