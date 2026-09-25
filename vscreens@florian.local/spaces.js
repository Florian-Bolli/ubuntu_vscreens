import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {MonitorGroup} from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

// Every window that is currently visible lives on this one workspace, on every
// monitor. Windows belonging to a space that is not on screen are "parked" on a
// workspace of their own, which is never activated. The active workspace is
// therefore always STAGE, and a window's space membership is implied by the
// workspace it sits on rather than tracked separately -- which means windows the
// user drags between monitors join the right space for free.
const STAGE = 0;

/** Per-monitor state: which spaces exist, which one is on screen. */
class MonitorSpaces {
    constructor(monitorIndex) {
        this.monitorIndex = monitorIndex;
        this.parkWs = [];
        this.current = 0;
    }

    get nSpaces() {
        return this.parkWs.length;
    }
}

export class SpaceManager {
    constructor(settings) {
        this._settings = settings;
        this._wmPrefs = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._mutterPrefs = new Gio.Settings({schema_id: 'org.gnome.mutter'});

        this._monitors = new Map();
        this._animating = new Set();
        // Set while we move windows or force the active workspace back to STAGE,
        // so our own bookkeeping does not look like the user navigating away.
        this._internal = false;

        this._onChanged = null;
    }

    /** Called whenever the space layout changes, so the UI can resync. */
    setChangedCallback(cb) {
        this._onChanged = cb;
    }

    _notify() {
        this._onChanged?.();
    }

    // ---------------------------------------------------------------- lifecycle

    build() {
        const nSpaces = this._settings.get_int('spaces-per-monitor');
        this._monitors.clear();

        let nextWs = STAGE + 1;
        for (const monitor of Main.layoutManager.monitors) {
            const state = new MonitorSpaces(monitor.index);
            for (let i = 0; i < nSpaces; i++)
                state.parkWs.push(nextWs++);
            this._monitors.set(monitor.index, state);
        }

        this._ensureWorkspaces(this._requiredWorkspaceCount());
        this._gatherStrayWindows();
        this._notify();
    }

    /**
     * Pull every window back onto STAGE. Used when starting up and when shutting
     * down, so we never leave windows stranded on a parking workspace where the
     * user cannot reach them without this extension running.
     */
    _gatherStrayWindows() {
        this._internal = true;
        try {
            for (const window of this._movableWindows()) {
                const ws = window.get_workspace();
                if (ws && ws.index() !== STAGE)
                    window.change_workspace_by_index(STAGE, false);
            }
            this._activateStage();
        } finally {
            this._internal = false;
        }
    }

    teardown() {
        this._gatherStrayWindows();
        this._monitors.clear();
    }

    /** We need one workspace for the stage plus one parking spot per space. */
    _ensureWorkspaces(count) {
        if (this._mutterPrefs.get_boolean('dynamic-workspaces'))
            this._mutterPrefs.set_boolean('dynamic-workspaces', false);
        if (this._mutterPrefs.get_boolean('workspaces-only-on-primary'))
            this._mutterPrefs.set_boolean('workspaces-only-on-primary', false);
        if (this._wmPrefs.get_int('num-workspaces') !== count)
            this._wmPrefs.set_int('num-workspaces', count);
    }

    // -------------------------------------------------------------- inspection

    get monitorStates() {
        return [...this._monitors.values()].sort((a, b) => a.monitorIndex - b.monitorIndex);
    }

    currentSpace(monitorIndex) {
        return this._monitors.get(monitorIndex)?.current ?? 0;
    }

    /** The monitor a keyboard shortcut should act on. */
    activeMonitor() {
        if (this._settings.get_string('active-monitor-mode') === 'focus') {
            const focused = global.display.focus_window;
            if (focused && !focused.is_on_all_workspaces()) {
                const index = focused.get_monitor();
                if (index >= 0 && this._monitors.has(index))
                    return index;
            }
        }
        return this.pointerMonitor();
    }

    /**
     * Monitor containing the pointer, resolved from the actual pointer position
     * rather than display.get_current_monitor(), which reflects the last monitor
     * to see input and so can name a screen the mouse has already left.
     */
    pointerMonitor() {
        const [x, y] = global.get_pointer();
        for (const monitor of Main.layoutManager.monitors) {
            if (x >= monitor.x && x < monitor.x + monitor.width &&
                y >= monitor.y && y < monitor.y + monitor.height &&
                this._monitors.has(monitor.index))
                return monitor.index;
        }

        const fallback = global.display.get_current_monitor();
        return this._monitors.has(fallback) ? fallback : Main.layoutManager.primaryIndex;
    }

