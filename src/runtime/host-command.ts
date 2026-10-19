import { basename } from "node:path";
import type { HostCommandPort } from "@core/orchestration";
import type { ToolJournal, ToolJournalRecord } from "@core/tool-journal";
import { shellJoin } from "@shared/approval-copy";
import { type NetworkReach, projectReach } from "@shared/network";
import type { ToolTrustMode } from "@shared/permissions";
import { type CommandNetwork, commandNetwork } from "./command-network.js";
import { crashSummary } from "./crash-reports.js";
import { proxyEnvironment, reachProxy, registryProxy } from "./registry-proxy.js";
import {
  codeRunningSubcommand,
  destructiveCommandReason,
  effectiveCommandEffect,
  executeResolvedCommand,
  isDependencyInstaller,
  type ResolvedCommand,
  type RunCommandInput,
  resolveCommand,
} from "./run-command.js";
import {
  assistCommandBoundary,
  networkOnlyProfile,
  qualifyMacosSandbox,
  type SandboxQualification,
  type SandboxRequest,
  wrapWithSandbox,
} from "./sandbox.js";
import { buildSandboxRequest } from "./sandbox-policy.js";

export interface HostCommandContext {
  projectRoot: string;
  cwd?: string;
  extraPath: string[];
  /** Explicitly trusted runtime directories (see trustedRuntimeDirectories). */
  runtimeDirs?: string[];
  /**
   * Folders granted beyond the attached project that the worker may write in.
   * A command may run in one, and a script inside one counts as project code
   * rather than a host tool.
   */
  writeRoots?: string[];
  privateHome: string;
  trust: ToolTrustMode;
  /**
   * An investigation. Only passive inspection runs, always inside a sandbox
   * that cannot write the project; anything else is refused, not asked.
   */
  readOnly?: boolean;
  allowDependencyNetwork: boolean;
  /** The project's network switches (ADR 015); defaults when omitted. */
  reach?: NetworkReach;
  sandboxRequest: SandboxRequest;
  signal: AbortSignal;
  journal?: ToolJournal;
  journalMeta?: Partial<
    Pick<
      ToolJournalRecord,
      | "piSessionId"
      | "piMessageId"
      | "toolCallId"
      | "workflowId"
      | "planRevision"
      | "taskId"
      | "attemptId"
    >
  >;
  authorize?: (
    command: ResolvedCommand,
    context: {
      requireUserApproval: boolean;
      approvalReason?: string;
      /**
       * Whether an approval reviewer may answer instead of the user: only for
       * a command that will run inside the sandbox and is not destructive
       * (ADR 010). Anything else is the user's decision (M6).
       */
      reviewable: boolean;
    },
  ) => Promise<"allow" | "deny">;
  execute?: typeof executeResolvedCommand;
  qualifySandbox?: () => Promise<SandboxQualification>;
  refreshPolicy?: () => Promise<{
    trust: ToolTrustMode;
    allowDependencyNetwork: boolean;
    reach?: NetworkReach;
    sandboxRequest: SandboxRequest;
  }>;
  onOutput?: (chunk: string) => void;
  rewriteInvocation?: (
    program: string,
    args: string[],
  ) => { program: string; arguments: string[] } | undefined;
}

/**
 * This host's implementation of `OrchestratorDeps.hostCommands`, in one place
 * so every composition root — desktop, terminal, tests — wires the same thing
 * and the orchestrator never reaches up into this layer to find it.
 */
export const hostCommandPort: HostCommandPort = {
  run: (input, ctx) => runHostCommand(input, ctx),
  approvalAction: (command) => commandApprovalAction(command),
  approvalDisplay: (command) => commandApprovalDisplay(command),
  buildSandboxRequest: (input) => buildSandboxRequest(input),
};

export async function runHostCommand(
  input: RunCommandInput,
  ctx: HostCommandContext,
): Promise<{ exitCode: number | null; output: string; error?: string }> {
  return runHostCommandWithPolicy(input, ctx, 0);
}

export function commandApprovalAction(command: ResolvedCommand): string {
  const bound =
    command.invocationPath && command.invocationPath !== command.program
      ? `${command.program} via ${command.invocationPath}`
      : command.program;
  const invocation = `${bound} ${JSON.stringify(command.arguments)}`;
  // A remembered grant matches this text exactly, so it lapses when a runner's inputs change (M7).
  const inputs = command.inputs ? ` · inputs=${command.inputs}` : "";
  // The network is the project's switches' business (ADR 015), not the command's.
  return `${invocation} · capability=${command.capability} · effect=${command.effect} · source=${command.executableSource}${inputs}`;
}

export function commandApprovalDisplay(command: ResolvedCommand): {
  displayCommand: string;
  requestedCommand?: string;
} {
  const displayCommand = shellJoin(command.program, command.arguments);
  const requestedCommand = shellJoin(command.requestedProgram, command.requestedArguments);
  return {
    displayCommand,
    requestedCommand: requestedCommand === displayCommand ? undefined : requestedCommand,
  };
}

