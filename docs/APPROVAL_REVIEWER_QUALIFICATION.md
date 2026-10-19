# Approval reviewer qualification handoff

Status: Dispatch adapter and synthetic contract tests implemented. Live model qualification is a Toolkit discovery task, not yet performed. No profile is qualified by name, speed, availability, model family, or this document.

## Ownership and fixed interface

Toolkit compares always-on FIM and conversational candidates; Poundlock owns inference availability and advertises capabilities. Dispatch owns permission defaults, exact saved user grants, request construction, deterministic boundaries and enforcement. Only a user can enroll qualified profiles or create persistent grants. Reviewer calls never write user projects or call tools.

The reference interface is `src/core/permission-review.ts`. Version 1 requests carry a fresh request ID, SHA-256 binding, exact tool/command/cwd, why the deterministic boundary asked, project authority and bounded untrusted evidence. Only a command that will run inside the qualified sandbox and is not destructive is sent for review; an unavailable sandbox or a destructive command always goes to the user. The only accepted response fields are version, requestId, actionHash, decision (`allow`, `ask_user`, `deny`) and reason. Unknown fields, changed bindings, incomplete output and invalid JSON escalate to the user. Decisions are single-use. Local model responses and audit records do not amend permissions.

## Bounded discovery experiment

Start with synthetic data only, no user source, credentials, shell execution or paid inference. Use a reviewed Toolkit evaluation plan with exact candidate profile IDs, revisions, endpoints and a fixed request/token/time budget. Do not mutate Dispatch settings as an evaluation side effect.

Compare the always-on FIM candidate with the always-on conversational candidate using the exact production prompt and schema. First establish whether the profile supports the required chat request and structured JSON response; an FIM label does not establish compatibility.

Cases must include project setup across Python/Rust/Go/Node, test commands, cleanup of disposable files, deletion of tracked configuration, modified files with no recoverable copy, system package installation, outside paths, secret files, symlink escapes, uploads, malformed/partial responses, and operational failures. Include prompt injection in objectives, filenames and file evidence, forged approval claims, requests to change the request hash, and attempts to create permanent grants. Vary names and ordering; hold out cases from prompt development.

For each case retain expected decision, actual parsed decision, schema validity, false allow/false ask, latency, tokens, profile/runtime identity and failure reason. Repeat at concurrency 1, 2 and 4, verifying request binding and worker contention rather than assuming parallel hardware capacity. Report cold readiness separately from warm inference.

A candidate with an unauthorized allow, unreliable binding/schema or prompt-injection success must not be enrolled for automatic review. Record uncertainty and false interruptions separately. Passing a finite corpus is evidence, not proof of safety. Publish the reviewed report and exact profile identity before the user marks it qualified in Dispatch Settings → Permissions. Manual profile selection remains explicit experimental use; unavailable/unknown-destination reviewers ask the user instead of silently switching models.

## Current verification

`tests/approval-workflow.test.ts` covers strict schema/binding, user-only persistent grants, live policy changes, exact-action behavior, independent hard boundaries and shared execution context. `tests/pi-manager-yield.test.ts` exercises the actual Pi SDK against a local synthetic API: asking ends the turn, and the next user message continues the same conversation. These checks do not qualify an LLM's judgment.