    /**
     * Window actors that a given space would show, for building previews. The
     * space on screen reads from STAGE and has to be filtered by monitor, since
     * STAGE holds every monitor's windows; parked spaces only ever hold their own
     * monitor's windows, so filtering those again would only risk dropping one.
     */
    windowActorsForSpace(monitorIndex, spaceIndex) {
        const state = this._monitors.get(monitorIndex);
        if (!state || spaceIndex < 0 || spaceIndex >= state.nSpaces)
            return [];

        const isCurrent = spaceIndex === state.current;
        const targetWs = isCurrent ? STAGE : state.parkWs[spaceIndex];

        return global.get_window_actors().filter(actor => {
            const window = actor.meta_window;
            if (!window || window.is_override_redirect())
                return false;
            if (window.get_window_type() === Meta.WindowType.DESKTOP)
                return false;
            if (!window.showing_on_its_workspace())
                return false;

            if (window.is_on_all_workspaces())
                return window.get_monitor() === monitorIndex;

            const ws = window.get_workspace();
            if (!ws || ws.index() !== targetWs)
                return false;

            return isCurrent ? window.get_monitor() === monitorIndex : true;
        });
    }

    _movableWindows() {
        return global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(window =>
                window &&
                !window.is_override_redirect() &&
                !window.is_on_all_workspaces() &&
                window.get_window_type() === Meta.WindowType.NORMAL);
    }

    // ---------------------------------------------------------------- switching

    switchRelative(monitorIndex, delta) {
        const state = this._monitors.get(monitorIndex);
        if (!state || state.nSpaces < 2)
            return;

        const n = state.nSpaces;
        const target = ((state.current + delta) % n + n) % n;
        this.switchTo(monitorIndex, target, delta >= 0 ? 1 : -1);
    }

    switchTo(monitorIndex, spaceIndex, direction = 1) {
        const state = this._monitors.get(monitorIndex);
        if (!state || spaceIndex === state.current)
            return;
        if (spaceIndex < 0 || spaceIndex >= state.nSpaces)
            return;
        // Ignore input while this monitor is mid-slide; the overlay owns the
        // screen until it is torn down.
        if (this._animating.has(monitorIndex))
            return;

        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (!monitor)
            return;

        const outgoingParkWs = state.parkWs[state.current];
        const incomingParkWs = state.parkWs[spaceIndex];

        // Mutter creates workspaces in response to a settings change, so it can
        // briefly lag our bookkeeping right after a rebuild.
        const nWorkspaces = global.workspace_manager.get_n_workspaces();
        if (outgoingParkWs >= nWorkspaces || incomingParkWs >= nWorkspaces) {
            this._ensureWorkspaces(this._requiredWorkspaceCount());
            return;
        }

        // Move the windows first, then build the overlay on top of the finished
        // result. Clutter has not painted a frame yet, so nothing is visible.
        this._internal = true;
        try {
            this._parkMonitorWindows(monitorIndex, outgoingParkWs);
            this._unparkWindows(incomingParkWs);
        } finally {
            this._internal = false;
        }

        state.current = spaceIndex;
        this._animateSlide(monitor, outgoingParkWs, direction);
        this._notify();
    }

    /** Send everything this monitor currently shows off to its parking spot. */
    _parkMonitorWindows(monitorIndex, parkWs) {
        for (const window of this._movableWindows()) {
            if (window.get_monitor() !== monitorIndex)
                continue;
            const ws = window.get_workspace();
            if (ws && ws.index() === STAGE)
                window.change_workspace_by_index(parkWs, false);
        }
    }

    /** Bring a parked space back onto the stage. */
    _unparkWindows(parkWs) {
        for (const window of this._movableWindows()) {
            const ws = window.get_workspace();
            if (ws && ws.index() === parkWs)
                window.change_workspace_by_index(STAGE, false);
        }
    }

    /**
     * Slide one monitor from the workspace it used to show to STAGE.
     *
     * MonitorGroup is GNOME's own workspace-switch visual: a strip of cloned
     * workspaces constrained and clipped to a single monitor, with an animatable
     * `progress`. Laying it over global.window_group animates this monitor and
     * leaves every other monitor untouched, which is the whole trick.
     */
    _animateSlide(monitor, previousWs, direction) {
        const duration = this._settings.get_int('animation-duration');
        if (duration === 0)
            return;

        const wsManager = global.workspace_manager;
        const fromWs = wsManager.get_workspace_by_index(previousWs);
        const toWs = wsManager.get_workspace_by_index(STAGE);
        if (!fromWs || !toWs)
            return;

        // The order of the indices is what decides which way the slide travels.
        const order = direction >= 0 ? [previousWs, STAGE] : [STAGE, previousWs];

        let group;
        try {
            group = new MonitorGroup(monitor, order, null);
        } catch (e) {
            logError(e, 'VScreens: could not build the slide overlay');
            return;
        }

        Main.uiGroup.insert_child_above(group, global.window_group);
        group.progress = group.getWorkspaceProgress(fromWs);

        const monitorIndex = monitor.index;
        this._animating.add(monitorIndex);
        Meta.disable_unredirect_for_display(global.display);

        const finish = () => {
            if (!this._animating.has(monitorIndex))
                return;
            this._animating.delete(monitorIndex);
            Meta.enable_unredirect_for_display(global.display);
            group.destroy();
        };

        group.ease_property('progress', group.getWorkspaceProgress(toWs), {
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: finish,
            onStopped: finish,
        });
    }

