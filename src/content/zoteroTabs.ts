/*
 * Tab Groups for Zotero — adapter for Zotero_Tabs.
 *
 * Zotero_Tabs (chrome/content/zotero/tabs.js) is not public API. Everything
 * the plugin needs from its internals lives in this file and nowhere else:
 *
 *   - private state:     _tabs, _selectedID, _prevSelectedID, _update()
 *   - patched methods:   _update, selectNext, selectPrev, close, moveFocus
 *   - patched hooks:     tabHooks.duplicate.*, tabHooks.undoClose.*
 *   - tab session data:  tab.data.tabGroupId (saved by Zotero's session code)
 *
 * When a new Zotero version changes tabs.js, this is the file to adjust.
 */

export const LIBRARY_TAB_ID = 'zotero-pane';

export interface ZoteroTab {
	id: string;
	type?: string;
	data?: { tabGroupId?: string; itemID?: number; [key: string]: unknown };
	[key: string]: unknown;
}

export interface ZoteroTabsLike {
	_tabs: ZoteroTab[];
	_selectedID: string;
	_prevSelectedID?: string | null;
	_update(): void;
	select(id: string, reopening?: boolean, options?: object): void;
	selectNext(options?: object): void;
	selectPrev(options?: object): void;
	close(ids?: string | string[]): void;
	move(id: string, index: number): void;
	moveFocus(direction: string): void;
	refocus?(): void;
	tabHooks?: Record<string, Record<string, (tab: ZoteroTab, tabIndex?: number) => unknown> | undefined>;
}

/** Behavior the plugin splices into Zotero_Tabs */
export interface TabsHooks {
	/** Runs before every Zotero_Tabs._update() render */
	beforeUpdate(): void;
	/** Replaces selectNext (1) / selectPrev (-1) */
	selectAdjacent(direction: 1 | -1, options?: object): void;
	/** Runs before Zotero_Tabs.close() */
	beforeClose(ids?: string | string[]): void;
	/** Ctrl/Cmd+Arrow focus; return true if handled */
	moveFocus(direction: 'next' | 'previous'): boolean;
	/** A tab is about to be duplicated or reopened via Undo Close Tab */
	onTabHook(action: 'duplicate' | 'undoClose', tab: ZoteroTab): void;
}

export class ZoteroTabsAdapter {
	private restorers: Array<() => void> = [];

	constructor(
		private raw: ZoteroTabsLike,
		private onError: (e: unknown) => void,
	) {}

	// ------------------------------------------------------------------
	// Reading the tab list
	// ------------------------------------------------------------------

	/** Every tab, Library included */
	all(): ZoteroTab[] {
		return this.raw._tabs || [];
	}

	/** Tabs the plugin manages: everything except the Library tab */
	list(): ZoteroTab[] {
		return this.all().slice(1);
	}

	getTab(id: string | null | undefined): ZoteroTab | null {
		return id ? this.all().find(t => t.id === id) || null : null;
	}

	get selectedId(): string {
		return this.raw._selectedID;
	}

	get prevSelectedId(): string | null | undefined {
		return this.raw._prevSelectedID;
	}

	set prevSelectedId(id: string | null | undefined) {
		this.raw._prevSelectedID = id;
	}

	// ------------------------------------------------------------------
	// Group membership (stored in tab.data so Zotero saves it with the session)
	// ------------------------------------------------------------------

	rawGroupOf(tab: ZoteroTab | null | undefined): string | null {
		return (tab && tab.data && tab.data.tabGroupId) || null;
	}

	/** @returns whether the membership changed */
	setRawGroup(tab: ZoteroTab | null | undefined, groupId: string | null): boolean {
		if (!tab || tab.id === LIBRARY_TAB_ID) return false;
		if (this.rawGroupOf(tab) === (groupId || null)) return false;
		if (!tab.data) tab.data = {};
		if (groupId) tab.data.tabGroupId = groupId;
		else delete tab.data.tabGroupId;
		return true;
	}

	// ------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------

	update(): void {
		this.raw._update();
	}

	select(id: string, reopening = false, options: object = {}): void {
		this.raw.select(id, reopening, options);
	}

