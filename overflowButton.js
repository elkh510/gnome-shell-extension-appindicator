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

const Main = imports.ui.main;
const Panel = imports.ui.panel;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Extension = ExtensionUtils.getCurrentExtension();

// Circular imports: only dereference module members inside methods
const AppIndicator = Extension.imports.appIndicator;
const DBusMenu = Extension.imports.dbusMenu;
const IndicatorStatusIcon = Extension.imports.indicatorStatusIcon;
const OverflowManager = Extension.imports.overflowManager;
const SettingsManager = Extension.imports.settingsManager;
const Util = Extension.imports.util;
const WindowManager = Extension.imports.windowManager;

// Height of the divider that splits an entry from its expander, in logical px
// The icon of the app behind a legacy XEmbed icon, for its overflow entry
function _createAppIcon(statusIcon) {
    const icon = statusIcon.app?.create_icon_texture(Panel.PANEL_ICON_SIZE);

    return icon ?? new St.Icon({
        icon_name: 'application-x-executable-symbolic',
        icon_size: Panel.PANEL_ICON_SIZE,
    });
}

// Whether an event happened on the expander of a submenu item. The expander
// is reactive, so it is the source of its own events, no geometry needed
function _isOnExpander(subMenu, event) {
    const expander = subMenu._triangleBin;
    const source = event.get_source();

    return !!expander && !!source &&
        (source === expander || expander.contains(source));
}

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
        this._arrowIcon = new St.Icon({
            icon_name: 'pan-up-symbolic',
            style_class: 'system-status-icon',
        });
        box.add_child(this._arrowIcon);
        this.add_child(box);

        this.menu.connect('open-state-changed', () => this._updateArrow());
        // The panel the button sits in is only known once it is on the stage
        this.connect('notify::mapped', () => this._updateArrow());
        this._updateArrow();

        const settings = SettingsManager.getDefaultGSettings();
        const updateStyle = () =>
            IndicatorStatusIcon.updateCompactModeStyle(this);
        Util.connectSmart(settings, 'changed::compact-mode-enabled', this, updateStyle);
        Util.connectSmart(settings, 'changed::icon-spacing', this, updateStyle);
        updateStyle();
    }

    // The arrow points the way the menu goes: down while the menu is closed
    // on a panel at the top of the screen, up on a panel at the bottom, and
    // the other way round while the menu is open
    _updateArrow() {
        const pointsDown = this._opensDownwards() !== this.menu.isOpen;
        this._arrowIcon.icon_name = pointsDown
            ? 'pan-down-symbolic' : 'pan-up-symbolic';
    }

    _opensDownwards() {
        // Asking for the geometry of a button that is not on the stage yet
        // answers nothing useful and makes St complain about the theme node
        if (!this.get_stage())
            return true;

        const [, y] = this.get_transformed_position();
        const monitor = Main.layoutManager.findMonitorForActor(this);
        if (!monitor || !Number.isFinite(y))
            return true;

        return y + this.height / 2 < monitor.y + monitor.height / 2;
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
            // A legacy XEmbed icon has no indicator behind it: its entry is
            // named and drawn after the app the shell resolved for it
            const indicator = statusIcon._indicator;
            const appId = indicator ? indicator.appId : statusIcon.appId;
            const label = (indicator
                ? WindowManager.findDesktopApp(indicator)?.get_name() ||
                    indicator.title
                : statusIcon.title) || appId || 'Unknown';

            // Use PopupSubMenuMenuItem: left click = activate window (or
            // the app menu when the app has no window), click on the arrow,
            // right click or keyboard = show app menu + "Show on Panel"
            const subMenu = new PopupMenu.PopupSubMenuMenuItem(label, false);

            // Same icon as on the panel: a live icon actor of the indicator,
            // at the panel size, following icon changes. The X window of a
            // legacy icon cannot be in two places at once, so its entry gets
            // the icon of the app instead
            const iconActor = indicator
                ? new AppIndicator.IconActor(indicator, Panel.PANEL_ICON_SIZE)
                : _createAppIcon(statusIcon);
            iconActor.reactive = false;
            subMenu.insert_child_at_index(iconActor, 0);

            // Split button look: the expander is a target of its own, set
            // off by a divider line, with the arrow centered on it
            const expander = subMenu._triangleBin;
            if (expander) {
                const { scale_factor: scaleFactor } =
                    St.ThemeContext.get_for_stage(global.stage);

                subMenu.insert_child_below(new St.Widget({
                    style_class: 'appindicator-overflow-divider',
                    y_align: Clutter.ActorAlign.FILL,
                    y_expand: true,
                    width: Math.max(1, Math.round(scaleFactor)),
                }), expander);

                expander.add_style_class_name('appindicator-overflow-expander');
                expander.y_align = Clutter.ActorAlign.FILL;
                expander.reactive = true;
                expander.track_hover = true;

                // The expander of the shell fills the row, which makes the
                // half with the arrow as wide as the entry. Let the label
                // take the room instead, so the arrow keeps to its own edge
                expander.x_expand = false;
                subMenu.label.x_expand = true;

                // Without a layout manager the arrow is placed at the origin
                // of the actor, which leaves it off center inside the padding
                expander.layout_manager = new Clutter.BinLayout();
            }

            // Left click on the row = activate/toggle window + close overflow.
            // Handled on release: PopupSubMenuMenuItem toggles its submenu in
            // vfunc_button_release_event, which EVENT_STOP here skips.
            subMenu.connect('button-release-event', (actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;

                // Let the expander arrow open the app menu, as in the panel
                if (_isOnExpander(subMenu, event))
                    return Clutter.EVENT_PROPAGATE;

                // A tray only app has no window to raise, so the click stays
                // a plain click: let the class handler open the app menu,
                // which is all such an app has to offer (an overflowed icon
                // always has one, isReady() requires a menu path)
                const raised = indicator
                    ? WindowManager.toggleWindows(indicator, event.get_time())
                    : WindowManager.toggleTrayIconWindows(statusIcon.icon,
                        event.get_time());
                if (!raised)
                    return Clutter.EVENT_PROPAGATE;

                // Normally cleared by the skipped class handler
                actor.remove_style_pseudo_class('active');
                this.menu.close();
                return Clutter.EVENT_STOP;
            });

            // The DBus menu gets its own section: the client adds items
            // asynchronously (and removeAll()s its root menu on attach), so
            // this keeps the management items always at the bottom. A legacy
            // icon has no menu to offer, only the way back to the panel.
            const dbusMenuSection = indicator
                ? new PopupMenu.PopupMenuSection() : null;
            if (dbusMenuSection)
                subMenu.menu.addMenuItem(dbusMenuSection);
            this._addManagementItems(subMenu, appId);

            this.menu.addMenuItem(subMenu);

            // Attach the DBus menu on first use: asking every app for its menu
            // on each rebuild is needless traffic, and some of them log errors
            // for an AboutToShow of a menu that is not shown
            if (!dbusMenuSection)
                continue;

            const openId = subMenu.menu.connect('open-state-changed',
                (_menu, isOpen) => {
                    if (!isOpen)
                        return;

                    subMenu.menu.disconnect(openId);
                    this._attachIndicatorMenu(dbusMenuSection, indicator);
                });
        }

        this.visible = overflowedIcons.length > 0;

        // A panel that moves the button (dash-to-panel at the bottom of the
        // screen) does so without allocating it again, so the side it sits on
        // is checked whenever the menu is rebuilt
        this._updateArrow();
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

    _addManagementItems(subMenu, appId) {
        const manager = OverflowManager.OverflowManager.getDefault();
        if (!manager || !appId)
            return;

        const separator = new PopupMenu.PopupSeparatorMenuItem();
        subMenu.menu.addMenuItem(separator);

        const showItem = new PopupMenu.PopupMenuItem('Show on Panel');
        showItem.connect('activate', () => {
            manager.unhideIcon(appId);
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
