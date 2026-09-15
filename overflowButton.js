// This file is part of the AppIndicator/KStatusNotifierItem GNOME Shell extension
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.

/* exported OverflowButton */

const Clutter = imports.gi.Clutter;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Extension = ExtensionUtils.getCurrentExtension();

// Circular imports: only dereference module members inside methods
const DBusMenu = Extension.imports.dbusMenu;
const OverflowManager = Extension.imports.overflowManager;
const WindowManager = Extension.imports.windowManager;

const FALLBACK_ICON_NAME = 'application-x-executable-symbolic';

var OverflowButton = GObject.registerClass(
class AppIndicatorsOverflowButton extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Indicator Overflow');

        this._menuClients = [];
        this._openedEntryMenu = null;

        // Submenus created by the DBus menu inside an entry report their
        // open state to the top menu too (PopupSubMenu._getTopMenu() skips
        // itself), and the default handler would collapse the entry holding
        // them. Only track the direct entries of this menu, as
        // DBusMenu.Client does for a regular indicator menu.
        this.menu._setOpenedSubMenu = submenu =>
            this._onEntryMenuOpened(submenu);

        const box = new St.BoxLayout({ style_class: 'panel-status-indicators-box' });
        const icon = new St.Icon({
            icon_name: 'pan-down-symbolic',
            style_class: 'system-status-icon',
        });
        box.add_child(icon);
        this.add_child(box);
    }

    _onEntryMenuOpened(submenu) {
        if (!submenu || submenu._parent !== this.menu ||
            submenu === this._openedEntryMenu)
            return;

        if (this._openedEntryMenu && this._openedEntryMenu.isOpen)
            this._openedEntryMenu.close(true);

        this._openedEntryMenu = submenu;
    }

    updateMenu(overflowedIcons) {
        this._destroyMenuClients();
        this.menu.removeAll();
        this._openedEntryMenu = null;

        for (const statusIcon of overflowedIcons) {
            const indicator = statusIcon._indicator;
            if (!indicator)
                continue;

            const appId = indicator.appId;
            const label = indicator.title || appId || 'Unknown';

            // Use PopupSubMenuMenuItem: left click = activate window,
            // right click / keyboard = show app menu + "Show on Panel"
            const subMenu = new PopupMenu.PopupSubMenuMenuItem(label, true);

            // Use gicon from the actual tray icon for proper rendering
            const gicon = statusIcon.icon?.gicon;
            if (gicon)
                subMenu.icon.gicon = gicon;
            else
                subMenu.icon.icon_name = FALLBACK_ICON_NAME;

            // Left click on the row = activate/toggle window + close overflow.
            // Handled on release: PopupSubMenuMenuItem toggles its submenu in
            // vfunc_button_release_event, which EVENT_STOP here skips.
            subMenu.connect('button-release-event', (actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;

                // Normally cleared by the skipped class handler
                actor.remove_style_pseudo_class('active');

                if (!WindowManager.toggleWindows(indicator))
                    indicator.open(...event.get_coords(), event.get_time());
                this.menu.close();
                return Clutter.EVENT_STOP;
            });

            // The DBus menu gets its own section: the client adds items
            // asynchronously (and removeAll()s its root menu on attach), so
            // this keeps the management items always at the bottom.
            const dbusMenuSection = new PopupMenu.PopupMenuSection();
            subMenu.menu.addMenuItem(dbusMenuSection);
            this._addManagementItems(subMenu, indicator);

            this.menu.addMenuItem(subMenu);
            this._attachIndicatorMenu(dbusMenuSection, indicator);
        }

        this.visible = overflowedIcons.length > 0;
    }

    _attachIndicatorMenu(section, indicator) {
        if (!indicator.menuPath)
            return;

        const client = new DBusMenu.Client(indicator.busName,
            indicator.menuPath, indicator);

        // Attach only once: attachToMenu() connects its handlers every time
        let attached = false;
        const attach = () => {
            if (attached || !client.isReady)
                return;

            attached = true;
            client.attachToMenu(section);
        };

        const readyId = client.connect('ready-changed', attach);
        this._menuClients.push({ client, readyId });
        attach();
    }

    _addManagementItems(subMenu, indicator) {
        const manager = OverflowManager.OverflowManager.getDefault();
        if (!manager || !indicator.appId)
            return;

        const separator = new PopupMenu.PopupSeparatorMenuItem();
        subMenu.menu.addMenuItem(separator);

        const showItem = new PopupMenu.PopupMenuItem('Show on Panel');
        showItem.connect('activate', () => {
            manager.unhideIcon(indicator.appId);
        });
        subMenu.menu.addMenuItem(showItem);
    }

    _destroyMenuClients() {
        for (const { client, readyId } of this._menuClients) {
            client.disconnect(readyId);
            // Stop pending async item insertions of the client
            client.cancellable.cancel();
            client.destroy();
        }
        this._menuClients = [];
    }

    _onDestroy() {
        this._destroyMenuClients();
        super._onDestroy();
    }
});
