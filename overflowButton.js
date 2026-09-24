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

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Panel from 'resource:///org/gnome/shell/ui/panel.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as AppIndicator from './appIndicator.js';
import * as DBusMenu from './dbusMenu.js';
import * as IndicatorStatusIcon from './indicatorStatusIcon.js';
import * as OverflowManagerModule from './overflowManager.js';
import * as SettingsManager from './settingsManager.js';
import * as Util from './util.js';
import * as WindowManager from './windowManager.js';

const PANEL_ICON_SIZE = Panel.PANEL_ICON_SIZE || 16;

// Height of the divider that splits an entry from its expander, in logical px
const DIVIDER_HEIGHT = 18;

// Whether an event happened on the expander of a submenu item. The expander
// is reactive, so it is the source of its own events, no geometry needed
function _isOnExpander(subMenu, event) {
    const expander = subMenu._triangleBin;
    const source = event.get_source();

    return !!expander && !!source &&
        (source === expander || expander.contains(source));
}

export const OverflowButton = GObject.registerClass(
class IndicatorOverflowButton extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Indicator Overflow');

        // Disable ClickGesture from PanelMenu.Button to prevent
        // menu-switching when hovering over other panel elements.
        this._clickGesture?.set_enabled(false);

        this._menuClients = [];
        this._openedEntryMenu = null;

        // Submenus created by the DBus menu inside an entry report their
        // open state to the top menu too (PopupSubMenu._getTopMenu() skips
        // itself), and the default handler would collapse the entry holding
        // them. Only track the direct entries of this menu, as
        // DBusMenu.Client does for a regular indicator menu.
        this.menu._setOpenedSubMenu = submenu =>
            this._onEntryMenuOpened(submenu);

        const box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box',
        });
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

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.TOUCH_BEGIN ||
            event.type() === Clutter.EventType.BUTTON_PRESS) {
            this.menu?.toggle();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
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
            const indicator = statusIcon._indicator;
            if (!indicator)
                continue;

            const desktopApp = WindowManager.findDesktopApp(indicator);
            const label = desktopApp?.get_name() || indicator.title ||
                indicator.appId || 'Unknown';

            // Use PopupSubMenuMenuItem: left click = activate window (or
            // the app menu when the app has no window), click on the arrow,
            // right click or keyboard = show app menu + "Show on Panel"
            const subMenu = new PopupMenu.PopupSubMenuMenuItem(label, false);

            // Same icon as on the panel: a live icon actor of the indicator,
            // at the panel size, following icon changes
            const iconActor = new AppIndicator.IconActor(indicator,
                PANEL_ICON_SIZE);
            iconActor.reactive = false;
            subMenu.insert_child_at_index(iconActor, 0);

            // Split button look: the expander is a target of its own, set
            // off by a divider line, with the arrow centered on it
            const expander = subMenu._triangleBin;
            if (expander) {
                const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);

                subMenu.insert_child_below(new St.Widget({
                    style_class: 'appindicator-overflow-divider',
                    y_align: Clutter.ActorAlign.CENTER,
                    width: Math.max(1, Math.round(scaleFactor)),
                    height: Math.round(DIVIDER_HEIGHT * scaleFactor),
                }), expander);

                expander.add_style_class_name('appindicator-overflow-expander');
                expander.y_align = Clutter.ActorAlign.FILL;
                expander.reactive = true;
                expander.track_hover = true;

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
                if (!WindowManager.toggleWindows(indicator, event.get_time()))
                    return Clutter.EVENT_PROPAGATE;

                // Normally cleared by the skipped class handler
                actor.remove_style_pseudo_class('active');
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

            // Attach the DBus menu on first use: asking every app for its menu
            // on each rebuild is needless traffic, and some of them log errors
            // for an AboutToShow of a menu that is not shown
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
        this._menuClients.push({client, readyId});
        attach();
    }

    _addManagementItems(subMenu, indicator) {
        const manager = OverflowManagerModule.OverflowManager.getDefault();
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
        for (const {client, readyId} of this._menuClients) {
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
