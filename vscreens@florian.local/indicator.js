import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {createSpaceThumbnail} from './thumbnails.js';

const THUMB_WIDTH = 150;

/**
 * One row of dots per monitor, laid out left to right in the same order as the
 * physical monitors, so the panel mirrors what is actually in front of you.
 * Opening it reveals a live preview of every space on every monitor.
 */
export const SpaceIndicator = GObject.registerClass(
class SpaceIndicator extends PanelMenu.Button {
    _init(spaceManager) {
        super._init(0.0, 'VScreens');

        this._spaceManager = spaceManager;
        this._backgroundManagers = [];

        this._box = new St.BoxLayout({
            style_class: 'vscreens-indicator',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);

        this._previews = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._previews);

        // Previews clone live window actors and pull in wallpapers, so build them
        // on demand and tear them down on close rather than holding them open.
        // Re-syncing on open also refreshes the dots, so the active-monitor
        // highlight is accurate at the moment you actually look at it.
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this.sync();
            else
                this._clearPreviews();
        });

        this.sync();
    }

    sync() {
        this._box.destroy_all_children();

        const states = this._spaceManager.monitorStates;
        const activeMonitor = this._spaceManager.activeMonitor();

        states.forEach((state, position) => {
            if (position > 0) {
                this._box.add_child(new St.Widget({
                    style_class: 'vscreens-separator',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            const group = new St.BoxLayout({
                style_class: state.monitorIndex === activeMonitor
                    ? 'vscreens-monitor vscreens-monitor-active'
                    : 'vscreens-monitor',
                y_align: Clutter.ActorAlign.CENTER,
            });

            for (let i = 0; i < state.nSpaces; i++) {
                group.add_child(new St.Widget({
                    style_class: i === state.current
                        ? 'vscreens-dot vscreens-dot-active'
                        : 'vscreens-dot',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            this._box.add_child(group);
        });

        if (this.menu.isOpen)
            this._buildPreviews();
    }

    // ----------------------------------------------------------------- previews

    _clearPreviews() {
        for (const manager of this._backgroundManagers)
            manager.destroy();
        this._backgroundManagers = [];
        this._previews.removeAll();
    }

    _buildPreviews() {
        this._clearPreviews();

        for (const state of this._spaceManager.monitorStates) {
            const monitor = Main.layoutManager.monitors[state.monitorIndex];
            if (!monitor)
                continue;

            const heading = new PopupMenu.PopupMenuItem(
                this._monitorLabel(state.monitorIndex), {reactive: false});
            heading.label.add_style_class_name('vscreens-heading');
            this._previews.addMenuItem(heading);

            const row = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'vscreens-preview-item',
            });
            const rowBox = new St.BoxLayout({style_class: 'vscreens-preview-row'});
            row.add_child(rowBox);

            for (let i = 0; i < state.nSpaces; i++)
                rowBox.add_child(this._makeThumbnail(state, monitor, i));

            this._previews.addMenuItem(row);
        }
    }

    _monitorLabel(monitorIndex) {
        // Name screens by physical left-to-right order, which is how someone
        // actually thinks about them, not by mutter's index.
        const ordered = [...Main.layoutManager.monitors].sort((a, b) => a.x - b.x);
        const position = ordered.findIndex(m => m.index === monitorIndex);
        const name = position >= 0 ? `Screen ${position + 1}` : `Monitor ${monitorIndex}`;
        return monitorIndex === Main.layoutManager.primaryIndex ? `${name} (primary)` : name;
    }

    /** A clickable preview of one space, which jumps that screen to it. */
    _makeThumbnail(state, monitor, spaceIndex) {
        const button = new St.Button({
            style_class: spaceIndex === state.current
                ? 'vscreens-thumb-button vscreens-thumb-current'
                : 'vscreens-thumb-button',
            can_focus: true,
        });

        const wrapper = new St.BoxLayout({vertical: true});
        button.set_child(wrapper);

        const thumb = createSpaceThumbnail(
            this._spaceManager, state.monitorIndex, spaceIndex,
            THUMB_WIDTH, this._backgroundManagers);
        if (thumb)
            wrapper.add_child(thumb);
        wrapper.add_child(new St.Label({
            text: `${spaceIndex + 1}`,
            style_class: 'vscreens-thumb-label',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        button.connect('clicked', () => {
            this.menu.close();
            this._spaceManager.switchTo(state.monitorIndex, spaceIndex,
                spaceIndex >= state.current ? 1 : -1);
        });

        return button;
    }

    _onDestroy() {
        this._clearPreviews();
        super._onDestroy();
    }
});
