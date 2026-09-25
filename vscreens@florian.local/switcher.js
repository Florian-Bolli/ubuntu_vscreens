import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {createSpaceThumbnail} from './thumbnails.js';

const HIDE_TIMEOUT = 1400;
const FADE_TIME = 120;

const WIDTH_NORMAL = 132;
const WIDTH_SELECTED = 180;

/**
 * Transient overlay showing every space on one monitor, with the current one
 * enlarged. Constrained to its own monitor so it appears on the screen that
 * actually switched, which is the whole point of it existing.
 */
export const SpaceSwitcherPopup = GObject.registerClass(
class SpaceSwitcherPopup extends Clutter.Actor {
    _init(monitorIndex, spaceManager) {
        super._init({
            // BinLayout so the card honours its own centring inside the monitor.
            layout_manager: new Clutter.BinLayout(),
            opacity: 0,
            visible: false,
        });

        this._monitorIndex = monitorIndex;
        this._spaceManager = spaceManager;
        this._backgroundManagers = [];
        this._hideTimeoutId = 0;

        this.add_constraint(new Layout.MonitorConstraint({index: monitorIndex}));

        this._card = new St.BoxLayout({
            vertical: true,
            style_class: 'vscreens-switcher',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._card);

        this._label = new St.Label({
            style_class: 'vscreens-switcher-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._card.add_child(this._label);

        this._row = new St.BoxLayout({
            style_class: 'vscreens-switcher-row',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._card.add_child(this._row);

        this.connect('destroy', this._onDestroy.bind(this));
        Main.uiGroup.add_child(this);
    }

    /**
     * Named showSpace rather than show, because Clutter.Actor.show already exists
     * and the shell calls it internally.
     */
    showSpace(spaceIndex, nSpaces) {
        this._rebuild(spaceIndex, nSpaces);

        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }

        if (!this.visible) {
            this.visible = true;
            this.opacity = 0;
            this.ease({
                opacity: 255,
                duration: FADE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._hideTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, HIDE_TIMEOUT, () => {
                this._hideTimeoutId = 0;
                this._fadeOut();
                return GLib.SOURCE_REMOVE;
            });
    }

    _rebuild(spaceIndex, nSpaces) {
        this._clearContents();

        this._label.text = `${spaceIndex + 1} / ${nSpaces}`;

        for (let i = 0; i < nSpaces; i++) {
            const selected = i === spaceIndex;

            const item = new St.BoxLayout({
                vertical: true,
                style_class: selected
                    ? 'vscreens-switcher-item vscreens-switcher-item-selected'
                    : 'vscreens-switcher-item',
                y_align: Clutter.ActorAlign.CENTER,
            });

            const thumb = createSpaceThumbnail(
                this._spaceManager, this._monitorIndex, i,
                selected ? WIDTH_SELECTED : WIDTH_NORMAL,
                this._backgroundManagers);
            if (thumb)
                item.add_child(thumb);

            item.add_child(new St.Label({
                text: `${i + 1}`,
                style_class: 'vscreens-switcher-number',
                x_align: Clutter.ActorAlign.CENTER,
            }));

            this._row.add_child(item);
        }
    }

    _clearContents() {
        for (const manager of this._backgroundManagers)
            manager.destroy();
        this._backgroundManagers = [];
        this._row.destroy_all_children();
    }

    _fadeOut() {
        this.ease({
            opacity: 0,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.visible = false;
                // Drop the wallpapers and clones while hidden; they are rebuilt
                // on the next switch anyway and the content would be stale.
                this._clearContents();
            },
        });
    }

    _onDestroy() {
        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
        this._clearContents();
    }
});
