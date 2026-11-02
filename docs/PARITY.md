# Client parity

Where each user-facing feature stands in the desktop app (GUI), the terminal client (TUI,
`dispatch` in a folder) and the shell commands (CLI: `dispatch --json`, `dispatch autopilot …`,
`dispatch jobs …`). Read from the code on 2 November 2026. **done** works as in the GUI;
**partial** works with a named gap; **missing** is absent; **n/a** is outside that client's job
by design.

GUI paths are under `src/renderer/` unless named; TUI and CLI paths are under `src/tui/`.

**How far this is checked.** "done" means the code and its tests, not a person using every row.
Driven in a real terminal against Poundlock on 29 October: `/models`, a manager conversation, a
small action with its approval cards, a guided Autopilot start, its progress, details and ended
state, `/autopilot merge`, a live theme change, and closing the terminal window. Driven against a
fixture controller on 30 October: first-run `/role`, `/models` at 60 columns, `jobs probe`,
Autopilot's errors and `status`. `dispatch completion` was run in fish; its zsh script was only
syntax-checked and bash only by test. The client's split into smaller modules (`app-*.ts`, 30
October) came after the live session: since then its tests pass and `/help` and `/models` were
driven, but no model turn or Autopilot run has gone through it, and none can until home compute
is allowed again.

## Since 26 October

| Feature | GUI | TUI | CLI | Where, and the gap |
|---|---|---|---|---|
| Autopilot run card: standing, summary, time and spend meters, verdict per requirement, Now, Needs you, Built | done | done | done | `autopilot-card.tsx`; TUI `app-autopilot.ts` via `autopilotCardLines`; CLI `autopilot status`/`watch` lead with the card (`auto-card.ts`) for the folder's newest run |
| Why a run stopped short (`card.why`) | done | done | done | `autopilot-card.tsx` under the head; TUI card and CLI `status`/`watch` print `Why it stopped: …` through the shared `autopilotCardLines` |
| Run card Details: branch, Planner, per-task stages | done | done | done | `autopilot.tsx`; TUI `/autopilot details`, CLI `status`/`watch` under the card (`auto-details.ts`) |
| Message Autopilot, and answer a run waiting for you | done | done | done | All follow shared `autopilotTakesMessages`: while a run holds the project, or it ended waiting for your answer. GUI composer (`App.tsx`). TUI composer hint and `/autopilot message <words>`, through host `sendMessage`. CLI `autopilot message --text` |
| Last 7 days spend meter | done | done | done | `autopilot-card.tsx`; TUI card line `Last 7 days $x`; CLI the same line, when the folder is a Dispatch project |
| Transcript density: Normal / Verbose | done | done | n/a | `transcript-density.tsx`; TUI `/transcript [normal\|verbose]`, remembered in `tui-preferences.json` in the data folder, both through `conversationTimeline` (shared). Normal folds a reply's steps into one line of names and says how many earlier updates it hides |
| Local fallback role setting | done | done | n/a | Settings → Local fallback; TUI `/role fallback <profile>` (own-network check shared) |
| Local fallback: notice in the conversation | done | done | n/a | system message from core `orchestration.ts`, rendered by both |
| Local fallback: manager line names the fallback | done | done | n/a | `App.tsx`; TUI status line `mgr <name> (local fallback after a spending limit)`, also project override and model ladder, from `managerChoice` and `managerSelection` |
| Local fallback: run card and run lines | done | done | done | shared `autopilotCard` Needs you; CLI via `auto-run.ts` lines |
| Alert when a run stops building or moves to the fallback | done | done | n/a | `notifyAutopilot` facility (`main/index.ts`); TUI `alerts.ts`: a bell and the notice `Autopilot · <state>: <project>` |
| Autopilot state in the title (`Building 3/10 · on local fallback`) | done | done | n/a | `App.tsx` from `autopilotGlances`; TUI `renderTitleBar`, same rule: interactive work outranks the run |
| Model cards | n/a | n/a | n/a | A Poundlock console feature (`ux/console-2026-10`), not Dispatch. Dispatch's model detail is the role page block (`settings.tsx`): destination, transport, served model and price; TUI `/models <profile>` says the same |