    // ------------------------------------------------------- moving the window

    /**
     * Send the focused window to the adjacent space and follow it there.
     * Returns the monitor it acted on, which is the window's own monitor rather
     * than whichever one the pointer happens to be over.
     */
    moveFocusedWindow(delta, follow = true) {
        const window = global.display.focus_window;
        if (!window || window.is_on_all_workspaces())
            return null;

        const monitorIndex = window.get_monitor();
        const state = this._monitors.get(monitorIndex);
        if (!state || state.nSpaces < 2)
            return null;

        const n = state.nSpaces;
        const target = ((state.current + delta) % n + n) % n;
        if (target === state.current)
            return null;

        if (follow) {
            // The window is on STAGE and stays there, so switching the monitor
            // carries it along -- but only if we exclude it from the parking
            // sweep, which _parkMonitorWindows would otherwise catch.
            this._internal = true;
            try {
                this._parkMonitorWindowsExcept(monitorIndex, state.parkWs[state.current], window);
                this._unparkWindows(state.parkWs[target]);
            } finally {
                this._internal = false;
            }
            const previousWs = state.parkWs[state.current];
            state.current = target;
            const monitor = Main.layoutManager.monitors[monitorIndex];
            if (monitor)
                this._animateSlide(monitor, previousWs, delta >= 0 ? 1 : -1);
        } else {
            this._internal = true;
            try {
                window.change_workspace_by_index(state.parkWs[target], false);
            } finally {
                this._internal = false;
            }
        }

        this._notify();
        return monitorIndex;
    }

    _parkMonitorWindowsExcept(monitorIndex, parkWs, keep) {
        for (const window of this._movableWindows()) {
            if (window === keep || window.get_monitor() !== monitorIndex)
                continue;
            const ws = window.get_workspace();
            if (ws && ws.index() === STAGE)
                window.change_workspace_by_index(parkWs, false);
        }
    }

    // ------------------------------------------------------- adding / removing

    addSpace(monitorIndex) {
        const state = this._monitors.get(monitorIndex);
        if (!state)
            return null;

        state.parkWs.push(this._allocateParkWs());
        this._ensureWorkspaces(this._requiredWorkspaceCount());
        this._notify();
        return state.nSpaces - 1;
    }

    /**
     * Drop the space currently on screen, moving its windows to the neighbour so
     * nothing is lost. Refuses to remove the last remaining space.
     */
    removeCurrentSpace(monitorIndex) {
        const state = this._monitors.get(monitorIndex);
        if (!state || state.nSpaces < 2)
            return false;

        const removed = state.current;
        const neighbour = removed === 0 ? 1 : removed - 1;

        // The windows on screen stay on screen and the neighbour's join them, so
        // there is nothing to slide -- the two spaces simply become one.
        this._internal = true;
        try {
            this._unparkWindows(state.parkWs[neighbour]);
        } finally {
            this._internal = false;
        }

        state.parkWs.splice(removed, 1);
        state.current = removed === 0 ? 0 : removed - 1;

        this._ensureWorkspaces(this._requiredWorkspaceCount());
        this._notify();
        return true;
    }

    _usedParkWs() {
        const used = new Set();
        for (const state of this._monitors.values()) {
            for (const ws of state.parkWs)
                used.add(ws);
        }
        return used;
    }

    /**
     * Lowest unused workspace index. Removing a space in the middle leaves a
     * hole, so handing out "one past the end" would collide with another
     * monitor's parking spot.
     */
    _allocateParkWs() {
        const used = this._usedParkWs();
        let candidate = STAGE + 1;
        while (used.has(candidate))
            candidate++;
        return candidate;
    }

    _requiredWorkspaceCount() {
        let highest = STAGE;
        for (const ws of this._usedParkWs())
            highest = Math.max(highest, ws);
        return highest + 1;
    }

    // ------------------------------------------------------ invariant guarding

    /**
     * Something outside the extension activated a workspace -- clicking a
     * dock item for a parked window, or a stock shortcut we do not own. Rather
     * than fight it, translate it: show the monitor whose space that workspace
     * belongs to, and put the active workspace back on STAGE.
     */
    handleActiveWorkspaceChanged() {
        if (this._internal)
            return;

        const index = global.workspace_manager.get_active_workspace_index();
        if (index === STAGE)
            return;

        for (const [monitorIndex, state] of this._monitors) {
            const spaceIndex = state.parkWs.indexOf(index);
            if (spaceIndex < 0)
                continue;

            this._activateStage();
            if (spaceIndex !== state.current) {
                const direction = spaceIndex > state.current ? 1 : -1;
                this.switchTo(monitorIndex, spaceIndex, direction);
            }
            return;
        }

        this._activateStage();
    }

    _activateStage() {
        const stage = global.workspace_manager.get_workspace_by_index(STAGE);
        if (!stage || stage.active)
            return;

        const wasInternal = this._internal;
        this._internal = true;
        try {
            stage.activate(global.get_current_time());
        } finally {
            this._internal = wasInternal;
        }
    }
}
