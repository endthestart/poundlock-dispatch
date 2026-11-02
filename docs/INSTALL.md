# Install, upgrade and remove

Poundlock Dispatch comes in two parts that share one connection and one set of
defaults: the desktop app, and the terminal client, installed as the `dispatch`
command. Install either or both.

## What you need

- A Mac with Apple silicon. The app is built for arm64 macOS; a Linux x86_64
  archive is a preview with weaker containment (see [SECURITY.md](../SECURITY.md)).
- Git.
- Node.js 22.19.0 or newer, for the `dispatch` command only (`brew install node`).
- A Poundlock 0.3.0 controller and an **application token** from its **Access**
  page with **List available models** and **Send inference requests**. The `dispatch
  jobs` commands also need **Read its own jobs and results**, **Submit jobs with
  supplied files** and **Cancel its own jobs**. Add **Send prompts and files to
  external services** only if Dispatch may use external models.

## The desktop app

1. Download `Poundlock.Dispatch-<version>-arm64-mac.zip` and `SHA256SUMS` from the
   release and check the archive: `shasum -a 256 -c SHA256SUMS --ignore-missing`.
2. Unzip it and drag **Poundlock Dispatch.app** into **Applications**.
3. Open it once with Control-click → **Open**. This developer preview is signed ad
   hoc, not notarized, so macOS asks the first time. If it still refuses, approve
   this one app with **Open Anyway** under **System Settings → Privacy & Security**.
   Do not turn Gatekeeper off.

On first start it asks for the controller address and the application token, then
for the models to use as Manager and Worker. Both clients read these from
`~/.config/poundlock/dispatch/`, so the terminal client is connected too.

## The `dispatch` command

From a checkout of the release tag:

```sh
git checkout v<version>
npm ci
scripts/install-tui.sh
```

This puts the client in `~/.local/share/poundlock-dispatch/tui/` and the `dispatch`
command in `~/.local/bin`. If that folder is not on your `PATH`, add it; in fish:

```sh
fish_add_path ~/.local/bin
```

Then `dispatch` in a project folder opens it, `dispatch --help` lists the commands,
and `dispatch --version` names the build. `--bin DIR` installs the command
elsewhere and `--node PATH` picks a different Node; the desktop app finds the client
for Autopilot either way.

Tab completion for its commands, once per shell:

```sh
dispatch completion fish > ~/.config/fish/completions/dispatch.fish
dispatch completion zsh > ~/.dispatch-completion.zsh    # and add: source ~/.dispatch-completion.zsh to ~/.zshrc
dispatch completion bash > ~/.local/share/bash-completion/completions/dispatch
```

## Autopilot's VM (optional, preview)

Autopilot, started from the app or with `dispatch autopilot`, runs unattended work in
a container on a VM that can see only its own folder. The app starts it through the
`dispatch` command in `~/.local/bin`, so install that command first, from the same
release as the app; Autopilot refuses to start and says so when the command is
missing or a different version. It needs [colima](https://github.com/abiosoft/colima)
(`brew install colima docker`), then once:

```sh
mkdir -p ~/.poundlock-dispatch/auto
colima start --profile dispatch-auto --cpu 4 --memory 8 --mount ~/.poundlock-dispatch/auto:w
```

Then apply the VM firewall that keeps its containers from reaching your Mac or your
network. Autopilot refuses to give setup the network until it is in place, and
prints the exact command when it is not; the same command is in
[ADR 014](adr/014-local-auto-mode.md). Load the toolchain image the project needs into
that VM, for example `docker --context colima-dispatch-auto pull python:3.14-slim`.
`colima start` also makes `dispatch-auto` the current Docker context; switch back
with `docker context use colima` if you use Docker for other things.

Autopilot freezes the tests it accepts. When a task fails only on tests frozen earlier in the run, the Planner may let later
tasks change those tests, giving a reason; each allowance is recorded in the run's
ledger (`frozen_allowed`) but not yet shown in the morning report. Check the ledger before you merge a run
that changed tests.

## Upgrade

1. Let running work finish, or pause it. Quit the app.
2. Replace **Poundlock Dispatch.app** in Applications with the new one.
3. For the `dispatch` command, check out the new tag and run
   `scripts/install-tui.sh` again.

Projects, conversations, history and the connection stay where they are. Upgrade
Poundlock first when a release says so; Dispatch names the controller it needs in
`compat/poundlock.json` and says so when it is connected to an older one.

**To 0.3.0:** Dispatch no longer turns its tasks into Poundlock jobs; a task an
earlier version routed to a job runs on this Mac when you resume. `dispatch jobs`
for manual jobs is unchanged. See [CHANGELOG.md](../CHANGELOG.md).

## Roll back

Put the previous release's app back in Applications. For the command,
`scripts/install-tui.sh --rollback` returns to the version installed before. Keep a
copy of the data folders below before an upgrade: an older release ignores
settings it does not know, but a project an upgrade migrated does not migrate back.

## Remove

Quit the app and delete it from Applications. Remove the command with
`rm ~/.local/bin/dispatch` and `rm -rf ~/.local/share/poundlock-dispatch`. Your data
is in three places, which you can keep or delete:

- `~/Library/Application Support/Poundlock Dispatch`: projects, conversations and
  manager notes, shared by the app and the `dispatch` command;
- `~/.poundlock-dispatch/auto`: Autopilot's runs;
- `~/.config/poundlock/dispatch/`: the controller address, the application token and
  shared defaults. Deleting it signs both clients out.

None of this touches your project folders or the jobs on Poundlock. To delete the
Autopilot VM: `colima delete --profile dispatch-auto`.
