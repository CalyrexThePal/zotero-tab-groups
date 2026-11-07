/* global Zotero, Services */
/* exported install, startup, shutdown, uninstall, onMainWindowLoad, onMainWindowUnload */

var ZoteroTabGroups;

// Bootstrap reason codes (see Zotero's xpcom/plugins.js)
const REASON_APP_SHUTDOWN = 2;
const REASON_ADDON_UNINSTALL = 6;

function install() {}

async function startup({ id, version, rootURI }) {
	for (let file of ['model.js', 'store.js', 'controller.js', 'plugin.js']) {
		Services.scriptloader.loadSubScript(rootURI + 'content/' + file);
	}
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
			Zotero.Prefs.clear('extensions.zotero-tab-groups.groups', true);
		}
		catch (e) {
			// ignore
		}
	}
}
