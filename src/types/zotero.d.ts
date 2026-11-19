/*
 * The small part of Zotero's privileged API surface this plugin uses.
 * Zotero ships no type definitions; extend this as the plugin needs more.
 */

interface ZoteroMenuContext {
	menuElem?: Element & { ownerGlobal?: unknown };
	tabID?: string;
	setVisible(visible: boolean): void;
}

interface ZoteroMenuSpec {
	menuType: 'separator' | 'menuitem' | 'submenu';
	l10nID?: string;
	menus?: ZoteroMenuSpec[];
	onShowing?: (ev: Event, ctx: ZoteroMenuContext) => void;
	onCommand?: (ev: Event, ctx: ZoteroMenuContext) => void;
}

declare const Zotero: {
	debug(msg: string): void;
	logError(e: unknown): void;
	getMainWindows(): any[];
	Prefs: {
		get(pref: string, global?: boolean): string | undefined;
		set(pref: string, value: string, global?: boolean): void;
		clear(pref: string, global?: boolean): void;
	};
	Session: { debounceSave(): void };
	MenuManager?: {
		registerMenu(spec: {
			menuID: string;
			pluginID: string;
			target: string;
			menus: ZoteroMenuSpec[];
		}): string | false | undefined;
		unregisterMenu(menuID: string): void;
	};
};
