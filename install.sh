#!/usr/bin/env bash
# Install VScreens into the user extensions directory and compile its schema.
# After running this, restart GNOME Shell with Alt+F2 then "r" (X11 only).
set -euo pipefail

UUID="vscreens@florian.local"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

glib-compile-schemas "$SRC/schemas"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/." "$DEST/"

# Register it so it comes up enabled on the next shell restart, since a running
# shell will not notice a brand new extension directory.
python3 - "$UUID" <<'PY'
import ast, subprocess, sys

uuid = sys.argv[1]
raw = subprocess.check_output(
    ["gsettings", "get", "org.gnome.shell", "enabled-extensions"], text=True).strip()
enabled = ast.literal_eval(raw) if raw not in ("@as []", "") else []
if uuid not in enabled:
    enabled.append(uuid)
    value = "[" + ", ".join(f"'{e}'" for e in enabled) + "]"
    subprocess.check_call(
        ["gsettings", "set", "org.gnome.shell", "enabled-extensions", value])
PY

echo "Installed to $DEST"
echo "Now press Alt+F2, type r, press Enter."
