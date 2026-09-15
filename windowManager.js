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

/* exported toggleWindows, toggleTrayIconWindows, findDesktopApp */

const GLib = imports.gi.GLib;
const Shell = imports.gi.Shell;

const WindowTracker = Shell.WindowTracker.get_default();

// Directories shared by many apps, too generic to match an app by
const GENERIC_DIRS = ['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/local/bin', '/opt'];

// Resolved desktop apps, keyed by indicator and by tray icon
const _desktopAppCache = new WeakMap();

/**
 * Toggle windows for an indicator, like a taskbar entry: minimize if the app
 * is focused, activate its windows otherwise. An Electron app without windows
 * (closed to tray) gets a new window; its single instance lock brings back
 * the existing one.
 *
 * @param {AppIndicator} indicator - the SNI indicator
 * @param {number} timestamp - event time
 * @returns {boolean} true if handled, false to fall through
 */
function toggleWindows(indicator, timestamp) {
    const desktopApp = findDesktopApp(indicator);
    let app = desktopApp?.get_windows().length ? desktopApp : _findRunningApp(indicator);
    if (!app && desktopApp && _isElectron(_getExecutable(indicator._commandLine)))
        app = desktopApp;

    return app ? _toggleAppWindows(app, timestamp) : false;
}

/**
 * Same as toggleWindows() for a legacy XEmbed tray icon.
 *
 * @param {Shell.TrayIcon} trayIcon - the legacy tray icon
 * @param {number} timestamp - event time
 * @returns {boolean} true if handled, false to forward the click to the icon
 */
function toggleTrayIconWindows(trayIcon, timestamp) {
    const exe = _getPidExecutable(trayIcon.pid);
    let app = trayIcon.pid ? WindowTracker.get_app_from_pid(trayIcon.pid) : null;

    if (!app) {
        app = _cachedLookup(trayIcon, trayIcon.wm_class, () =>
            _lookupDesktopApp(exe, [trayIcon.wm_class]));
    }

    if (!app || (!app.get_windows().length && !_isElectron(exe)))
        return false;

    return _toggleAppWindows(app, timestamp);
}

/**
 * Find the installed desktop app an indicator belongs to, whether it has
 * windows or not.
 *
 * @param {AppIndicator} indicator - the SNI indicator
 * @returns {Shell.App|null} the app, if any
 */
function findDesktopApp(indicator) {
    if (!indicator?.id)
        return null;

    // The command line is loaded asynchronously, resolve again once it is set
    return _cachedLookup(indicator, indicator._commandLine || '', () =>
        _lookupDesktopApp(_getExecutable(indicator._commandLine),
            [indicator.id, indicator.title]));
}

function _toggleAppWindows(app, timestamp) {
    const windows = app.get_windows();
    if (!windows.length) {
        app.open_new_window(-1);
        return true;
    }

    const focusedApp = WindowTracker.focusApp;
    if (focusedApp && focusedApp.get_id() === app.get_id()) {
        windows.forEach(win => win.minimize());
        return true;
    }

    const workspace = global.workspace_manager.get_active_workspace();
    for (const win of windows) {
        if (!win.is_on_all_workspaces())
            win.change_workspace(workspace);
        win.unminimize();
        app.activate_window(win, timestamp);
    }
    return true;
}

function _cachedLookup(key, cacheTag, lookup) {
    const cached = _desktopAppCache.get(key);
    if (cached && cached.tag === cacheTag)
        return cached.app;

    const app = lookup();
    _desktopAppCache.set(key, { tag: cacheTag, app });
    return app;
}

// Scores installed apps: same executable, then StartupWMClass or desktop id
// equal to one of the names, then an app specific install directory
function _lookupDesktopApp(exe, names) {
    const appSystem = Shell.AppSystem.get_default();
    const exeBasename = exe ? GLib.path_get_basename(exe) : null;
    const lowerNames = [exeBasename, ...names]
        .filter(n => n).map(n => n.toLowerCase());
    const exeDir = exe ? GLib.path_get_dirname(exe) : null;
    const matchDir = exeDir && !GENERIC_DIRS.includes(exeDir);

    let best = null;
    let bestScore = 0;
    for (const info of appSystem.get_installed()) {
        const commandLine = info.get_commandline() || '';
        const wmClass = info.get_startup_wm_class()?.toLowerCase();
        const desktopId = info.get_id()?.toLowerCase().replace(/\.desktop$/, '');
        let score = 0;

        if (exe && commandLine.split(/\s+/).includes(exe))
            score = 3;
        else if ((wmClass && lowerNames.includes(wmClass)) ||
                 (desktopId && lowerNames.includes(desktopId)))
            score = 2;
        else if (matchDir && commandLine.includes(`${exeDir}/`))
            score = 1;

        if (score > bestScore) {
            const app = appSystem.lookup_app(info.get_id());
            if (app) {
                best = app;
                bestScore = score;
            }
        }
    }

    return best;
}

function _getExecutable(commandLine) {
    return commandLine?.trim().split(/\s+/)[0] || null;
}

function _getPidExecutable(pid) {
    if (!pid)
        return null;

    try {
        return GLib.file_read_link(`/proc/${pid}/exe`);
    } catch (e) {
        return null;
    }
}

function _isElectron(exe) {
    if (!exe || !GLib.path_is_absolute(exe))
        return false;

    const dir = GLib.path_get_dirname(exe);
    return GLib.file_test(`${dir}/chrome_crashpad_handler`, GLib.FileTest.EXISTS) ||
        GLib.file_test(`${dir}/resources/app.asar`, GLib.FileTest.EXISTS);
}

// Fallback heuristics for apps without a matching desktop file
function _findRunningApp(indicator) {
    const appSystem = Shell.AppSystem.get_default();
    const id = indicator.id.toLowerCase();
    const title = indicator.title?.toLowerCase();
    const cmdLine = indicator._commandLine?.toLowerCase();

    // Try direct desktop-file lookup
    for (const suffix of ['', '.desktop']) {
        const app = appSystem.lookup_app(indicator.id + suffix);
        if (app?.get_windows().length)
            return app;
    }

    // Match by command line first (reliable for Electron apps sharing same SNI ID)
    if (cmdLine) {
        for (const app of appSystem.get_running()) {
            if (!app.get_windows().length)
                continue;

            const appId = app.get_id()?.toLowerCase().replace('.desktop', '');
            if (appId && cmdLine.includes(appId))
                return app;
        }
    }

    // Match by wm_class among running apps
    for (const app of appSystem.get_running()) {
        const windows = app.get_windows();
        if (!windows.length)
            continue;

        const wmClass = windows[0].get_wm_class()?.toLowerCase();
        const appId = app.get_id()?.toLowerCase();

        if (wmClass && id && (wmClass.includes(id) || id.includes(wmClass)))
            return app;
        if (wmClass && title && (wmClass.includes(title) || title.includes(wmClass)))
            return app;
        if (appId && id && appId.includes(id))
            return app;

        // Match command line against wm_class
        if (wmClass && cmdLine && cmdLine.includes(wmClass))
            return app;
    }

    return null;
}
