import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// One downscaled wallpaper for every thumbnail. 512 CSS pixels times the
// theme scale is enough for the largest preview and avoids decoding the
// native 6K/8K image more than once.
const CACHE_CSS_WIDTH = 512;

let _wallpaper = null;
let _bgSettings = null;
let _ifaceSettings = null;
let _bgChangedId = 0;
let _ifaceChangedId = 0;

/**
 * A scaled-down live view of one space: the desktop wallpaper (loaded once,
 * downscaled, then reused) with clones of that space's windows on top.
 *
 * Spaces that are not on screen can be shown because Clutter.Clone paints its
 * source even when the source actor is hidden.
 */
export function createSpaceThumbnail(spaceManager, monitorIndex, spaceIndex, width) {
    const monitor = Main.layoutManager.monitors[monitorIndex];
    if (!monitor)
        return null;

    const scale = width / monitor.width;
    const height = Math.round(monitor.height * scale);

    const frame = new St.Widget({
        style_class: 'vscreens-thumb',
        width,
        height,
        clip_to_allocation: true,
    });

    const wallpaper = getWallpaperContent(monitor);
    if (wallpaper) {
        frame.add_child(new Clutter.Actor({
            width,
            height,
            content: wallpaper,
            content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
        }));
    }

    // Children sit at full monitor coordinates and the whole group is scaled, so
    // window positions stay correct without scaling each clone individually.
    const contents = new Clutter.Actor({
        width: monitor.width,
        height: monitor.height,
        scale_x: scale,
        scale_y: scale,
    });
    frame.add_child(contents);

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

/**
 * Thumbnail plus an optional close button pinned to the top-right. The close
 * button is a sibling, not a child of the select button, so clicking × removes
 * the space instead of switching to it.
 */
export function createThumbnailWithClose(spaceManager, monitorIndex, spaceIndex, width, {onSelect = null, onRemove = null, selected = false} = {}) {
    const wrap = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        style_class: selected
            ? 'vscreens-thumb-wrap vscreens-thumb-wrap-selected'
            : 'vscreens-thumb-wrap',
    });

    const thumb = createSpaceThumbnail(spaceManager, monitorIndex, spaceIndex, width);
    if (!thumb)
        return wrap;

    if (onSelect) {
        const select = new St.Button({
            style_class: selected
                ? 'vscreens-thumb-button vscreens-thumb-current'
                : 'vscreens-thumb-button',
            can_focus: true,
            child: thumb,
        });
        select.connect('clicked', onSelect);
        wrap.add_child(select);
    } else {
        wrap.add_child(thumb);
    }

    const state = spaceManager.monitorStates.find(s => s.monitorIndex === monitorIndex);
    if (onRemove && state && state.nSpaces > 1) {
        const close = new St.Button({
            style_class: 'vscreens-thumb-close',
            child: new St.Label({
                text: '×',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
            can_focus: true,
        });
        close.connect('clicked', onRemove);
        wrap.add_child(close);
    }

    return wrap;
}

export function clearWallpaperCache() {
    _wallpaper = null;
    if (_bgSettings && _bgChangedId) {
        _bgSettings.disconnect(_bgChangedId);
        _bgChangedId = 0;
    }
    if (_ifaceSettings && _ifaceChangedId) {
        _ifaceSettings.disconnect(_ifaceChangedId);
        _ifaceChangedId = 0;
    }
    _bgSettings = null;
    _ifaceSettings = null;
}

// ---------------------------------------------------------------- wallpaper

function getWallpaperContent(monitor) {
    const file = wallpaperFile();
    if (!file)
        return null;

    const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    const destW = Math.round(CACHE_CSS_WIDTH * scaleFactor);
    const destH = Math.max(1, Math.round(destW * monitor.height / monitor.width));
    const key = `${file.get_uri()}@${destW}x${destH}`;

    if (_wallpaper?.key === key)
        return _wallpaper.content;

    try {
        const path = file.get_path();
        if (!path)
            return null;

        const pixbuf = loadCoverPixbuf(path, destW, destH);
        const content = pixbufToContent(pixbuf);
        _wallpaper = {key, content};
        watchWallpaperSettings();
        return content;
    } catch (e) {
        logError(e, 'VScreens: could not load thumbnail wallpaper');
        return null;
    }
}

function wallpaperFile() {
    if (!_bgSettings)
        _bgSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    if (!_ifaceSettings)
        _ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

    const dark = _ifaceSettings.get_string('color-scheme') === 'prefer-dark';
    const uri = (dark && _bgSettings.get_string('picture-uri-dark')) ||
        _bgSettings.get_string('picture-uri');
    if (!uri)
        return null;

    const file = Gio.File.new_for_uri(uri);
    return file.query_exists(null) ? file : null;
}

function watchWallpaperSettings() {
    if (_bgChangedId || !_bgSettings)
        return;

    _bgChangedId = _bgSettings.connect('changed', () => {
        _wallpaper = null;
    });
    _ifaceChangedId = _ifaceSettings.connect('changed::color-scheme', () => {
        _wallpaper = null;
    });
}

/**
 * Decode the image already sized to cover destW×destH, then crop the centre.
 * GdkPixbuf scales during load, so the full 8K bitmap is never materialised.
 */
function loadCoverPixbuf(path, destW, destH) {
    const info = GdkPixbuf.Pixbuf.get_file_info(path);
    const srcW = info[1];
    const srcH = info[2];
    if (!srcW || !srcH)
        return GdkPixbuf.Pixbuf.new_from_file_at_scale(path, destW, destH, false);

    const factor = Math.max(destW / srcW, destH / srcH);
    const loadW = Math.max(destW, Math.round(srcW * factor));
    const loadH = Math.max(destH, Math.round(srcH * factor));
    const scaled = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, loadW, loadH, true);

    const cropW = Math.min(destW, scaled.get_width());
    const cropH = Math.min(destH, scaled.get_height());
    const x = Math.max(0, Math.floor((scaled.get_width() - cropW) / 2));
    const y = Math.max(0, Math.floor((scaled.get_height() - cropH) / 2));
    return scaled.new_subpixbuf(x, y, cropW, cropH).copy();
}

function pixbufToContent(pixbuf) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const format = pixbuf.get_has_alpha()
        ? Cogl.PixelFormat.RGBA_8888
        : Cogl.PixelFormat.RGB_888;
    const content = St.ImageContent.new_with_preferred_size(width, height);
    const pixels = pixbuf.get_pixels();

    try {
        content.set_data(pixels, format, width, height, pixbuf.get_rowstride());
    } catch {
        const ctx = global.stage.context.get_backend().get_cogl_context();
        content.set_bytes(
            ctx,
            GLib.Bytes.new(pixels),
            format,
            width,
            height,
            pixbuf.get_rowstride());
    }

    return content;
}
