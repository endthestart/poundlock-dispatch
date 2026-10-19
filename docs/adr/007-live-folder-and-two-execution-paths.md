# ADR 007 — Live folder path; interactive inference and durable jobs

Status: Accepted, 2026-09-11.

## Decision

A local Poundlock Dispatch project is a **path** to an existing folder. Create does not
copy the tree, does not show a file checklist, and does not apply Poundlock’s
50 MiB job snapshot limit. Pi walks the folder using `.gitignore` plus Poundlock Dispatch
default ignores (dependency dirs, `.env`, keys).

Two Poundlock execution paths, both available now:

1. **Interactive** — Pi stays on this computer, sends prompts (and selected
   context) to `GET /v1/models` / `POST /v1/chat/completions`. The workspace is
   not uploaded. The turn dies if Poundlock Dispatch quits. The limit is the model context
   window. Use this for planning, ADRs, specs, and ordinary local sub-agent work.
2. **Durable jobs** — `POST /api/v1/jobs` with a prompt and a source snapshot
   (or git/empty). Runs in a container, survives disconnect, polled for status.
   Poundlock has no job-done webhook. The 50 MiB / 10 000 file cap applies **here
   only**. Use this for long, isolated, or large-model work.

The Project Manager **always** chooses the path and may escalate (tiny snippet →
interactive → durable → optional off-box pool). It does not silently swap a
model mid-attempt. Exclusivity in Poundlock is per machine+runtime slot, not
cluster-wide; different nodes can run at once.

## Two directories

- **User repo** (e.g. `recipe-box`): ADRs, specs, code, anything that belongs
  in the project. Local sub-agents write here.
- **Poundlock Dispatch data dir** (Application Support on macOS): connection, role map,
  conversation, tasks, and manager-only notes that must not be pushed (for
  example “also read `~/Development/devbox`”).

The manager session still has no shell, write, or patch tools. Sub-agents are a
different Pi session with write tools on the user repo. Durable workers remain
isolated jobs.

## Consequences

- Git projects remain a checkout of an HTTPS URL plus a branch or commit
  (ADR 009). Optional GitHub/Gitea tokens live in Poundlock Dispatch’s data dir.
- Job snapshot assembly is deferred until the manager submits a durable job.
- Raising the 50 MiB cap is a Poundlock change. Tokens/s and hardware copy
  should be published by Poundlock later; until then the user role map is the
  capability document.