	close(ids?: string | string[]): void {
		this.raw.close(ids);
	}

	moveFocus(direction: string): void {
		this.raw.moveFocus(direction);
	}

	refocus(): void {
		if (typeof this.raw.refocus === 'function') this.raw.refocus();
	}

	/**
	 * Move tabs (keeping their relative order) so they sit right before
	 * `beforeId` (or at the end if null). Uses Zotero's own move().
	 */
	moveBefore(ids: string[], beforeId: string | null): void {
		for (let id of ids) {
			let all = this.all();
			let index = beforeId ? all.findIndex(t => t.id === beforeId) : all.length;
			if (index < 1) index = all.length;
			this.raw.move(id, index);
		}
	}

	/**
	 * Id of the tab right after the group (ignoring `exceptId`), null if the
	 * group is last, undefined if the group has no tabs.
	 */
	tabAfterGroup(groupId: string, exceptId?: string): string | null | undefined {
		let all = this.all();
		let lastIndex = -1;
		all.forEach((t, i) => {
			if (t.id !== exceptId && this.rawGroupOf(t) === groupId) lastIndex = i;
		});
		if (lastIndex === -1) return undefined;
		for (let i = lastIndex + 1; i < all.length; i++) {
			if (all[i].id !== exceptId) return all[i].id;
		}
		return null;
	}

	// ------------------------------------------------------------------
	// Patching
	// ------------------------------------------------------------------

	/**
	 * Replace obj[name] with a wrapper and remember how to undo it. If
	 * someone else wraps the method after us, we can't unwrap cleanly, so
	 * the wrapper turns itself into a pass-through instead.
	 */
	private patch(obj: any, name: string, makeWrapper: (orig: Function) => Function): void {
		let orig = obj[name];
		if (typeof orig !== 'function') return;
		let active = true;
		let wrapper = makeWrapper(orig);
		let guarded = function (this: unknown, ...args: unknown[]) {
			if (!active) return orig.apply(this, args);
			return wrapper.apply(this, args);
		};
		obj[name] = guarded;
		this.restorers.push(() => {
			active = false;
			if (obj[name] === guarded) obj[name] = orig;
		});
	}

	install(hooks: TabsHooks): void {
		let raw = this.raw;
		let onError = this.onError;
		this.patch(raw, '_update', orig => function (this: unknown, ...args: unknown[]) {
			hooks.beforeUpdate();
			return orig.apply(this, args);
		});
		this.patch(raw, 'selectNext', () => (options?: object) => hooks.selectAdjacent(1, options));
		this.patch(raw, 'selectPrev', () => (options?: object) => hooks.selectAdjacent(-1, options));
		// Closing the selected tab must not land on a tab hidden in a
		// collapsed group (that would pop the group open)
		this.patch(raw, 'close', orig => function (this: unknown, ids?: string | string[]) {
			try {
				hooks.beforeClose(ids);
			}
			catch (e) {
				onError(e);
			}
			return orig.call(this, ids);
		});
		// Ctrl/Cmd+Arrow keyboard focus: skip hidden tabs, stop on group chips
		this.patch(raw, 'moveFocus', orig => function (this: unknown, direction: string) {
			if ((direction === 'next' || direction === 'previous') && hooks.moveFocus(direction)) {
				return undefined;
			}
			return orig.call(this, direction);
		});

		let tabHooks = raw.tabHooks;
		if (!tabHooks) return;
		for (let action of ['duplicate', 'undoClose'] as const) {
			let table = tabHooks[action];
			if (!table) continue;
			for (let type of Object.keys(table)) {
				this.patch(table, type, orig => function (this: unknown, tab: ZoteroTab, tabIndex?: number) {
					try {
						hooks.onTabHook(action, tab);
					}
					catch (e) {
						onError(e);
					}
					return orig.call(this, tab, tabIndex);
				});
			}
		}
	}

	/** Undo everything install() did */
	uninstall(): void {
		for (let restore of this.restorers.reverse()) {
			try {
				restore();
			}
			catch (e) {
				this.onError(e);
			}
		}
		this.restorers = [];
	}
}
