import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {FitMode, WorkspacesView} from 'resource:///org/gnome/shell/ui/workspacesView.js';
import {ThumbnailsBox} from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SpaceManager} from './spaces.js';
import {SpaceIndicator} from './indicator.js';
import {SpaceSwitcherPopup} from './switcher.js';
import {clearWallpaperCache} from './thumbnails.js';

const SWITCH_MODE = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

// Stock shortcuts we take over, so whatever keys the user already switches
// workspaces with keep working -- they just act on one monitor now.
const HIJACKED_DIRECTIONAL = {
    'switch-to-workspace-left': -1,
    'switch-to-workspace-right': 1,
    'switch-to-workspace-up': -1,
    'switch-to-workspace-down': 1,
};

const HIJACKED_MOVE = {
    'move-to-workspace-left': -1,
    'move-to-workspace-right': 1,
};

const N_DIRECT_SHORTCUTS = 9;

// `<Control>Right` becomes `<Control><Shift>Right`. Bindings that already
// include Shift are left alone.
function withShift(accelerator) {
    if (!accelerator || /<shift>/i.test(accelerator))
        return null;

    const mods = accelerator.match(/^(?:<[^>]+>)+/);
    if (!mods)
        return `<Shift>${accelerator}`;
    return `${mods[0]}<Shift>${accelerator.slice(mods[0].length)}`;
}

