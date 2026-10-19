# ADR 010 — Poundlock Dispatch owns permission and trust prompts

Status: Accepted, 2026-09-12. Updated for the 0.1.1 execution boundary.

## Decision

Consent that affects the user’s repo or sends source off this Mac is a Poundlock Dispatch
UI decision, not a chat reply and not a Pi TUI prompt.

Layers, same surface:

1. **Plan** — Approve in the plan panel. The manager records a plan with
   `propose_plan` and stops. It must not ask “shall I proceed?” in the thread.
2. **Execution path** — Start. If work is routed interactive or snippet, and
   that local sub-agent is not wired, Poundlock Dispatch asks Wait vs Run as durable
   jobs. Durable jobs snapshot the folder onto the Poundlock controller. That
   escalation is never silent, including Full access.
3. **Local tool trust** — Ask for approval / Approve for me / Full access.
   Settings stores the default for new projects. The composer chip overrides
   the current project. The Project Manager still has no shell, write, or patch
   tools in any mode.
4. **Tool cards** — When a local sub-agent needs a decision, Pi `tool_call` is
   intercepted and shown as a Poundlock Dispatch card. It does not become a
   hidden terminal prompt.

`defaultProjectTrust: always` on the manager session is a stopgap for read
tools, not a product permission model.

Approve for me is based on boundary and effect rather than a framework-command
allowlist. Dispatch requires a structured program and argument array, keeps the
working directory inside the attached project, denies secret reads, applies the
approved network mode and uses a qualified operating-system sandbox to confine
writes. The selected invocation path is preserved so project environments and
tool wrappers work without being mistaken for system execution.

Routine inspect, test, build and generation commands may run inside that
boundary across ecosystems. Recognizable deletion, source reset/history
rewrite, database erasure, arbitrary interpreter snippets, unapproved
executables, outside paths, unrestricted network, or an unavailable sandbox
require a decision. Full access remains the explicit opt-in to host-user
authority.

A small model is never the primary safety gate. An explicitly selected or
Toolkit-qualified local reviewer may make a single-use decision only after the
deterministic boundary has decided the action is eligible for review. The
request binds the exact command, project, plan revision, authority and bounded
file evidence. It cannot expand paths, network, destination, persistence, or
system authority; invalid, unavailable, uncertain, or changed reviews return to
the user.

## Why

The manager can describe routing, but it cannot grant it. Chat is a bad
permission bus. Pi harness prompts are invisible in a GUI. ChatGPT’s three
modes are a familiar default; Poundlock Dispatch adds one extra: leaving this Mac is
never covered by Full access.

## Consequences

- Start does not submit a durable job for interactive/snippet tasks unless the
  user opts in on a Poundlock Dispatch card.
- Leftover `pending_submit` attempts from older builds on interactive tasks
  are cancelled instead of retried.
- Sub-agent implementation must route Pi `tool_call` through this UI.
- Ask for approval does not card ordinary in-project file edits. Version
  control covers those. Shell commands, downloads, ignored/secret/outside
  paths, and destructive work still require a Poundlock Dispatch card. Remember
  is an exact command or path, not a folder-wide write grant.
