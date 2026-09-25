import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
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

export default class VScreensExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._spaceManager = new SpaceManager(this._settings);
        this._hijacked = [];
        this._ownKeybindings = [];
        this._switchers = new Map();

        this._spaceManager.build();
        this._spaceManager.setChangedCallback(() => this._indicator?.sync());

        this._addIndicator();
        this._bindKeys();
        this._patchOverview();

        this._workspaceChangedId = global.workspace_manager.connect(
            'active-workspace-changed',
            () => this._spaceManager.handleActiveWorkspaceChanged());

        // A monitor being plugged or unplugged invalidates every monitor index,
        // so rebuild from scratch rather than trying to migrate the old layout.
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._destroySwitchers();
            this._spaceManager.build();
        });

        this._focusChangedId = global.display.connect(
            'notify::focus-window', () => this._indicator?.sync());

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'spaces-per-monitor')
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
        });
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

        this._unbindKeys();
        this._unpatchOverview();

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

    /** Show the space strip on the monitor that just switched, and only there. */
    _showSwitcher(monitorIndex) {
        if (!this._settings.get_boolean('show-osd'))
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
    }

    // ---------------------------------------------------------------- overview

    /**
     * The stock workspace thumbnails show the raw workspace list, which under
     * this model is a stage plus a pile of parking spots -- meaningless to look
     * at. Suppress the strip; the panel indicator reports space state instead.
     */
    _patchOverview() {
        this._controls = Main.overview?._overview?._controls ?? null;
        if (!this._controls?._updateThumbnailsBox)
            return;

        this._originalUpdateThumbnailsBox = this._controls._updateThumbnailsBox;
        this._syncOverviewPatch();
    }

    _syncOverviewPatch() {
        if (!this._controls || !this._originalUpdateThumbnailsBox)
            return;

        if (this._settings.get_boolean('hide-overview-thumbnails')) {
            const controls = this._controls;
            controls._updateThumbnailsBox = function () {
                this._thumbnailsBox.hide();
            };
            controls._thumbnailsBox.hide();
        } else {
            this._controls._updateThumbnailsBox = this._originalUpdateThumbnailsBox;
            this._controls._updateThumbnailsBox(false);
        }
    }

    _unpatchOverview() {
        if (this._controls && this._originalUpdateThumbnailsBox) {
            this._controls._updateThumbnailsBox = this._originalUpdateThumbnailsBox;
            this._controls._updateThumbnailsBox(false);
        }
        this._controls = null;
        this._originalUpdateThumbnailsBox = null;
    }
}