export default class VScreensExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._spaceManager = new SpaceManager(this._settings);
        this._hijacked = [];
        this._ownKeybindings = [];
        this._switchers = new Map();
        this._running = false;
        this._swipeDx = 0;
        this._shiftMoves = new Map();
        this._shiftAccelId = global.display.connect(
            'accelerator-activated', (_display, action) => {
                this._onShiftAccelerator(action);
            });

        this._spaceManager.setChangedCallback(() => this._indicator?.sync());

        this._workspaceChangedId = global.workspace_manager.connect(
            'active-workspace-changed',
            () => {
                if (this._running)
                    this._spaceManager.handleActiveWorkspaceChanged();
            });

        // A monitor being plugged or unplugged invalidates every monitor index,
        // so rebuild from scratch rather than trying to migrate the old layout.
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            if (!this._running)
                return;
            this._destroySwitchers();
            this._spaceManager.build();
            this._syncOverviewPatch();
        });

        this._focusChangedId = global.display.connect(
            'notify::focus-window', () => this._indicator?.sync());

        this._swipeId = global.stage.connect('captured-event', (_actor, event) => {
            if (!this._running)
                return Clutter.EVENT_PROPAGATE;
            return this._handleSwipe(event);
        });

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'enabled')
                this._syncRunning();
            else if (!this._running)
                return;
            else if (key === 'spaces-per-monitor')
                this._spaceManager.build();
            else if (key === 'show-indicator')
                this._syncIndicatorVisibility();
            else if (key === 'hide-overview-thumbnails')
                this._syncOverviewPatch();
            else if (key === 'collapse-empty-spaces' &&
                     this._settings.get_boolean('collapse-empty-spaces'))
                this._spaceManager.compactNow();
            else if (key === 'thumbnail-size')
                this._indicator?.sync();
            else if (key === 'switch-previous' || key === 'switch-next' ||
                     key === 'show-switcher' || key === 'add-space' ||
                     key === 'remove-space') {
                this._unbindKeys();
                this._bindKeys();
            }
        });

        this._syncRunning();
    }

    disable() {
        for (const id of [this._workspaceChangedId]) {
            if (id)
                global.workspace_manager.disconnect(id);
        }
        this._workspaceChangedId = null;

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        if (this._focusChangedId) {
            global.display.disconnect(this._focusChangedId);
            this._focusChangedId = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._swipeId) {
            global.stage.disconnect(this._swipeId);
            this._swipeId = 0;
        }
        this._releaseWorkspaceSwipe();

        this._unbindKeys();
        this._unpatchOverview();

        if (this._shiftAccelId) {
            global.display.disconnect(this._shiftAccelId);
            this._shiftAccelId = 0;
        }

        this._destroySwitchers();

        this._indicator?.destroy();
        this._indicator = null;

        // Bring every parked window back before we stop running, otherwise they
        // are stranded on workspaces the user has no way to reach.
        this._spaceManager?.teardown();
        this._spaceManager = null;

        clearWallpaperCache();
        this._settings = null;
    }

    _syncRunning() {
        const enabled = this._settings.get_boolean('enabled');
        if (enabled && !this._running)
            this._start();
        else if (!enabled && this._running)
            this._stop();
    }

    _start() {
        this._running = true;
        this._claimWorkspaceSwipe();
        this._spaceManager.build();
        this._addIndicator();
        this._bindKeys();
        this._patchOverview();
    }

    _stop() {
        this._running = false;
        this._releaseWorkspaceSwipe();
        this._unbindKeys();
        this._unpatchOverview();
        this._destroySwitchers();
        this._indicator?.destroy();
        this._indicator = null;
        this._spaceManager.pause();
    }

    /**
     * Three-finger horizontal swipes switch the monitor under the pointer.
     * GNOME's own swipe moves every monitor, so that tracker is held off
     * while VScreens is running.
     */
    _claimWorkspaceSwipe() {
        const tracker = Main.wm._workspaceAnimation?._swipeTracker;
        if (!tracker || this._swipeClaimed)
            return;
        this._swipeWasEnabled = tracker.enabled;
        tracker.enabled = false;
        this._swipeClaimed = true;
    }

    _releaseWorkspaceSwipe() {
        const tracker = Main.wm._workspaceAnimation?._swipeTracker;
        if (tracker && this._swipeClaimed)
            tracker.enabled = this._swipeWasEnabled;
        this._swipeClaimed = false;
    }

    _handleSwipe(event) {
        if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;
        if (event.get_touchpad_gesture_finger_count?.() !== 3)
            return Clutter.EVENT_PROPAGATE;

        const phase = event.get_gesture_phase?.();
        const Phase = Clutter.TouchpadGesturePhase;
        if (!Phase || phase === undefined)
            return Clutter.EVENT_PROPAGATE;

        if (phase === Phase.BEGIN) {
            this._swipeDx = 0;
            return Clutter.EVENT_STOP;
        }

        if (phase === Phase.UPDATE) {
            const delta = event.get_gesture_motion_delta?.();
            const dx = Array.isArray(delta) ? delta[0] : 0;
            this._swipeDx += dx;
            return Clutter.EVENT_STOP;
        }

        if (phase === Phase.END || phase === Phase.CANCEL) {
            const dx = this._swipeDx;
            this._swipeDx = 0;
            if (phase === Phase.END && Math.abs(dx) > 80)
                this._switch(dx < 0 ? 1 : -1);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // ---------------------------------------------------------------- indicator

    _addIndicator() {
        this._indicator = new SpaceIndicator(
            this._spaceManager, this._settings, () => this.openPreferences());
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._syncIndicatorVisibility();
    }

    _syncIndicatorVisibility() {
        if (this._indicator)
            this._indicator.visible = this._settings.get_boolean('show-indicator');
    }

    // --------------------------------------------------------------- shortcuts

    _switch(delta) {
        const monitorIndex = this._spaceManager.activeMonitor();
        this._spaceManager.switchRelative(monitorIndex, delta);
        this._showSwitcher(monitorIndex);
    }

    _switchToIndex(spaceIndex) {
        const monitorIndex = this._spaceManager.activeMonitor();
        const current = this._spaceManager.currentSpace(monitorIndex);
        this._spaceManager.switchTo(monitorIndex, spaceIndex, spaceIndex >= current ? 1 : -1);
        this._showSwitcher(monitorIndex);
    }

    /**
     * Show the space strip on one monitor.
     * Automatic shows (after a switch) honour "Show switch popup". The
     * show-switcher shortcut always opens it.
     */
    _showSwitcher(monitorIndex, {force = false} = {}) {
        if (!force && !this._settings.get_boolean('show-osd'))
            return;

        const state = this._spaceManager.monitorStates
            .find(s => s.monitorIndex === monitorIndex);
        if (!state)
            return;

        let popup = this._switchers.get(monitorIndex);
        if (!popup) {
            popup = new SpaceSwitcherPopup(
                monitorIndex, this._spaceManager, this._settings,
                () => this.openPreferences());
            this._switchers.set(monitorIndex, popup);
        }
        popup.showSpace(state.current, state.nSpaces);
        popup.get_parent()?.set_child_above_sibling(popup, null);
    }

    _destroySwitchers() {
        for (const popup of this._switchers.values())
            popup.destroy();
        this._switchers.clear();
    }

    _bindKeys() {
        for (const [name, delta] of Object.entries(HIJACKED_DIRECTIONAL))
            this._hijack(name, () => this._switch(delta));

        for (const [name, delta] of Object.entries(HIJACKED_MOVE)) {
            this._hijack(name, () => {
                const monitorIndex = this._spaceManager.moveFocusedWindow(delta);
                if (monitorIndex !== null)
                    this._showSwitcher(monitorIndex);
            });
        }

        for (let i = 1; i <= N_DIRECT_SHORTCUTS; i++)
            this._hijack(`switch-to-workspace-${i}`, () => this._switchToIndex(i - 1));

        this._addOwnKeybinding('switch-previous', () => this._switch(-1));
        this._addOwnKeybinding('switch-next', () => this._switch(1));
        this._grabShiftedMove('switch-previous', -1);
        this._grabShiftedMove('switch-next', 1);
        this._addOwnKeybinding('show-switcher', () => {
            this._showSwitcher(this._spaceManager.activeMonitor(), {force: true});
        });

        this._addOwnKeybinding('add-space', () => {
            const monitorIndex = this._spaceManager.activeMonitor();
            const added = this._spaceManager.addSpace(monitorIndex);
            if (added !== null)
                this._spaceManager.switchTo(monitorIndex, added, 1);
            this._showSwitcher(monitorIndex);
        });

        this._addOwnKeybinding('remove-space', () => {
            const monitorIndex = this._spaceManager.activeMonitor();
            if (this._spaceManager.removeCurrentSpace(monitorIndex))
                this._showSwitcher(monitorIndex);
        });
    }

    _hijack(name, handler) {
        Main.wm.setCustomKeybindingHandler(name, SWITCH_MODE, handler);
        this._hijacked.push(name);
    }

    /**
     * The shortcut from settings, plus Shift, moves the focused window and
     * follows it. Ctrl+Right switches; Ctrl+Shift+Right moves.
     */
    _grabShiftedMove(key, delta) {
        for (const accelerator of this._settings.get_strv(key)) {
            const shifted = withShift(accelerator);
            if (!shifted)
                continue;

            const action = global.display.grab_accelerator(
                shifted, Meta.KeyBindingFlags.NONE);
            if (action === Meta.KeyBindingAction.NONE) {
                log(`VScreens: could not grab ${shifted} for moving a window`);
                continue;
            }

            const name = Meta.external_binding_name_for_action(action);
            Main.wm.allowKeybinding(name, SWITCH_MODE);
            this._shiftMoves.set(action, delta);
        }
    }

    _onShiftAccelerator(action) {
        if (!this._running)
            return;
        const delta = this._shiftMoves.get(action);
        if (delta === undefined)
            return;

        const monitorIndex = this._spaceManager.moveFocusedWindow(delta);
        if (monitorIndex !== null)
            this._showSwitcher(monitorIndex);
    }

    _releaseShiftedMoves() {
        for (const action of this._shiftMoves.keys())
            global.display.ungrab_accelerator(action);
        this._shiftMoves.clear();
    }

    _addOwnKeybinding(name, handler) {
        Main.wm.addKeybinding(name, this._settings,
            Meta.KeyBindingFlags.NONE, SWITCH_MODE, handler);
        this._ownKeybindings.push(name);
    }

    _unbindKeys() {
        // Hand the stock shortcuts back to GNOME's own workspace switcher.
        const restore = Main.wm._showWorkspaceSwitcher?.bind(Main.wm);
        for (const name of this._hijacked ?? []) {
            if (restore)
                Main.wm.setCustomKeybindingHandler(name, SWITCH_MODE, restore);
            else
                Main.wm.setCustomKeybindingHandler(name, SWITCH_MODE, null);
        }
        this._hijacked = [];

        for (const name of this._ownKeybindings ?? [])
            Main.wm.removeKeybinding(name);
        this._ownKeybindings = [];
        this._releaseShiftedMoves();
    }

    // ---------------------------------------------------------------- overview

    /**
     * Parking workspaces are real Mutter workspaces. Overview rebuilds a
     * thumbnail for each one on every open, which looks like empty screens.
     * Do not create those thumbnails, and keep the app-grid fit on the stage.
     */
    _patchOverview() {
        this._controls = Main.overview?._overview?._controls ?? null;
        if (!this._controls)
            return;

        if (this._controls._getFitModeForState) {
            this._originalGetFitModeForState =
                this._controls._getFitModeForState.bind(this._controls);
        }

        const thumbProto = ThumbnailsBox.prototype;
        if (!this._originalUpdateShouldShow && thumbProto._updateShouldShow) {
            this._originalUpdateShouldShow = thumbProto._updateShouldShow;
            this._originalCreateThumbnails = thumbProto._createThumbnails;
            this._originalDestroyThumbnails = thumbProto._destroyThumbnails;
        }

        const viewProto = WorkspacesView.prototype;
        if (!this._originalUpdateVisibility && viewProto._updateVisibility) {
            this._originalUpdateVisibility = viewProto._updateVisibility;
        }

        this._syncOverviewPatch();
    }

    _syncOverviewPatch() {
        if (!this._controls)
            return;

        const hide = this._settings.get_boolean('hide-overview-thumbnails');
        const thumbProto = ThumbnailsBox.prototype;
        const viewProto = WorkspacesView.prototype;

        if (hide) {
            thumbProto._updateShouldShow = function () {
                if (this._shouldShow === false)
                    return;
                this._shouldShow = false;
                this.notify('should-show');
            };
            thumbProto._createThumbnails = function () {
                this._updateShouldShow();
            };
            if (this._originalUpdateVisibility) {
                const orig = this._originalUpdateVisibility;
                viewProto._updateVisibility = function () {
                    orig.call(this);
                    if (!this._workspaces)
                        return;
                    for (let i = 0; i < this._workspaces.length; i++)
                        this._workspaces[i].visible = i === 0;
                };
            }
            if (this._originalGetFitModeForState)
                this._controls._getFitModeForState = () => FitMode.SINGLE;
        } else {
            this._restoreOverviewProtos();
        }

        this._forEachThumbnailsBox(box => {
            if (hide) {
                box._destroyThumbnails?.();
                box._updateShouldShow?.();
                box.hide();
            } else {
                box._updateShouldShow?.();
                if (Main.overview.visible)
                    box._createThumbnails?.();
            }
        });

        this._controls._update?.();
        this._refreshWorkspaceViews();
    }

    _forEachThumbnailsBox(fn) {
        const boxes = [];
        if (this._controls?._thumbnailsBox)
            boxes.push(this._controls._thumbnailsBox);
        for (const view of this._controls?._workspacesDisplay?._workspacesViews ?? []) {
            if (view._thumbnails)
                boxes.push(view._thumbnails);
        }
        for (const box of boxes)
            fn(box);
    }

    _refreshWorkspaceViews() {
        const views = this._controls?._workspacesDisplay?._workspacesViews ?? [];
        for (const view of views) {
            const inner = view._workspacesView ?? view;
            inner._updateVisibility?.();
        }
    }

    _restoreOverviewProtos() {
        if (this._originalUpdateShouldShow)
            ThumbnailsBox.prototype._updateShouldShow = this._originalUpdateShouldShow;
        if (this._originalCreateThumbnails)
            ThumbnailsBox.prototype._createThumbnails = this._originalCreateThumbnails;
        if (this._originalDestroyThumbnails)
            ThumbnailsBox.prototype._destroyThumbnails = this._originalDestroyThumbnails;
        if (this._originalUpdateVisibility)
            WorkspacesView.prototype._updateVisibility = this._originalUpdateVisibility;
        if (this._controls && this._originalGetFitModeForState)
            this._controls._getFitModeForState = this._originalGetFitModeForState;
    }

    _unpatchOverview() {
        this._restoreOverviewProtos();
        this._forEachThumbnailsBox(box => {
            box._updateShouldShow?.();
            if (Main.overview.visible)
                box._createThumbnails?.();
        });
        this._controls?._update?.();
        this._refreshWorkspaceViews();

        this._controls = null;
        this._originalGetFitModeForState = null;
        this._originalUpdateShouldShow = null;
        this._originalCreateThumbnails = null;
        this._originalDestroyThumbnails = null;
        this._originalUpdateVisibility = null;
    }
}
