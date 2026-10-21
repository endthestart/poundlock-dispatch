# Poundlock Dispatch

A desktop app and a terminal client that plan, delegate and review software work on
your own projects, with models served by a [Poundlock](https://github.com/endthestart/poundlock)
controller. You talk to a Project Manager; it agrees a plan with you and hands
tasks to Pi workers, which edit your project folder; checks and the manager's
review decide what is accepted.

Status: 0.3.0, a developer preview. Autopilot is a preview within it. One
maintainer looks after this project; see [status and support](#status-and-support).

## How work runs

Dispatch runs work in three ways. They differ in where code runs and in what keeps
going when you close a window.

| | Where code runs | Closing Dispatch |
|---|---|---|
| **Attached work** (the default) | Your machine, in the project folder, under the permission mode you choose | Stops it. Reopening restores the conversation and plan; you resume. |
| **Autopilot** (preview) | Your machine, in a container on a dedicated VM, in a private copy of the project | It keeps going while the machine stays awake. It needs the matching terminal client installed. |
| **Durable jobs** (manual, `dispatch jobs`) | The Poundlock server, in restricted containers | It keeps going. Dispatch never turns its own tasks into durable jobs. |

In attached work and Autopilot only the model runs elsewhere: Poundlock serves the
inference, and the code runs on your machine.

**What leaves your machine.** The manager and workers send prompts, the files they
read and tool output to the Poundlock profiles you bind, and Poundlock sends them to
the model servers behind those profiles. A profile declared External sends them
beyond your network, and Dispatch asks before using one. A durable job uploads the
files you select to the Poundlock server. Commands a worker runs reach the Internet
or your local network only as the project's network switches allow (macOS).

**What stays on your machine.** Conversations, plans, the manager's private notes,
task evidence, checkpoints and the connection settings, in the folders listed under
[remove](#remove). The application token is stored in an owner-only file, not
encrypted.

## Status and support

| Component | Platform | Status |
|---|---|---|
| Desktop app and terminal client | macOS, Apple silicon | Developer preview: ad-hoc signed, not notarized |
| Desktop app and terminal client | Linux x86_64 | Preview: builds and starts in CI; command containment and network switches are not enforced (see [SECURITY.md](SECURITY.md)) |
| Autopilot | macOS with [Colima](https://github.com/abiosoft/colima) | Preview |
| Windows | | Not supported |

It is tested with Poundlock 0.3.0 (API 1, contract revision 5). The connection test
refuses a controller older than contract revision 3, or one missing a feature it
needs, and says what to upgrade; see [ECOSYSTEM.md](ECOSYSTEM.md). Fixes go into the latest release only. Issues and
pull requests are welcome; security reports go through [SECURITY.md](SECURITY.md).
What comes next is in the [roadmap](https://github.com/endthestart/poundlock/blob/main/ROADMAP.md).

## Install

[docs/INSTALL.md](docs/INSTALL.md) covers the app, the `dispatch` command, Autopilot's
VM, upgrades, rollback and removal. In short: unzip the release's
`Poundlock.Dispatch-<version>-arm64-mac.zip`, move the app to Applications and open
it once with Control-click → **Open**. Do not turn Gatekeeper off. The terminal client
needs Node.js 22.19.0 or newer and installs from a checkout of the release tag with
`scripts/install-tui.sh`.

To build from source: `npm ci`, `npm test`, then `npm run package:dir`; the app is in
`release/mac-arm64/`.

## First project

1. In Poundlock **Access**, create an application token with **List available
   models** and **Send inference requests**; add the three job permissions only for
   the `dispatch jobs` commands. Add **Allow prompts and files to leave the
   controlled network** only if Dispatch may use External profiles.
2. Open Dispatch, enter the controller address and the token, and **Test
   connection**. Choose a **Manager** and a **Worker** model; the same profile can
   fill both.
3. Add a project: a folder, or a Git repository at a branch or commit.
4. Describe the change. The manager asks what it needs, then proposes a plan, which
   waits for **Approve and start**. Workers edit the folder; checks run; the manager
   reviews each task.
5. Review the changes before you keep them. A green check, the manager's verdict and
   your acceptance are different evidence.

The [user guide](docs/USER-GUIDE.md) covers conversations, the plan, compaction,
the model ladder and Autopilot. The terminal client (`dispatch` in a folder, `/` for
commands) runs the same manager and workers.

## Permissions and containment

Settings → Permissions chooses **Ask for approval**, **Approve for me** or **Full
access**. On macOS, Approve for me runs structured commands inside a qualified
`sandbox-exec` profile limited to the project, with secrets denied and a minimal
environment, and asks when the sandbox cannot be qualified. Ask runs an exactly
displayed command after you consent, with your account's authority. Full access
runs commands with your account's authority and is not isolation. Each project's
**Internet** (on) and **Local network** (off) switches bind every command in every
mode on macOS. A container, a VM and the macOS sandbox are different boundaries;
none of them stops a networked tool from acting on accounts it can reach.
[SECURITY.md](SECURITY.md) gives the exact boundaries and known limits.

## Troubleshooting

| What you see | What to do |
|---|---|
| Could not reach the address | Check that Poundlock is running and the host and port match. |
| Could not verify the TLS certificate | Install the certificate authority in the operating system's trust store; Dispatch uses the system's. |
| Token rejected (401) | Create a new application token in Access; a revoked one cannot be restored. |
| Missing permissions | Grant the token the listed permissions in Access. |
| This controller is too old | Upgrade Poundlock to the version [ECOSYSTEM.md](ECOSYSTEM.md) names. |
| Model is busy | That machine's model slot is in use. Wait, or bind a free profile. |
| Waiting for a model | Poundlock may be waking a machine and loading the model. A preparation failure is reported, not silently retried. |
| Destination unknown | Declare the profile's destination in Poundlock, or set it under Settings → Models and routing. A model or gateway name does not say where inference runs. |
| Autopilot will not start | It says why: usually the terminal client is missing or a different version, or the VM is not running. See [docs/INSTALL.md](docs/INSTALL.md). |

## Remove

Quit the app, delete it, and remove the command with `rm ~/.local/bin/dispatch` and
`rm -rf ~/.local/share/poundlock-dispatch`. Data you can keep or delete:

- `~/Library/Application Support/Poundlock Dispatch`: the app's projects,
  conversations and manager notes;
- `~/.poundlock-dispatch`: the terminal client's projects and Autopilot runs;
- `~/.config/poundlock/dispatch/`: the controller address, the application token
  and shared defaults. Deleting it signs both clients out.

None of this touches your project folders or jobs on Poundlock.

## Development

```sh
npm ci
npm run lint && npm run typecheck && npm test
npm run dev                                   # the desktop app
POUNDLOCK_DISPATCH_FAKE_MANAGER=1 npm run dev # a scripted manager, no model
npm run tui -- <folder>                       # the terminal client
```

Decisions are in [docs/adr/](docs/adr/); [ADR 016](docs/adr/016-autopilot-goal-engine.md)
describes the current execution paths. Domain logic is in `src/core/` and tests run
without Electron. [CONTRIBUTING.md](CONTRIBUTING.md) covers checks, packaging and
contribution terms. [HISTORY.md](HISTORY.md) says where the code came from.

Licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE) and
[third-party notices](THIRD_PARTY_NOTICES.md).
