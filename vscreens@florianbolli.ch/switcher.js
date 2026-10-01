import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {createThumbnailWithClose} from './thumbnails.js';

const FADE_IN_MS = 120;
const FADE_OUT_MS = 240;
// Window clones ignore a fading ancestor and stay solid after the panel
// background has already gone. The row is slightly shorter so those
// previews finish with the background instead of after it.
const THUMB_FADE_OUT_MS = 200;
const DRAG_THRESHOLD = 8;

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
            visible: false,
        });

        this._monitorIndex = monitorIndex;
        this._spaceManager = spaceManager;
        this._settings = settings;
        this._openPrefs = openPrefs;
        this._hideTimeoutId = 0;
        this._fadingOut = false;
        this._press = null;
        this._dragGrabId = 0;
        this._dragClone = null;
        this._suppressClick = false;

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
            // Flatten the clones into this row so its opacity fades them
            // together with the panel, instead of leaving them fully opaque.
            offscreen_redirect: Clutter.OffscreenRedirect.ALWAYS,
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
            this._card.remove_all_transitions();
            this._row.remove_all_transitions();
            this.visible = true;
            this._card.opacity = 0;
            this._row.opacity = 255;
            this._card.ease({
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
        this._teardownDrag();
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
                if (this._suppressClick)
                    return;
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

            if (nSpaces > 1) {
                item.connect('captured-event', (_actor, event) => {
                    if (event.type() !== Clutter.EventType.BUTTON_PRESS ||
                        event.get_button() !== 1)
                        return Clutter.EVENT_PROPAGATE;
                    if (this._eventOnClose(event))
                        return Clutter.EVENT_PROPAGATE;
                    this._armDrag(i, item, event);
                    return Clutter.EVENT_PROPAGATE;
                });
            }

            this._row.add_child(item);
        }
    }

    _eventOnClose(event) {
        let actor = event.get_source?.() ?? null;
        while (actor) {
            const style = actor.style_class ?? '';
            if (style.includes('vscreens-thumb-close'))
                return true;
            actor = actor.get_parent?.() ?? null;
        }
        return false;
    }

    _armDrag(index, item, event) {
        this._teardownDrag();
        const [x, y] = event.get_coords();
        this._press = {index, item, x, y, dragging: false};
        this._dragGrabId = global.stage.connect('captured-event', (_actor, stageEvent) => {
            return this._onDragEvent(stageEvent);
        });
    }

    _onDragEvent(event) {
        if (!this._press)
            return Clutter.EVENT_PROPAGATE;

        const type = event.type();
        const isMotion = type === Clutter.EventType.MOTION;
        const isRelease = type === Clutter.EventType.BUTTON_RELEASE &&
            event.get_button() === 1;
        if (!isMotion && !isRelease)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const dx = x - this._press.x;
        const dy = y - this._press.y;
        if (!this._press.dragging) {
            if (!isRelease && dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD)
                return Clutter.EVENT_PROPAGATE;
            if (isRelease) {
                this._teardownDrag();
                return Clutter.EVENT_PROPAGATE;
            }
            this._press.dragging = true;
            this._suppressClick = true;
            this._cancelHide();
            this._liftDragClone(this._press.item, x, y);
        }

        if (this._dragClone)
            this._dragClone.set_position(x - this._dragOffsetX, y - this._dragOffsetY);

        const target = this._dropIndex(x);
        this._markDropTarget(target);

        if (!isRelease)
            return Clutter.EVENT_STOP;

        const from = this._press.index;
        this._teardownDrag();
        // The button's clicked signal follows this release. Ignore that one
        // click so a drop does not also switch and close the menu.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._suppressClick = false;
            return GLib.SOURCE_REMOVE;
        });

        if (target !== from &&
            this._spaceManager.moveSpace(this._monitorIndex, from, target)) {
            const state = this._spaceManager.monitorStates
                .find(s => s.monitorIndex === this._monitorIndex);
            if (state)
                this.showSpace(state.current, state.nSpaces);
        }
        this._scheduleHide();
        return Clutter.EVENT_STOP;
    }

    _liftDragClone(item, pointerX, pointerY) {
        const [ix, iy] = item.get_transformed_position();
        this._dragOffsetX = pointerX - ix;
        this._dragOffsetY = pointerY - iy;
        this._dragClone = new Clutter.Clone({
            source: item,
            width: item.width,
            height: item.height,
        });
        this._dragClone.set_position(ix, iy);
        Main.uiGroup.add_child(this._dragClone);
        item.opacity = 70;
        item.add_style_class_name('vscreens-switcher-item-drag');
    }

    /** Index of the space the pointer would drop onto. */
    _dropIndex(pointerX) {
        const children = this._row.get_children();
        for (let i = 0; i < children.length; i++) {
            const [x] = children[i].get_transformed_position();
            if (pointerX < x + children[i].width / 2)
                return i;
        }
        return Math.max(0, children.length - 1);
    }

    _markDropTarget(index) {
        const children = this._row.get_children();
        for (let i = 0; i < children.length; i++) {
            if (i === index)
                children[i].add_style_class_name('vscreens-switcher-item-drop');
            else
                children[i].remove_style_class_name('vscreens-switcher-item-drop');
        }
    }

    _teardownDrag() {
        if (this._dragGrabId) {
            global.stage.disconnect(this._dragGrabId);
            this._dragGrabId = 0;
        }
        if (this._dragClone) {
            this._dragClone.destroy();
            this._dragClone = null;
        }
        const item = this._press?.item;
        try {
            if (item?.get_parent()) {
                item.opacity = 255;
                item.remove_style_class_name('vscreens-switcher-item-drag');
                item.remove_style_class_name('vscreens-switcher-item-drop');
            }
        } catch (e) {
            // The thumbnail row can already be gone when the popup is destroyed.
        }
        for (const child of this._row?.get_children?.() ?? [])
            child.remove_style_class_name('vscreens-switcher-item-drop');
        this._press = null;
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
        this._card.remove_all_transitions();
        this._row.remove_all_transitions();
        this._row.ease({
            opacity: 0,
            duration: THUMB_FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
        });
        this._card.ease({
            opacity: 0,
            duration: FADE_OUT_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
            onComplete: () => {
                if (!this._fadingOut)
                    return;
                this._fadingOut = false;
                this.visible = false;
                this._row.opacity = 255;
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
        this._teardownDrag();
        this._clearContents();
    }
});
