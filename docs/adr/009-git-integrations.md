# ADR 009 — GitHub and Gitea accounts live in Poundlock Dispatch

Status: Accepted, 2026-09-12.

## Decision

A Git project is an HTTPS URL plus a **branch name or a commit**. That is
enough to clone. GitHub and Gitea personal access tokens are optional, stored
only in Poundlock Dispatch’s data directory (`integrations.json` +
`integrations.secret.json`), and attached per project.

They are not Poundlock Access tokens. They are not written into the user’s
repo. They are not sent to Poundlock unless a later durable job clones that
private repository.

The manager may propose a pull request. Poundlock Dispatch must not push or open a PR
until the user confirms. The manager still has no forge, shell, or write tools.

Folder projects that already have a git remote may attach the same account
later. A nested folder inside another git checkout is not treated as having
that parent remote.

## Consequences

- Add project no longer asks for a 40-character commit only, or a per-project
  clone token.
- Push, PR open, and OAuth remain later work. Paste-a-PAT is v1.
- Poundlock’s job git source still wants a 40-character revision. Poundlock Dispatch
  stores the resolved `baseRevision` SHA for that later submit path.
