import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {createThumbnailWithClose} from './thumbnails.js';

const FADE_IN_MS = 120;
const FADE_OUT_MS = 100;

/**
 * Transient overlay showing every space on one monitor, with the current one
 * enlarged. Constrained to its own monitor so it appears on the screen that
 * actually switched, which is the whole point of it existing.
 */
export const SpaceSwitcherPopup = GObject.registerClass(
class SpaceSwitcherPopup extends Clutter.Actor {
    _init(monitorIndex, spaceManager, settings, openPrefs) {
        super._init({
            // BinLayout so the card honours its own centring inside the monitor.
            layout_manager: new Clutter.BinLayout(),
            opacity: 0,
            visible: false,
        });

        this._monitorIndex = monitorIndex;
        this._spaceManager = spaceManager;
        this._settings = settings;
        this._openPrefs = openPrefs;
        this._hideTimeoutId = 0;
        this._fadingOut = false;

        this.add_constraint(new Layout.MonitorConstraint({index: monitorIndex}));

        this._card = new St.BoxLayout({
            vertical: true,
            style_class: 'vscreens-switcher',
            reactive: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._card);

        // Keep the popup up while the pointer is on it, so the close buttons
        // are actually reachable instead of racing the fade-out.
        this._card.connect('enter-event', () => this._cancelHide());
        this._card.connect('leave-event', () => this._scheduleHide());

        this._header = new St.BoxLayout({
            style_class: 'vscreens-switcher-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._card.add_child(this._header);

        this._label = new St.Label({
            style_class: 'vscreens-switcher-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._header.add_child(this._label);

        const gear = new St.Button({
            style_class: 'vscreens-settings-button',
            can_focus: true,
            child: new St.Icon({
                icon_name: 'preferences-system-symbolic',
                icon_size: 20,
            }),
        });
        gear.connect('clicked', () => {
            this._cancelHide();
            this._openPrefs?.();
        });
        this._header.add_child(gear);

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

        if (!this.visible || this._fadingOut) {
            this._fadingOut = false;
            this.remove_all_transitions();
            this.visible = true;
            this.opacity = 0;
            this.ease({
                opacity: 255,
                duration: FADE_IN_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._scheduleHide();
    }

    _cancelHide() {
        if (this._hideTimeoutId) {
            GLib.source_remove(this._hideTimeoutId);
            this._hideTimeoutId = 0;
        }
    }

    _scheduleHide() {
        this._cancelHide();
        const timeout = this._settings.get_int('switcher-timeout');
        this._hideTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, timeout, () => {
                this._hideTimeoutId = 0;
                this._fadeOut();
                return GLib.SOURCE_REMOVE;
            });
    }

    _normalWidth() {
        return this._settings.get_int('thumbnail-size');
    }

    _selectedWidth() {
        return Math.round(this._normalWidth() * 1.22);
    }

    _rebuild(spaceIndex, nSpaces) {
        this._clearContents();

        this._label.text = `${spaceIndex + 1} / ${nSpaces}`;

        for (let i = 0; i < nSpaces; i++) {
            const selected = i === spaceIndex;

            const item = new St.BoxLayout({
                vertical: true,
                reactive: true,
                track_hover: true,
                style_class: selected
                    ? 'vscreens-switcher-item vscreens-switcher-item-selected'
                    : 'vscreens-switcher-item',
                y_align: Clutter.ActorAlign.CENTER,
            });

            const jumpTo = () => {
                if (i !== this._spaceManager.currentSpace(this._monitorIndex)) {
                    this._spaceManager.switchTo(this._monitorIndex, i,
                        i >= spaceIndex ? 1 : -1);
                }
                this._dismiss();
            };

            const thumb = createThumbnailWithClose(
                this._spaceManager, this._monitorIndex, i,
                selected ? this._selectedWidth() : this._normalWidth(), {
                    selected,
                    onSelect: jumpTo,
                    onRemove: () => {
                        if (!this._spaceManager.removeSpace(this._monitorIndex, i))
                            return;
                        const state = this._spaceManager.monitorStates
                            .find(s => s.monitorIndex === this._monitorIndex);
                        if (state)
                            this.showSpace(state.current, state.nSpaces);
                    },
                });
            item.add_child(thumb);

            const number = new St.Button({
                style_class: 'vscreens-switcher-number',
                child: new St.Label({
                    text: `${i + 1}`,
                    x_align: Clutter.ActorAlign.CENTER,
                }),
            });
            number.connect('clicked', jumpTo);
            item.add_child(number);

            item.connect('button-press-event', (_actor, event) => {
                if (event.get_button() === 1) {
                    jumpTo();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._row.add_child(item);
        }
    }

    _clearContents() {
        this._row.destroy_all_children();
    }

    _dismiss() {
        this._cancelHide();
        this._fadeOut();
    }

    _fadeOut() {
        if (!this.visible || this._fadingOut)
            return;

        this._fadingOut = true;
        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            duration: FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (!this._fadingOut)
                    return;
                this._fadingOut = false;
                this.visible = false;
                // Drop the clones while hidden; they are rebuilt on the next
                // switch anyway and the content would be stale.
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
