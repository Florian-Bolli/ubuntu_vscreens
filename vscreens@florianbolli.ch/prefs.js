import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class VScreensPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.default_width = 560;
        window.default_height = 640;

        const page = new Adw.PreferencesPage({title: 'VScreens'});

        const general = new Adw.PreferencesGroup({title: 'General'});
        general.add(this._switchRow(settings, 'enabled',
            'Enable VScreens',
            'Turn per-monitor spaces off without uninstalling. GNOME workspace switching comes back.'));
        page.add(general);

        const shortcuts = new Adw.PreferencesGroup({
            title: 'Shortcuts',
            description: 'Click a shortcut, then press the keys. Backspace clears it.',
        });
        shortcuts.add(this._shortcutRow(settings, 'switch-previous',
            'Previous space',
            'Default is Ctrl+Left. Hold Shift to move the focused window there.'));
        shortcuts.add(this._shortcutRow(settings, 'switch-next',
            'Next space',
            'Default is Ctrl+Right. Hold Shift to move the focused window there.'));
        shortcuts.add(this._shortcutRow(settings, 'show-switcher',
            'Show thumbnail menu',
            'Opens the menu without switching. Default is Ctrl+Up.'));
        shortcuts.add(this._shortcutRow(settings, 'add-space',
            'Add a space',
            'Default is Super+Alt+='));
        shortcuts.add(this._shortcutRow(settings, 'remove-space',
            'Remove the current space',
            'Default is Super+Alt+-'));
        page.add(shortcuts);

        const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
        appearance.add(this._sizeRow(settings, 'thumbnail-size',
            'Thumbnail size',
            'Width of space previews in the panel menu and the switch popup.'));
        appearance.add(this._switchRow(settings, 'show-osd',
            'Show switch popup',
            'Thumbnails appear on the monitor that just changed space.'));
        appearance.add(this._sizeRow(settings, 'switcher-timeout',
            'Time until thumbnails disappear',
            'Milliseconds the thumbnail menu stays after switching a screen. Hovering keeps it open.',
            0, 10000, 100));
        appearance.add(this._switchRow(settings, 'show-indicator',
            'Show panel indicator',
            'Dots in the top bar, one group per monitor.'));
        page.add(appearance);

        const behavior = new Adw.PreferencesGroup({title: 'Behavior'});
        behavior.add(this._switchRow(settings, 'collapse-empty-spaces',
            'Collapse empty spaces',
            'If several empty spaces sit next to each other on a monitor, keep only one.'));
        behavior.add(this._comboRow(settings, 'active-monitor-mode',
            'Switch the monitor under',
            ['pointer', 'focus'],
            ['The mouse pointer', 'The focused window']));
        behavior.add(this._sizeRow(settings, 'animation-duration',
            'Slide duration',
            'Milliseconds. Set to 0 for an instant switch.',
            0, 1000, 10));
        behavior.add(this._sizeRow(settings, 'spaces-per-monitor',
            'Starting spaces per monitor',
            'Used when the extension starts or when a monitor is plugged in.',
            1, 12, 1));
        behavior.add(this._switchRow(settings, 'isolate-fullscreen',
            'New space for a fullscreen window',
            'Fullscreen, including F11, gets its own space when the current one already has other windows.'));
        behavior.add(this._switchRow(settings, 'isolate-maximized',
            'New space for a maximized window',
            'A maximized window gets its own space instead of covering the one you are on.'));
        page.add(behavior);

        window.add(page);
    }

    _switchRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _sizeRow(settings, key, title, subtitle, lower = 160, upper = 600, step = 20) {
        const row = new Adw.ActionRow({title, subtitle});
        const adjustment = new Gtk.Adjustment({
            lower,
            upper,
            step_increment: step,
            page_increment: step * 2,
        });
        const scale = new Gtk.Scale({
            adjustment,
            digits: 0,
            draw_value: true,
            hexpand: true,
            width_request: 200,
            valign: Gtk.Align.CENTER,
        });
        settings.bind(key, adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(scale);
        return row;
    }

    _shortcutRow(settings, key, title, subtitle) {
        const row = new Adw.ActionRow({title, subtitle});
        const label = new Gtk.ShortcutLabel({
            accelerator: settings.get_strv(key)[0] ?? '',
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });
        const button = new Gtk.Button({
            child: label,
            valign: Gtk.Align.CENTER,
        });
        let listening = false;
        const apply = accel => {
            settings.set_strv(key, accel ? [accel] : []);
            label.disabled_text = 'Disabled';
            label.accelerator = accel ?? '';
        };
        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_controller, keyval, _keycode, state) => {
            if (!listening)
                return Gdk.EVENT_PROPAGATE;
            if (keyval === Gdk.KEY_Escape) {
                listening = false;
                label.disabled_text = 'Disabled';
                label.accelerator = settings.get_strv(key)[0] ?? '';
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace || keyval === Gdk.KEY_Delete) {
                listening = false;
                apply('');
                return Gdk.EVENT_STOP;
            }
            const loneModifier = [
                Gdk.KEY_Control_L, Gdk.KEY_Control_R,
                Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
                Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
                Gdk.KEY_Super_L, Gdk.KEY_Super_R,
                Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
                Gdk.KEY_ISO_Level3_Shift,
            ];
            if (loneModifier.includes(keyval))
                return Gdk.EVENT_STOP;

            const mask = state & Gtk.accelerator_get_default_mod_mask();
            listening = false;
            apply(Gtk.accelerator_name(keyval, mask));
            return Gdk.EVENT_STOP;
        });
        button.add_controller(controller);
        button.connect('clicked', () => {
            listening = true;
            label.accelerator = '';
            label.disabled_text = 'Press keys…';
        });
        settings.connect(`changed::${key}`, () => {
            if (!listening)
                label.accelerator = settings.get_strv(key)[0] ?? '';
        });
        row.add_suffix(button);
        return row;
    }

    _comboRow(settings, key, title, ids, labels) {
        const model = new Gtk.StringList();
        for (const label of labels)
            model.append(label);

        const row = new Adw.ComboRow({title, model});
        row.selected = Math.max(0, ids.indexOf(settings.get_string(key)));
        row.connect('notify::selected', () => {
            const id = ids[row.selected];
            if (id)
                settings.set_string(key, id);
        });
        return row;
    }
}