async function runHostCommandWithPolicy(
  input: RunCommandInput,
  ctx: HostCommandContext,
  policyRetry: number,
): Promise<{ exitCode: number | null; output: string; error?: string }> {
  const refreshed = await ctx.refreshPolicy?.();
  const trust = refreshed?.trust ?? ctx.trust;
  const allowDependencyNetwork = refreshed?.allowDependencyNetwork ?? ctx.allowDependencyNetwork;
  const reach = refreshed?.reach ?? ctx.reach ?? projectReach();
  const baseSandboxRequest = refreshed?.sandboxRequest ?? ctx.sandboxRequest;
  const candidate = await resolveCommand(
    { ...input, cwd: input.cwd ?? ctx.cwd },
    ctx.projectRoot,
    ctx.extraPath,
    ctx.privateHome,
    ctx.rewriteInvocation,
    ctx.runtimeDirs,
    ctx.writeRoots,
  );
  const resolved = { ...candidate, effect: effectiveCommandEffect(candidate) };
  const action = {
    tool: "run_command",
    program: resolved.program,
    arguments: resolved.arguments,
    cwd: resolved.cwd,
    executable: resolved.executable,
    executableSource: resolved.executableSource,
    capability: resolved.capability,
    effect: resolved.effect,
    networkMode: resolved.networkMode,
    timeoutMs: resolved.timeoutMs,
  };
  const deny = async (reason: string) => {
    await ctx.journal?.recordDenied({
      ...ctx.journalMeta,
      action,
      authorization: "deny",
      sideEffectScope: [],
      result: { error: reason },
    });
    throw new Error(reason);
  };
  if (resolved.networkMode === "dependency" && resolved.capability !== "install_deps") {
    await deny("Dependency network is available only to a typed dependency-install operation.");
  }
  // The worker names its own capability, so the name alone cannot be the
  // authorization. Check that the program is one that installs dependencies.
  if (
    resolved.capability === "install_deps" &&
    !isDependencyInstaller(resolved.requestedProgram) &&
    !isDependencyInstaller(resolved.program)
  ) {
    await deny(
      `${resolved.requestedProgram} is not a dependency installer, so it cannot claim install_deps or the dependency network.`,
    );
  }
  const running =
    resolved.capability === "install_deps"
      ? (codeRunningSubcommand(resolved.requestedProgram, resolved.requestedArguments) ??
        codeRunningSubcommand(resolved.program, resolved.arguments))
      : undefined;
  if (running) {
    await deny(
      `${resolved.requestedProgram} is not a plain dependency install here (${running}), so it cannot claim install_deps or the dependency network. Use an install subcommand such as \`npm ci\` or \`uv sync\`, give flag values as --flag=value, or run it as an ordinary command.`,
    );
  }
  const decided = commandNetwork(resolved.networkMode, reach, ctx.readOnly);
  if ("refused" in decided) await deny(decided.refused);
  const network = decided as CommandNetwork;
  if (ctx.readOnly) {
    const refusal =
      resolved.capability !== "inspect" || resolved.effect !== "inspect"
        ? `This is a read-only investigation, so only passive inspection runs (capability and effect inspect). ${resolved.capability} is not available here; report that a delegated task is needed for it.`
        : destructiveCommandReason(resolved);
    if (refusal) await deny(refusal);
  }
  const wantsSandbox = trust === "assist" || Boolean(ctx.readOnly);
  const boundary = wantsSandbox
    ? await assistCommandBoundary(ctx.qualifySandbox)
    : { mode: "ask" as const, qualification: { available: false, runtime: "none" as const } };
  const destructiveReason = wantsSandbox ? destructiveCommandReason(resolved) : undefined;
  // The command sandbox cannot read .git (Apple's git also needs an xcrun cache
  // outside it), so git here only fails with an error that reads like a broken
  // machine. Say where Git history is instead.
  if (
    wantsSandbox &&
    boundary.mode === "sandbox" &&
    [resolved.program, resolved.requestedProgram].some(
      (program) => basename(program).toLowerCase() === "git",
    )
  )
    await deny(
      "Use git_inspect for Git: status, log, show, diff and file contents. run_command runs in a sandbox that cannot read .git.",
    );
  if (ctx.readOnly && boundary.mode !== "sandbox")
    await deny(
      `This is a read-only investigation and no sandbox can keep this command from writing: ${
        boundary.qualification.reason ?? "the operating-system sandbox is unavailable"
      }. Report this as an environment problem.`,
    );
  const requireUserApproval =
    trust === "ask" ||
    (wantsSandbox &&
      (boundary.mode === "ask" ||
        resolved.executableSource === "unapproved" ||
        Boolean(destructiveReason)));
  const approvalReason =
    destructiveReason ??
    (boundary.mode === "ask" && wantsSandbox
      ? (boundary.qualification.reason ?? "The operating-system sandbox is unavailable.")
      : resolved.executableSource === "unapproved"
        ? "The executable is outside the selected project environment and sanitized host tool paths."
        : undefined);
  const reviewable =
    requireUserApproval && trust === "assist" && boundary.mode === "sandbox" && !destructiveReason;
  const decision = ctx.authorize
    ? await ctx.authorize(resolved, { requireUserApproval, approvalReason, reviewable })
    : requireUserApproval
      ? "deny"
      : "allow";
  if (decision !== "allow") {
    await deny("Tool approval denied or cancelled. Worker stopped.");
  }
  const finalPolicy = await ctx.refreshPolicy?.();
  if (
    finalPolicy &&
    policyFingerprint(finalPolicy) !==
      policyFingerprint({
        trust,
        allowDependencyNetwork,
        reach,
        sandboxRequest: baseSandboxRequest,
      })
  ) {
    if (policyRetry >= 2) {
      await deny("Project permissions changed repeatedly while authorizing this command.");
    }
    return runHostCommandWithPolicy(input, ctx, policyRetry + 1);
  }
  const pending = await ctx.journal?.begin({
    ...ctx.journalMeta,
    action,
    authorization:
      wantsSandbox && boundary.mode === "sandbox"
        ? "sandbox"
        : requireUserApproval
          ? "ask"
          : "allow",
    sideEffectScope: [
      ...new Set([resolved.cwd, ...baseSandboxRequest.writable, baseSandboxRequest.tmp]),
    ],
  });
  try {
    // Preserve the selected invocation path. On macOS, executing a virtual
    // environment's resolved Homebrew target bypasses pyvenv.cfg and silently
    // turns `.venv/bin/python` into the system interpreter. The canonical
    // executable remains recorded above for policy and audit.
    let program = resolved.invocationPath;
    let args = resolved.arguments;
    let env = resolved.env;
    // An install reaches only the registry proxy (L19); with one switch on, a
    // command reaches this Mac and the reach proxy (ADR 015).
    const proxy =
      network.kind === "registry"
        ? await registryProxy()
        : network.kind === "reach"
          ? await reachProxy(reach)
          : undefined;
    // This Mac's own services are part of the local network.
    const loopback = network.kind === "reach" && reach.localNetwork;
    if (proxy) env = { ...env, ...proxyEnvironment(proxy, loopback) };
    if (wantsSandbox && boundary.mode === "sandbox") {
      const wrapped = await wrapWithSandbox(
        [program, ...args],
        {
          ...baseSandboxRequest,
          network: sandboxNetwork(network),
          proxyPort: proxy?.port,
          loopback,
        },
        boundary.qualification,
      );
      program = wrapped.program;
      args = wrapped.arguments;
    } else if (network.kind !== "direct") {
      // Unsandboxed, the command keeps the user's authority except the network.
      // Where sandbox-exec is unavailable the switches cannot be enforced.
      const qualification = await (ctx.qualifySandbox ?? qualifyMacosSandbox)();
      if (qualification.available && qualification.runtime === "sandbox-exec") {
        args = [
          "-p",
          networkOnlyProfile(network.kind === "none" ? "deny" : "proxy", {
            port: proxy?.port,
            loopback,
          }),
          program,
          ...args,
        ];
        program = "/usr/bin/sandbox-exec";
      }
    }
    const started = Date.now();
    const result = await (ctx.execute ?? executeResolvedCommand)(
      { ...resolved, env, executable: program, arguments: args },
      ctx.signal,
      ctx.onOutput,
    );
    if (result.exitCode !== 0) {
      const crash = await crashSummary({
        output: `${result.output}\n${result.error ?? ""}`,
        projectRoot: ctx.projectRoot,
        since: started,
      });
      if (crash) result.output = `${result.output}\n\n${crash}`;
    }
    if (pending) {
      await ctx.journal?.complete(
        pending.eventId,
        result.error || result.exitCode !== 0
          ? { error: result.error ?? `exit ${result.exitCode}` }
          : undefined,
      );
    }
    return result;
  } catch (error) {
    if (pending) {
      await ctx.journal?.complete(pending.eventId, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

function sandboxNetwork(network: CommandNetwork): SandboxRequest["network"] {
  switch (network.kind) {
    case "direct":
      return "allow";
    case "registry":
      return "dependency";
    case "reach":
      return "proxy";
    default:
      return "deny";
  }
}

function policyFingerprint(input: {
  trust: ToolTrustMode;
  allowDependencyNetwork: boolean;
  reach?: NetworkReach;
  sandboxRequest: SandboxRequest;
}): string {
  return JSON.stringify({
    trust: input.trust,
    allowDependencyNetwork: input.allowDependencyNetwork,
    reach: input.reach ?? projectReach(),
    sandboxRequest: {
      ...input.sandboxRequest,
      writable: [...input.sandboxRequest.writable].sort(),
      deniedRead: [...input.sandboxRequest.deniedRead].sort(),
    },
  });
}
