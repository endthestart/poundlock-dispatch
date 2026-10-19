import type { defineTool as DefineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GIT_INSPECT_COMMANDS, type GitInspectContext, gitInspect } from "./git-inspect.js";

export function createGitInspectTool(
  defineTool: typeof DefineTool,
  options: Omit<GitInspectContext, "signal"> & { signal: AbortSignal },
) {
  return defineTool({
    name: "git_inspect",
    label: "Inspect Git",
    description:
      "Read the project's Git history without changing anything. command: status; log (revisions: one range such as a..b, optional stat, maxCount); show (one commit, optional stat); diff (a range or up to two revisions, or none for uncommitted changes; optional stat); file (a file's content at one revision; exactly one path). paths limits to project-relative paths. For a large change, run diff with stat first, then one path at a time. Long results come in pages: pass offset to continue. Secret files are left out of patches.",
    parameters: Type.Object({
      command: Type.Union(GIT_INSPECT_COMMANDS.map((command) => Type.Literal(command))),
      revisions: Type.Optional(Type.Array(Type.String())),
      paths: Type.Optional(Type.Array(Type.String())),
      stat: Type.Optional(Type.Boolean()),
      maxCount: Type.Optional(Type.Number()),
      offset: Type.Optional(Type.Number()),
    }),
    execute: async (_id, params, signal) => {
      const text = await gitInspect(params, {
        ...options,
        signal: signal ? AbortSignal.any([options.signal, signal]) : options.signal,
      });
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });
}
