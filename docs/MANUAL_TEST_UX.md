# Poundlock Dispatch 0.1.3 acceptance

Automated checks establish contracts and packaging. They do not establish that a
particular model can manage or implement a project. Complete the short packaged
workflow below before promoting a release.

## Automated checks

```sh
npm test
npm run typecheck
npm run lint
npm run package:dir
```

The packaged smoke must open the actual application artifact, load the preload
bridge, refresh Poundlock discovery, preserve saved role bindings, and restore a
saved conversation without replaying manager or worker actions.

## First-use workflow

1. Start with an isolated Dispatch data directory.
2. Connect to a Poundlock 0.1.3 controller and test an application token.
3. Confirm API major 1, contract revision 3 or newer, and the required features
   from `compat/poundlock.json`.
4. Map separate Manager and Workers defaults. Confirm each choice shows its data
   destination before its transport, for example **Your infrastructure · via
   LiteLLM**.
5. If the Manager is external, use a token with **Allow prompts and files to
   leave the controlled network**. Saving the default records the exact profile,
   destination, and routing revision. The same unchanged default must not prompt
   again. A changed route or destination must stop before sending context.
6. Add a disposable local folder and verify that New conversation, Start a new run, History, Pause,
   Cancel, and project removal leave its files intact.
7. In a project with a long conversation, choose Project → Compact conversation (terminal:
   `/compact`). A notice appears in the conversation saying how many messages were summarised,
   the tokens before and after, and that the brief and recent turns were kept; the next reply
   still reflects the brief. The context chip falls accordingly. Repeat at once: it says there is
   nothing more to compact.

## Manager conversation workflow

Before the implementation run, exercise both sides of the general manager contract:

1. In one disposable project, give a short, materially underspecified product idea.
   The Manager should inspect the folder, ask one high-value question at a time, and
   retain the answers. After the user says to build the agreed specification, it
   should plan from that context without restarting discovery.
2. In another disposable project, provide a complete specification with behavior,
   constraints, and acceptance criteria. The Manager should inspect relevant project
   context and proceed without ceremonial questions.

Questions must follow the product decisions that are actually missing; they must not
be a Django, Python, or framework checklist. Worker findings and verification return
to the same Manager, which should accept, repair, advance dependent work, or ask for
a new material decision without requiring the user to relay messages between agents.

If the Manager finishes a worker review without accepting it, requesting a repair, or
asking a question, Dispatch must pause instead of replaying the review on the polling
interval. The conversation must explain the unresolved review, the decision area
above the composer must read **Review needs a decision**, and **Resume** must send that result to the
Manager once. Accepting the result must allow the next dependent task to start.

The review turn must contain a bounded evidence summary rather than full
Interactive patch bodies or unbounded worker output. The Manager can inspect a
small number of relevant files with `list_project_files` and
`read_project_file`. A truncated or terminated Manager response invalidates
that Pi transcript before retry. If planning failed before a plan existed, the
decision area says **Manager needs another message** and the conversation directs
the user to retry through the composer rather than referring to an unavailable
Resume control.

During execution, progress names the exact active or review task instead of
showing an ambiguous cumulative started count. Accepted work cannot be reopened
while later tasks are still running. After completion, the optional
**Review completed work again** action sends the accepted results through a new
manager review revision without resetting project files.

## Django implementation scenario

Use a clean folder and ask the Manager to build a small Django task manager with
SQLite, automated tests, and a short README.

- The Manager discusses, plans, delegates, and reviews without shell or write
  tools.
- One interactive Pi worker prepares the approved Python/uv environment, edits
  the attached folder, and runs the recorded checks.
- A Finder-launched macOS build discovers `uv` from approved standard tool
  locations such as `/opt/homebrew/bin`, even when that directory is absent
  from the inherited application `PATH`.
- If `uv` is genuinely unavailable, Dispatch creates the project-local
  environment with `python -m venv` and uses that environment's `pip` for
  approved project dependencies. It blocks only when Python itself is missing,
  environment creation fails, or a `uv.lock` contract cannot be honored.
- Routine work under **Approve for me** stays inside the qualified macOS sandbox
  and does not request raw Bash or repeated approval for project-environment
  checks. A destructive command still produces a clear decision card.
- The selected virtual environment runs as that environment; execution evidence
  must not show a silent system-interpreter fallback.
- The UI shows the actual profile, role, destination, status, checks, and any
  blocked reason.
- Infrastructure, policy, work, context, and output failures remain distinct.
- One bounded repair continues the same worker session.
- Completion requires actual verification evidence and Manager review.
- Reopening Dispatch restores state without replaying a tool or inference turn.

Run one clean workflow after lower-cost tests pass. Record the source commit,
package checksum, Poundlock image digest, profile revisions, and outcome in the
private ecosystem release set. Keep credentials, operator-specific configuration, raw
prompts, and private project content outside this repository.
