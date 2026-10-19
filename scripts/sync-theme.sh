#!/usr/bin/env bash
# Vendors the Poundlock Catppuccin theme and fonts from the sibling ../poundlock
# checkout into this repository. Poundlock owns the source; this repo copies it
# unchanged and checks it in, so the desktop app and TUI build without that
# checkout present. Re-run after Poundlock regenerates web/theme.css or
# docs/design/theme.json.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
poundlock_root="$(cd "$repo_root/../poundlock" && pwd)"

src_theme_css="$poundlock_root/web/theme.css"
src_theme_json="$poundlock_root/docs/design/theme.json"
src_fonts_dir="$poundlock_root/web/fonts"

dst_theme_css="$repo_root/src/renderer/theme.css"
dst_theme_json="$repo_root/src/shared/theme.json"
dst_fonts_dir="$repo_root/src/renderer/fonts"

for f in "$src_theme_css" "$src_theme_json" "$src_fonts_dir/inter.woff2" "$src_fonts_dir/jetbrains-mono.woff2" \
  "$src_fonts_dir/INTER-LICENSE" "$src_fonts_dir/JETBRAINS-MONO-LICENSE"; do
  if [ ! -f "$f" ]; then
    echo "sync-theme: missing source file $f (is ../poundlock checked out beside this repo?)" >&2
    exit 1
  fi
done

mkdir -p "$dst_fonts_dir"
cp "$src_theme_css" "$dst_theme_css"
cp "$src_theme_json" "$dst_theme_json"
cp "$src_fonts_dir/inter.woff2" "$dst_fonts_dir/inter.woff2"
cp "$src_fonts_dir/jetbrains-mono.woff2" "$dst_fonts_dir/jetbrains-mono.woff2"
cp "$src_fonts_dir/INTER-LICENSE" "$dst_fonts_dir/INTER-LICENSE"
cp "$src_fonts_dir/JETBRAINS-MONO-LICENSE" "$dst_fonts_dir/JETBRAINS-MONO-LICENSE"

echo "sync-theme: copied theme.css, theme.json and fonts from $poundlock_root"
