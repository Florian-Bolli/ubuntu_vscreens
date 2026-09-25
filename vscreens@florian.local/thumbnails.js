import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * A scaled-down live view of one space: the monitor's real wallpaper with clones
 * of that space's windows on top.
 *
 * Spaces that are not on screen can be shown at all because Clutter.Clone paints
 * its source even when the source actor is hidden -- the same property that makes
 * the per-monitor slide animation possible.
 *
 * Any BackgroundManager created here is appended to `backgroundManagers` so the
 * caller can destroy it later; wallpapers are not cheap to hold open.
 */
export function createSpaceThumbnail(spaceManager, monitorIndex, spaceIndex, width, backgroundManagers) {
    const monitor = Main.layoutManager.monitors[monitorIndex];
    if (!monitor)
        return null;

    const scale = width / monitor.width;

    const frame = new St.Widget({
        style_class: 'vscreens-thumb',
        width,
        height: Math.round(monitor.height * scale),
        clip_to_allocation: true,
    });

    // Children sit at full monitor coordinates and the whole group is scaled, so
    // window positions stay correct without scaling each clone individually.
    const contents = new Clutter.Actor({
        width: monitor.width,
        height: monitor.height,
        scale_x: scale,
        scale_y: scale,
    });
    frame.add_child(contents);

    const backgroundGroup = new Meta.BackgroundGroup({
        width: monitor.width,
        height: monitor.height,
    });
    contents.add_child(backgroundGroup);
    try {
        backgroundManagers.push(new Background.BackgroundManager({
            container: backgroundGroup,
            monitorIndex,
            controlPosition: false,
        }));
    } catch (e) {
        logError(e, 'VScreens: could not load the preview wallpaper');
    }

    for (const actor of spaceManager.windowActorsForSpace(monitorIndex, spaceIndex)) {
        const clone = new Clutter.Clone({
            source: actor,
            x: actor.x - monitor.x,
            y: actor.y - monitor.y,
        });
        actor.connectObject('destroy', () => clone.destroy(), clone);
        contents.add_child(clone);
    }

    return frame;
}
