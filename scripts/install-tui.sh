#!/usr/bin/env bash
# Install the terminal client as the `dispatch` command, from this checkout.
#
#   scripts/install-tui.sh [--bin DIR] [--node PATH]
#   scripts/install-tui.sh --rollback
#
# Builds the client, installs it with only its production dependencies (from
# package-lock.json) under ~/.local/share/poundlock-dispatch/tui/<version>, points
# `current` at it, and writes DIR/dispatch (default ~/.local/bin) to run it with
# Node 22.19.0 or newer, which Pi 1.1.0 requires. The previous version stays for --rollback. It changes nothing
# else: projects, history and the connection are where the client keeps them.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "install-tui: $*" >&2; exit 1; }
root="$HOME/.local/share/poundlock-dispatch/tui"
bin="$HOME/.local/bin"
node=""
rollback=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bin) bin="$2"; shift 2 ;;
    --node) node="$2"; shift 2 ;;
    --rollback) rollback=1; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

if [ "$rollback" = 1 ]; then
  [ -L "$root/previous" ] || fail "no previous version to roll back to"
  previous=$(readlink "$root/previous")
  ln -sfn "$(readlink "$root/current")" "$root/previous"
  ln -sfn "$previous" "$root/current"
  echo "dispatch now runs $(basename "$previous")"
  exit 0
fi

node="${node:-$(command -v node || true)}"
[ -n "$node" ] && [ -x "$node" ] || fail "Node 22.19.0 or newer not found; pass --node PATH"
case "$node" in /*) ;; *) node="$(cd "$(dirname "$node")" && pwd)/$(basename "$node")" ;; esac
"$node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || fail "$node is $("$node" --version); Pi needs Node 22.19.0 or newer"

version=$("$node" -p 'require("./package.json").version')
commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
target="$root/$version-$commit"
npm run -s tui:build
stage=$(mktemp -d "$root.stage.XXXXXX" 2>/dev/null || { mkdir -p "$root"; mktemp -d "$root.stage.XXXXXX"; })
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/out"
cp -R out/tui "$stage/out/tui"
cp package.json package-lock.json LICENSE NOTICE THIRD_PARTY_NOTICES.md "$stage/"
(cd "$stage" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
# Full license texts for exactly what was installed, fonts and theme included.
node scripts/license-inventory.cjs --texts "$stage/THIRD_PARTY_LICENSES.md" >/dev/null
"$node" "$stage/out/tui/index.js" --version >/dev/null || fail "the installed client does not start"
mkdir -p "$root"
rm -rf "$target"
mv "$stage" "$target"
trap - EXIT
[ -L "$root/current" ] && ln -sfn "$(readlink "$root/current")" "$root/previous"
ln -sfn "$target" "$root/current"
mkdir -p "$bin"
cat > "$bin/dispatch" <<SHIM
#!/bin/sh
# Poundlock Dispatch terminal client; installed by scripts/install-tui.sh.
exec "$node" "$root/current/out/tui/index.js" "\$@"
SHIM
chmod 755 "$bin/dispatch"
echo "Installed dispatch $version ($commit) as $bin/dispatch"
case ":$PATH:" in *":$bin:"*) ;; *) echo "Add $bin to your PATH to run it as dispatch." ;; esac
