#!/usr/bin/env bash
# Build the extensions.gnome.org zip. Extra JS modules are not packed unless
# listed; schemas/, prefs.js, stylesheet.css and metadata.json are automatic.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/vscreens@florianbolli.ch"
ZIP="vscreens@florianbolli.ch.shell-extension.zip"

gnome-extensions pack \
    --force \
    --extra-source=spaces.js \
    --extra-source=indicator.js \
    --extra-source=switcher.js \
    --extra-source=thumbnails.js \
    --out-dir="$ROOT" \
    "$SRC"

echo "Created $ROOT/$ZIP"
echo "Install: gnome-extensions install --force \"$ROOT/$ZIP\""
echo "Upload that same file at https://extensions.gnome.org/upload/"
