# ADR 003 — Captured sources and a managed review workspace

Status: Superseded, 2026-09-11, by [ADR 007](007-live-folder-and-two-execution-paths.md).

The first implementation snapshotted a local folder into an isolated git
workspace and required a per-file inclusion review before create. That copied
Poundlock’s durable-job snapshot UX into project creation. The owner rejected
it: adding a project is a path, like an editor. Gitignore and default ignores
apply when walking the tree. Durable snapshot limits apply only when submitting
a job.
