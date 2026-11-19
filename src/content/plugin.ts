/*
 * Tab Groups for Zotero — plugin entry object.
 *
 * Owns the shared group store, the tab context-menu entries (menu.ts) and
 * one WindowController per main window. bootstrap.js drives its lifecycle.
 */

import { Store } from './store';
import { WindowController } from './controller';
import type { ZoteroWindow } from './controller';
import { registerMenus, unregisterMenus } from './menu';

export const PREF_GROUPS = 'extensions.zotero-tab-groups.groups';
const FTL = 'zotero-tab-groups.ftl';
const STYLESHEET_ID = 'zotero-tab-groups-stylesheet';

export class TabGroupsPlugin {
	id: string | null = null;
	version: string | null = null;
	rootURI = '';
	store!: Store;
	private controllers = new Map<unknown, WindowController>();
	private menuID: string | null = null;

	log(msg: string): void {
		Zotero.debug('Tab Groups: ' + msg);
	}

	init({ id, version, rootURI }: { id: string; version: string; rootURI: string }): void {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.store = new Store({
			read: () => Zotero.Prefs.get(PREF_GROUPS, true) || '{}',
			write: json => Zotero.Prefs.set(PREF_GROUPS, json, true),
		});
		this.menuID = registerMenus({
			id,
			store: this.store,
			controllerFor: win => this.controllers.get(win),
			log: msg => this.log(msg),
		});
		this.log(`started ${version}`);
	}

	shutdown(): void {
		this.removeFromAllWindows();
		if (this.menuID) {
			try {
				unregisterMenus(this.menuID);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		this.menuID = null;
		if (this.store) this.store.flush();
	}

	/** Flush pending writes without tearing down the UI (app quit) */
	flush(): void {
		if (this.store) this.store.flush();
	}

	addToAllWindows(): void {
		for (let win of Zotero.getMainWindows()) {
			if (!win.ZoteroPane) continue;
			this.addToWindow(win);
		}
	}

	removeFromAllWindows(): void {
		for (let win of [...this.controllers.keys()]) {
			this.removeFromWindow(win as ZoteroWindow);
		}
	}

	addToWindow(win: ZoteroWindow & { MozXULElement: any; Localization: any }): void {
		if (this.controllers.has(win)) return;
		let doc = win.document;

		if (!doc.getElementById(STYLESHEET_ID)) {
			let link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
			link.id = STYLESHEET_ID;
			link.setAttribute('rel', 'stylesheet');
			link.setAttribute('type', 'text/css');
			link.setAttribute('href', this.rootURI + 'content/tabGroups.css');
			doc.documentElement.appendChild(link);
		}
		// Needed for the l10n IDs used by the context menu entries
		win.MozXULElement.insertFTLIfNeeded(FTL);

		let l10n: any = null;
		try {
			l10n = new win.Localization([FTL], true);
		}
		catch (e) {
			Zotero.logError(e);
		}
		let t = (id: string, args?: Record<string, unknown>): string => {
			try {
				return (l10n && l10n.formatValueSync(id, args)) || id;
			}
			catch (e) {
				return id;
			}
		};

		let controller = new WindowController(win, {
			store: this.store,
			t,
			saveSession: () => Zotero.Session.debounceSave(),
			log: msg => this.log(msg),
			logError: e => Zotero.logError(e),
			isGroupUsedElsewhere: (groupId, self) => [...this.controllers.values()].some(
				c => c !== self && c.members(groupId).length > 0
			),
		});
		try {
			controller.init();
			this.controllers.set(win, controller);
		}
		catch (e) {
			Zotero.logError(e);
		}
	}

	removeFromWindow(win: ZoteroWindow): void {
		let controller = this.controllers.get(win);
		this.controllers.delete(win);
		if (controller) {
			try {
				controller.destroy();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		let doc = win.document;
		let link = doc.getElementById(STYLESHEET_ID);
		if (link) link.remove();
		let ftl = doc.querySelector(`link[rel="localization"][href="${FTL}"]`);
		if (ftl) ftl.remove();
	}
}