## Autopilot

| Feature | GUI | TUI | CLI | Where, and the gap |
|---|---|---|---|---|
| Start a run | done | done | done | shared `autopilotStartPreview`; TUI `/autopilot start` asks the dialog's questions and starts through the host (approve and build, suggested checks, milestones, Planner consent). CLI `start` flags cover the same options (`--checkpoint`, `--accept-already-met`, `--allow-planner`); a pending plan is approved in the app or the TUI |
| Stop after this task / Stop now | done | done | done | `/autopilot stop [--now]` |
| Resume | done | partial | done | `autopilotResumable`. TUI `/autopilot resume` works for every resumable run and the composer says to resume, but the card's line of commands names it only while a run is interrupted, not once it has ended short or is waiting for you |
| Export patch | done | done | done | |
| Merge into folder (preview, then fast-forward) | done | done | done | `autopilot.tsx`; CLI `autopilot merge [--yes]` previews, merges only with `--yes` (`auto-merge.ts`); TUI `/autopilot merge` confirms the preview in a picker |
| Open report | done | done | done | GUI opens `report.md`; CLI `autopilot report` and TUI `/autopilot report` print its path |
| Drop run | done | done | done | `/autopilot drop` |
| Clean up runs (sizes, choose) | done | done | done | CLI `clean` lists sizes, biggest first; `drop <run>` picks one, `clean --all` drops all (the app's `cleanupAutopilot` uses the same `dropRun`) |
| List runs | n/a | done | done | `autopilot list` |
| Board during a run: task stages and milestone groups | done | done | n/a | shared `autopilotBoard`; TUI `/board` (`board-run.ts`) |
| Menu bar tray of building runs | done | n/a | n/a | `main/index.ts` |
| Planner evaluation (`eval-planner`) | n/a | n/a | done | developer command |

## Conversation and run

| Feature | GUI | TUI | CLI | Where, and the gap |
|---|---|---|---|---|
| Send, reply, choose an offered answer | done | done | n/a | |
| Streaming draft, activity line | done | done | n/a | |
| Message headers: speaker, time, reasoning tag | done | done | n/a | TUI: time and reasoning over each message; the speaker is the layout (`message-head.ts`) |
| Approve plan / proposed plan card | done | done | n/a | `/approve` |
| Pause, Resume, Cancel, Retry, Override, Review again | done | done | n/a | `/pause` `/resume` `/cancel` `/retry` `/override` `/reopen` |
| Approvals: once, remember, deny | done | done | n/a | TUI card, keys a/s/d |
| Context chip and Compact | done | done | n/a | `/compact`, status-line infolets |
| Budget chip | done | done | n/a | status-line infolets |
| Plan details and task board | done | done | n/a | `/board` |
| Task evidence: attempts, check output, diff, worker report, snapshots | done | done | n/a | TUI `/task <number> [attempt]`; snapshots are named, not shown (images) |
| New conversation | done | done | n/a | Project menu; TUI `/new`, confirmed in a picker (`lifecycle.ts`, shared `projectMenuActions`) |
| Start a new run | done | done | n/a | TUI `/new-run` |
| History | done | done | n/a | `runHistory`; TUI `/history` screen (`history.ts`) |
| Archive / restore / remove project | done | done | n/a | `projectLifecycle`; TUI `/archive`, `/remove` close the screen; opening an archived folder offers to restore it |
| Watching banner (another client drives) | done | done | n/a | |
| Needs-you alert | done | done | n/a | GUI notification and badge; TUI bell |
| Project state as JSON | n/a | n/a | done | `dispatch --json` |
| List the commands | n/a | done | done | TUI `/help`, or `/` to complete one; CLI `--help` |
| Shell completion | n/a | n/a | done | `dispatch completion <fish\|zsh\|bash>` (`completion.ts`) |

## Projects

| Feature | GUI | TUI | CLI | Where, and the gap |
|---|---|---|---|---|
| Open a folder project | done | done | done | `dispatch [folder]` |
| Git repository project (URL, branch, access) | done | done | done | Add project dialog `App.tsx`; `dispatch --git <url> --branch <ref> [--account …]` clones once, then reopens (`open-git.ts`) |
| Project list and switching | done | n/a | n/a | the TUI is one folder per process |

## Project settings

| Feature | GUI | TUI | CLI | Where, and the gap |
|---|---|---|---|---|
| Worker permissions (trust) | done | done | n/a | `/trust` |
| Internet / Local network | done | done | n/a | `/network` |
| Web search for the manager and Planner | done | done | n/a | `project-settings.tsx`; TUI `/websearch [on\|off]` (`web-search.ts`), Internet required |
| Other folders, read or write | done | done | n/a | `/grant`, `/revoke` |
| Read exception for one excluded file | done | done | n/a | `grantReadFile`; TUI `/grant-file <path>`, `/revoke-file <path>`, listed in `/setup` |
| Manager and Worker override for this project | done | done | n/a | TUI `/project-model [manager\|worker] [profile\|default]` (`project-model.ts`); `/role` sets app defaults |
| Manager reasoning for this conversation | done | done | n/a | `/reasoning` |
| Verification commands (checks) | done | done | n/a | `project-settings.tsx`; TUI `/checks [add\|remove\|clear]` (`checks.ts`) |
| Fix rounds per task | done | done | n/a | TUI `/fix-rounds [0-5\|default]` (`fix-rounds.ts`) |
| Mutation check | done | done | n/a | `project-settings.tsx`; TUI `/checks mutation [on\|off]` |
| Node runtime | done | done | n/a | `setProjectRuntime`; TUI `/runtime` offers the detected versions |
| Repository access account | done | done | n/a | `attachForge`; TUI `/repo-account` |

## App settings and models

| Feature | GUI | TUI | CLI | Where, and the gap |
|---|---|---|---|---|
| Connection: address, token, test | done | done | n/a | `/connect`, `/setup` |
| Server information: status, profiles, last updated, gateway identity | done | partial | n/a | `settings.tsx`. TUI `/setup` gives status and version and `/models` the profiles; last updated and gateway identity are not shown |
| First-run wizard | done | done | n/a | TUI: the connect prompt opens on an unconnected start, then pickers choose the Manager and the Worker that are unset. `/role` holds the first of the two in this client until the other is chosen, then saves both, so quitting between them loses the first |
| Role models: Manager, Worker, Verifier, Local fallback, Autocomplete | done | done | n/a | `/role`, `/models`; the terminal's names are `manager`, `worker`, `verifier`, `fallback`, `snippet`, plus `escalation` |
| Model detail: served model, price, transport, thinking | done | done | n/a | `settings.tsx`; TUI `/models <profile>` (`model-detail.ts`) |
| Reported destination override per profile | done | done | n/a | `saveProfile`; TUI `/models <profile> destination <own\|external\|reported>` |
| Approve a changed route | done | done | n/a | `/approve-models` |
| Model ladder (escalation) | done | done | n/a | `escalation-settings.tsx`; TUI `/ladder` |
| Manager on this computer | done | done | n/a | `saveLocalManager`; TUI `/local-manager` tests before it saves |
| Web search engine address | done | done | n/a | `saveWebSearch`; TUI `/websearch engine <address\|none>` |
| App default permissions, approval reviewer, saved exact actions | done | done | n/a | `settings.tsx`; TUI `/permissions` |
| GitHub / Gitea accounts | done | done | n/a | `settings.tsx`; TUI `/accounts` |
| Theme | done | done | n/a | shared `appearance.json`; TUI `/appearance theme`, applied at once |
| Notifications and composer chips | done | done | n/a | `saveUiPreferences`; TUI `/appearance notify`, `chip`; the bell is on by default |
| Poundlock jobs by hand | n/a | n/a | done | `dispatch jobs`; removed from the GUI on purpose (ADR 016) |

## Known gaps

Two partial rows above: the Autopilot card's line of commands for an ended run, and server
information. Neither blocks anything; there is another way to do or read each. No porting is
planned while the project closes out. A port that needs `src/core`, `src/runtime`, `src/main`,
`src/renderer` or `src/shared` belongs to whoever owns those.
