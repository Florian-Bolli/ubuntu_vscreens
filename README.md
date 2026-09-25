# VScreens

Independent virtual desktops per monitor on Ubuntu / GNOME, in the style of macOS Spaces.

GNOME only offers two native workspace modes: switch on the primary monitor only, or switch every monitor together. VScreens gives each screen its own set of spaces that you can add, remove, and switch without moving the other screens.

Tested on **Ubuntu 24.04** with **GNOME Shell 46** on **X11**.

## Requirements

- GNOME Shell 46
- A multi-monitor setup (it works with one screen, but the point is per-monitor spaces)
- `glib-compile-schemas` (from `libglib2.0-bin`, already present on Ubuntu)

On X11 you can reload the extension with `Alt+F2`, `r`, Enter. On Wayland you have to log out and back in after install.

## Install

```bash
git clone https://github.com/Florian-Bolli/ubuntu_vscreens.git
cd ubuntu_vscreens
./install.sh
```

Then reload GNOME Shell:

- **X11:** `Alt+F2`, type `r`, press Enter
- **Wayland:** log out and log back in

`install.sh` compiles the settings schema, copies the extension to `~/.local/share/gnome-shell/extensions/vscreens@florian.local/`, and enables it.

The extension also flips two GNOME settings it needs to work:

- static workspaces (`org.gnome.mutter dynamic-workspaces` → `false`)
- workspaces span displays (`org.gnome.mutter workspaces-only-on-primary` → `false`)

It then creates extra hidden workspaces as parking spots for spaces that are not on screen. You do not interact with those workspaces directly.

## Use

Shortcuts reuse GNOME’s existing workspace keys, but they now act on **one monitor only** — the screen under the mouse.

| Action | Default keys |
| --- | --- |
| Previous space on this screen | `Ctrl+Alt+Left`, `Super+Page Up`, `Super+Alt+Left` (stops at the first space) |
| Next space on this screen | `Ctrl+Alt+Right`, `Super+Page Down`, `Super+Alt+Right` (creates a new space if you are already on the last one) |
| Jump to space 1–9 | GNOME’s `switch-to-workspace-N` bindings (`Super+Home` is space 1 by default) |
| Move focused window to the adjacent space and follow it | `Ctrl+Shift+Alt+Left` / `Right`, `Super+Shift+Page Up` / `Down` |
| Add a space on this screen | `Super+Alt+=` |
| Remove the current space on this screen | `Super+Alt+-` |

When you switch, a popup on **that** screen shows live thumbnails of all of its spaces. The current one is larger and outlined. Hover to keep it open, then click a thumbnail to jump or the **×** to remove that space. Windows on a removed space move onto a neighbour so nothing is lost. The last space on a monitor cannot be removed.

The top-right panel indicator shows one group of dots per monitor, left to right. Click it to open settings. Right-click it for the thumbnail overview of every screen.

## Settings

Open settings from the gear on the panel thumbnail menu, or:

```bash
gnome-extensions prefs vscreens@florian.local
```

All keys live under `org.gnome.shell.extensions.vscreens`. After a first install, read them with:

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/vscreens@florian.local/schemas list-recursively org.gnome.shell.extensions.vscreens
```

Useful ones:

| Key | Default | Meaning |
| --- | --- | --- |
| `thumbnail-size` | `360` | Preview width in pixels (160–600) |
| `collapse-empty-spaces` | `true` | Collapse consecutive empty spaces to one |
| `spaces-per-monitor` | `4` | How many spaces each monitor starts with (1–12). Switching past the last occupied space adds another. |
| `animation-duration` | `250` | Slide duration in milliseconds; `0` disables the slide |
| `active-monitor-mode` | `pointer` | `pointer` = screen under the mouse; `focus` = screen of the focused window |
| `show-osd` | `true` | Show the thumbnail popup when switching |
| `show-indicator` | `true` | Show the panel dots |
| `hide-overview-thumbnails` | `true` | Hide GNOME’s stock workspace strip in Overview (it is meaningless in this model) |
| `add-space` / `remove-space` | `Super+Alt+=` / `Super+Alt+-` | Add or remove a space on the current monitor |

Example:

```bash
SCHEMA=~/.local/share/gnome-shell/extensions/vscreens@florian.local/schemas
gsettings --schemadir "$SCHEMA" set org.gnome.shell.extensions.vscreens spaces-per-monitor 6
gsettings --schemadir "$SCHEMA" set org.gnome.shell.extensions.vscreens animation-duration 180
```

## Update

```bash
cd ubuntu_vscreens
git pull
./install.sh
```

Reload the shell again (`Alt+F2` → `r` on X11, or log out on Wayland).

## Uninstall

```bash
gnome-extensions disable vscreens@florian.local
rm -rf ~/.local/share/gnome-shell/extensions/vscreens@florian.local
```

Reload the shell. Then restore GNOME’s workspace settings if you want the stock behaviour back:

```bash
gsettings set org.gnome.mutter dynamic-workspaces true
gsettings set org.gnome.mutter workspaces-only-on-primary true
gsettings set org.gnome.desktop.wm.preferences num-workspaces 4
```

## How it works

Mutter workspaces are global: a window belongs to one workspace, or to all of them. There is no native per-monitor workspace.

VScreens keeps every visible window on workspace 0 (the “stage”) and parks off-screen spaces on hidden workspaces that are never activated. Switching a monitor parks its current windows and brings the next space onto the stage. The slide uses GNOME’s own `MonitorGroup` animation, built for one monitor only, so the other screens do not move.

## Development

```bash
./install.sh
# then Alt+F2 → r
```

The extension source is `vscreens@florian.local/`. After edits, reinstall and reload.
