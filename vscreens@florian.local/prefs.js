import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class VScreensPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.default_width = 560;
        window.default_height = 480;

        const page = new Adw.PreferencesPage({title: 'VScreens'});

        const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
        appearance.add(this._sizeRow(settings, 'thumbnail-size',
            'Thumbnail size',
            'Width of space previews in the panel menu and the switch popup.'));
        appearance.add(this._switchRow(settings, 'show-osd',
            'Show switch popup',
            'Thumbnails appear on the monitor that just changed space.'));
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
