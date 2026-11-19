/* global Zotero, Services, ZTG_Bundle */
/* exported install, startup, shutdown, uninstall, onMainWindowLoad, onMainWindowUnload */

var ZoteroTabGroups;

// Bootstrap reason codes (see Zotero's xpcom/plugins.js)
const REASON_APP_SHUTDOWN = 2;
const REASON_ADDON_UNINSTALL = 6;

function install() {}

async function startup({ id, version, rootURI }) {
	// content/plugin.js is the esbuild bundle of src/content/*.ts (see scripts/build.js)
	Services.scriptloader.loadSubScript(rootURI + 'content/plugin.js');
	ZoteroTabGroups = ZTG_Bundle.plugin;
	ZoteroTabGroups.init({ id, version, rootURI });
	ZoteroTabGroups.addToAllWindows();
}

function onMainWindowLoad({ window }) {
	if (ZoteroTabGroups) ZoteroTabGroups.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	if (ZoteroTabGroups) ZoteroTabGroups.removeFromWindow(window);
}

function shutdown(data, reason) {
	if (!ZoteroTabGroups) return;
	if (reason === REASON_APP_SHUTDOWN) {
		// Zotero is quitting: keep tab data as-is so the session saves groups
		ZoteroTabGroups.flush();
		return;
	}
	ZoteroTabGroups.shutdown();
	ZoteroTabGroups = undefined;
}

function uninstall(data, reason) {
	if (reason === REASON_ADDON_UNINSTALL && typeof Zotero !== 'undefined') {
		try {
			// Same key as PREF_GROUPS in content/plugin.ts (the bundle isn't loaded here)
			Zotero.Prefs.clear('extensions.zotero-tab-groups.groups', true);
		}
		catch (e) {
			// ignore
		}
	}
}
