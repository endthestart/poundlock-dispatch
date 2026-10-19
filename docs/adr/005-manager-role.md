# ADR 005 — Manager role is a permission boundary

Status: Accepted, 2026-09-11. Updated the same day for live folders.

The Project Manager plans, chooses an execution path, delegates, reviews, and
coordinates. It does not write the user’s repository.

A prompt is not sufficient. The manager session must omit shell, write, and
edit tools against the project. It may write **only** Poundlock Dispatch-managed notes
(non-repo state).

Local **sub-agents** (separate Pi session, interactive `/v1`) write ADRs, specs,
and ordinary project files. **Durable jobs** author isolated implementation and
return patches. Job submission is a client operation after the manager chooses
that path. Patch application takes an exact worker artifact.

The same Poundlock weights may fill several mapped roles. The split is tools,
session, and isolation — not a second identity.

The manager keeps one short **project brief** in the same data directory
(`notes/brief.md`): objectives, requirements and an index of the project's ADRs,
at most 4,000 characters, saved through its `update_project_brief` tool. Dispatch
appends it to the manager's system prompt on every turn, so compaction cannot drop
it and it does not pile up in the conversation. It is fenced as untrusted, a cut
brief says so, the owner can read it in the plan panel or on the terminal board,
and it goes with the notes when a new conversation starts.
