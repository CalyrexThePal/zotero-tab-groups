/*
 * Tab Groups for Zotero — per-window controller.
 *
 * Zotero 10 renders its tab strip with React (components/tabBar.jsx) from
 * the state in `Zotero_Tabs._tabs`. Rather than replacing that component,
 * the plugin:
 *
 *   - keeps group membership in each tab's `data.tabGroupId` (saved and
 *     restored by Zotero's session code together with the tabs),
 *   - hooks `Zotero_Tabs._update()` to enforce Chrome's membership rules
 *     before every render (this file),
 *   - decorates the rendered strip after every React commit (decorate.ts),
 *   - replaces Zotero's HTML5 tab dragging with pointer-driven dragging that
 *     understands groups (drag.ts),
 *   - shows a Chrome-like editor bubble (editor.ts).
 *
 * This class wires those parts together and holds the group actions. All
 * contact with Zotero_Tabs goes through zoteroTabs.ts. Everything
 * environment-specific arrives through `deps`, so the same code runs inside
 * Zotero and in the browser test harness.
 */

import * as Model from './model';
import type { Store } from './store';
import { LIBRARY_TAB_ID, ZoteroTabsAdapter } from './zoteroTabs';
import type { ZoteroTab, ZoteroTabsLike } from './zoteroTabs';
import { Decorator } from './decorate';
import { DragController } from './drag';
import { EditorBubble } from './editor';
import type { EditorOptions } from './editor';

const PENDING_JOIN_TTL_MS = 15000;

export type ZoteroWindow = Window & typeof globalThis & { Zotero_Tabs: ZoteroTabsLike };

export interface ControllerDeps {
	store: Store;
	/** Localized string */
	t: (id: string, args?: Record<string, unknown>) => string;
	/** Ask Zotero to persist the tab session */
	saveSession?: () => void;
	log?: (msg: string) => void;
	logError?: (e: unknown) => void;
	/** Whether another window still has tabs in the group */
	isGroupUsedElsewhere?: (groupId: string, self: WindowController) => boolean;
}

interface PendingJoin {
	itemID: number;
	groupId: string;
	expires: number;
}

export class WindowController {
	readonly win: ZoteroWindow;
	readonly doc: Document;
	readonly store: Store;
	readonly t: ControllerDeps['t'];
	readonly zt: ZoteroTabsAdapter;
	readonly decorator: Decorator;
	readonly drag: DragController;
	readonly editor: EditorBubble;
	container!: HTMLElement;

	/** Set while a click should be ignored (it ended a drag or closed the editor) */
	suppressClick = false;
	/** Tab id under the last right-click, for the context menu */
	lastContextTabId: string | null = null;

	private deps: ControllerDeps;
	private knownTabIds = new Set<string>();
	private pendingJoins: PendingJoin[] = [];
	private prevOrder: string[] = [];
	private batchDepth = 0;
	private lastTabCount = 0;
	private purgeTimer: number | null = null;
	private timers = new Set<number>();
	private unsubscribe: (() => void) | null = null;

	constructor(win: ZoteroWindow, deps: ControllerDeps) {
		this.win = win;
		this.doc = win.document;
		this.deps = deps;
		this.store = deps.store;
		this.t = deps.t;
		this.zt = new ZoteroTabsAdapter(win.Zotero_Tabs, e => this.logError(e));
		this.decorator = new Decorator(this);
		this.drag = new DragController(this);
		this.editor = new EditorBubble(this);
	}

	// ------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------

	init(): void {
		let container = this.doc.getElementById('tab-bar-container');
		if (!container || !this.win.Zotero_Tabs) {
			throw new Error('Tab Groups: tab bar not found');
		}
		this.container = container;

		this.zt.install({
			beforeUpdate: () => this.beforeUpdate(),
			selectAdjacent: (direction, options) => this.selectAdjacent(direction, options),
			beforeClose: ids => this.beforeClose(ids),
			moveFocus: direction => this.moveFocus(direction),
			onTabHook: (action, tab) => this.onTabHook(action, tab),
		});

		this.decorator.connect();
		container.addEventListener('pointerdown', this.drag.onPointerDown);
		container.addEventListener('mousedown', this.onMouseDown, true);
		container.addEventListener('dragstart', this.onDragStart, true);
		container.addEventListener('click', this.onClick, true);
		container.addEventListener('contextmenu', this.onContextMenu, true);
		container.addEventListener('keydown', this.onKeyDown);

		this.unsubscribe = this.store.subscribe(() => this.decorator.decorate());

		for (let tab of this.tabList()) this.knownTabIds.add(tab.id);
		this.prevOrder = this.tabList().map(t => t.id);
		this.lastTabCount = this.tabList().length;
		this.refresh();
		// Zotero restores the previous session asynchronously; once that has
		// certainly happened, drop groups whose tabs no longer exist
		this.setTimeout(() => this.purgeEmptyGroups(), 60000);
	}

	destroy(): void {
		this.drag.cancel(false);
		this.closeEditor();
		for (let timer of this.timers) this.win.clearTimeout(timer);
		this.timers.clear();
		this.decorator.disconnect();
		if (this.unsubscribe) this.unsubscribe();
		let container = this.container;
		if (container) {
			container.removeEventListener('pointerdown', this.drag.onPointerDown);
			container.removeEventListener('mousedown', this.onMouseDown, true);
			container.removeEventListener('dragstart', this.onDragStart, true);
			container.removeEventListener('click', this.onClick, true);
			container.removeEventListener('contextmenu', this.onContextMenu, true);
			container.removeEventListener('keydown', this.onKeyDown);
		}
		this.zt.uninstall();
		if (container) this.decorator.removeDecorations();
		// Let Zotero re-render without our hooks
		try {
			this.zt.update();
		}
		catch (e) {
			this.logError(e);
		}
	}

	/** Re-run normalization and redraw everything */
	refresh(): void {
		try {
			this.zt.update();
		}
		catch (e) {
			this.logError(e);
		}
		this.decorator.decorate();
	}

	// ------------------------------------------------------------------
	// Utilities (shared with decorate.ts, drag.ts, editor.ts)
	// ------------------------------------------------------------------

	log(msg: string): void {
		if (this.deps.log) this.deps.log(msg);
	}

	logError(e: unknown): void {
		if (this.deps.logError) this.deps.logError(e);
		else if (this.win.console) this.win.console.error(e);
	}

	/** A window timeout that destroy() cancels */
	setTimeout(fn: () => void, ms: number): number {
		let id = this.win.setTimeout(() => {
			this.timers.delete(id);
			fn();
		}, ms);
		this.timers.add(id);
		return id;
	}

	saveSession(): void {
		if (!this.deps.saveSession) return;
		try {
			this.deps.saveSession();
		}
		catch (e) {
			this.logError(e);
		}
	}

	isRTL(el: Element): boolean {
		return this.win.getComputedStyle(el).direction === 'rtl';
	}

	/** The chip an event happened on, if any */
	headerFromEvent(e: Event): HTMLElement | null {
		let target = e.target as Element | null;
		let el = target && target.closest ? target.closest<HTMLElement>('.ztg-header') : null;
		return el && this.container.contains(el) ? el : null;
	}

	/**
	 * Run several model changes without re-normalizing in between, then
	 * normalize and render once.
	 */
	batch(fn: () => void): void {
		this.batchDepth++;
		try {
			fn();
		}
		finally {
			this.batchDepth--;
		}
		if (!this.batchDepth) this.zt.update();
	}

	// ------------------------------------------------------------------
	// Tab and group queries
	// ------------------------------------------------------------------

	/** Tabs excluding the Library tab, in strip order */
	tabList(): ZoteroTab[] {
		return this.zt.list();
	}

	getTab(id: string | null | undefined): ZoteroTab | null {
		return this.zt.getTab(id);
	}

	/** Group id stored on the tab, even if the group is unknown to the store */
	rawGroupOf(tab: ZoteroTab | null | undefined): string | null {
		return this.zt.rawGroupOf(tab);
	}

	/** Group id of a tab, or null */
	groupOf(tabId: string): string | null {
		let gid = this.zt.rawGroupOf(this.getTab(tabId));
		return gid && this.store.has(gid) ? gid : null;
	}

	/** Tabs of a group, in strip order */
	members(groupId: string): ZoteroTab[] {
		return this.tabList().filter(t => this.zt.rawGroupOf(t) === groupId);
	}

	isHidden(tab: ZoteroTab | null | undefined): boolean {
		let gid = this.zt.rawGroupOf(tab);
		let g = gid && this.store.get(gid);
		return !!(g && g.collapsed);
	}

	// ------------------------------------------------------------------
	// Model maintenance (runs before every Zotero_Tabs render)
	// ------------------------------------------------------------------

	private beforeUpdate(): void {
		if (this.batchDepth) return;
		try {
			this.normalize();
		}
		catch (e) {
			this.logError(e);
		}
	}

	private onTabHook(action: 'duplicate' | 'undoClose', tab: ZoteroTab): void {
		let groupId = action === 'duplicate'
			? this.groupOf(tab.id)
			: tab && tab.data && tab.data.tabGroupId;
		let itemID = tab && tab.data && tab.data.itemID;
		if (groupId && itemID) {
			this.pendingJoins.push({ itemID, groupId, expires: Date.now() + PENDING_JOIN_TTL_MS });
		}
	}

	private normalize(): void {
		let tabs = this.tabList();
		let changed = false;

		// New tabs: apply pending joins (duplicated / reopened tabs)
		let now = Date.now();
		this.pendingJoins = this.pendingJoins.filter(p => p.expires > now);
		let seen = new Set<string>();
		for (let tab of tabs) {
			seen.add(tab.id);
			if (this.knownTabIds.has(tab.id)) continue;
			let itemID = tab.data && tab.data.itemID;
			let i = itemID ? this.pendingJoins.findIndex(p => p.itemID === itemID) : -1;
			if (i !== -1) {
				let { groupId } = this.pendingJoins[i];
				this.pendingJoins.splice(i, 1);
				if (this.store.has(groupId) || this.store.resurrect(groupId)) {
					changed = this.zt.setRawGroup(tab, groupId) || changed;
				}
			}
		}
		this.knownTabIds = seen;

		// Tabs restored with a group that was removed earlier this session
		for (let tab of tabs) {
			let gid = this.zt.rawGroupOf(tab);
			if (gid && !this.store.has(gid)) this.store.resurrect(gid);
		}

		let order = tabs.map(t => t.id);
		let moved = Model.changedSince(this.prevOrder, order);
		this.prevOrder = order;
		let before = tabs.map(t => this.zt.rawGroupOf(t));
		let after = Model.normalize(before, gid => this.store.has(gid), moved);
		for (let i = 0; i < tabs.length; i++) {
			if (before[i] !== after[i]) {
				changed = this.zt.setRawGroup(tabs[i], after[i]) || changed;
				// A tab that lands inside a collapsed group expands it (Chrome)
				let g = after[i] && this.store.get(after[i]);
				if (g && g.collapsed) this.store.update(g.id, { collapsed: false });
			}
		}

		// Selecting a tab of a collapsed group expands the group (Chrome)
		let selected = this.getTab(this.zt.selectedId);
		let selectedGroup = this.store.get(this.zt.rawGroupOf(selected));
		if (selectedGroup && selectedGroup.collapsed) {
			this.store.update(selectedGroup.id, { collapsed: false });
		}

		if (tabs.length < this.lastTabCount) this.schedulePurge();
		this.lastTabCount = tabs.length;

		if (changed) this.saveSession();
		this.decorator.queueDecorate();
	}

	private schedulePurge(): void {
		if (this.purgeTimer) return;
		this.purgeTimer = this.setTimeout(() => {
			this.purgeTimer = null;
			this.purgeEmptyGroups();
		}, 400);
	}

	/** Delete groups that no longer have any tab (Chrome removes empty groups) */
	purgeEmptyGroups(): void {
		let used = new Set(this.tabList().map(t => this.zt.rawGroupOf(t)).filter(Boolean));
		for (let g of this.store.all()) {
			if (!used.has(g.id) && !(this.deps.isGroupUsedElsewhere && this.deps.isGroupUsedElsewhere(g.id, this))) {
				this.store.remove(g.id);
			}
		}
	}

	private selectAdjacent(direction: 1 | -1, options?: object): void {
		let all = this.zt.all();
		let index = all.findIndex(t => t.id === this.zt.selectedId);
		let n = all.length;
		for (let step = 1; step <= n; step++) {
			let tab = all[(((index + direction * step) % n) + n) % n];
			if (!this.isHidden(tab)) {
				this.zt.select(tab.id, false, options || {});
				return;
			}
		}
	}

	private beforeClose(ids?: string | string[]): void {
		let selectedID = this.zt.selectedId;
		let list = !ids ? [selectedID] : (Array.isArray(ids) ? ids : [ids]);
		if (!list.includes(selectedID)) return;
		let all = this.zt.all();
		let ok = (t: ZoteroTab | null | undefined) => !!t && !list.includes(t.id) && !this.isHidden(t);
		let prev = this.zt.prevSelectedId ? this.getTab(this.zt.prevSelectedId) : null;
		if (prev && !list.includes(prev.id)) {
			if (ok(prev)) return;
		}
		else {
			// Zotero would pick the next tab to the right, then to the left
			let index = all.findIndex(t => t.id === selectedID);
			let fallback = all.slice(index + 1).concat(all.slice(0, index).reverse())
				.find(t => !list.includes(t.id));
			if (!fallback || ok(fallback)) return;
		}
		let index = all.findIndex(t => t.id === selectedID);
		let pick = all.slice(index + 1).concat(all.slice(0, index).reverse()).find(ok);
		if (pick) this.zt.prevSelectedId = pick.id;
	}

	/** @returns whether focus was handled */
	private moveFocus(direction: 'next' | 'previous'): boolean {
		if (!this.decorator.headers.size) return false;
		let items = this.decorator.focusableItems();
		let active = this.doc.activeElement as HTMLElement | null;
		let index = active ? items.indexOf(active) : -1;
		if (index === -1) {
			let id = active && active.getAttribute && active.getAttribute('data-id');
			if (!id || !this.getTab(id)) id = this.zt.selectedId;
			index = items.findIndex(el => el.classList.contains('tab') && el.getAttribute('data-id') === id);
			if (index === -1 && id === LIBRARY_TAB_ID) index = 0;
		}
		if (index === -1) return false;
		let target = items[index + (direction === 'next' ? 1 : -1)];
		if (!target) return true;
		this.focusItem(target);
		return true;
	}

	private focusItem(target: HTMLElement): void {
		if (target.getAttribute('data-id') === LIBRARY_TAB_ID) {
			// Zotero knows which of its two Library tab nodes is visible
			this.zt.moveFocus('first');
		}
		else {
			target.focus();
		}
	}

	// ------------------------------------------------------------------
	// Group actions
	// ------------------------------------------------------------------

	/** Create a new group containing `tabId` and open its editor */
	addTabToNewGroup(tabId: string, { openEditor = true }: { openEditor?: boolean } = {}): string | null {
		let tab = this.getTab(tabId);
		if (!tab || tab.id === LIBRARY_TAB_ID) return null;
		// Like Chrome, pick the least-used color among groups on the strip
		let inUse = new Set(this.tabList().map(t => this.zt.rawGroupOf(t)).filter(Boolean));
		let group = this.store.create({
			color: Model.pickColor(this.store.all().filter(g => inUse.has(g.id)).map(g => g.color)),
		});
		this.batch(() => {
			let current = this.groupOf(tabId);
			if (current) this.moveOutOfMiddle(tab!, current);
			this.zt.setRawGroup(tab, group.id);
		});
		this.saveSession();
		this.decorator.decorate();
		if (openEditor) this.openEditor(group.id, { isNew: true });
		return group.id;
	}

	/** Add (or move) a tab to the end of an existing group */
	addTabToGroup(tabId: string, groupId: string): void {
		let tab = this.getTab(tabId);
		if (!tab || tab.id === LIBRARY_TAB_ID || !this.store.has(groupId)) return;
		if (this.groupOf(tabId) === groupId) return;
		this.batch(() => {
			let anchor = this.zt.tabAfterGroup(groupId, tabId);
			this.zt.setRawGroup(tab, groupId);
			if (anchor !== undefined) this.zt.moveBefore([tabId], anchor);
		});
		this.saveSession();
		this.decorator.decorate();
	}

	/** Take a tab out of its group, placing it right after the group if needed */
	removeTabFromGroup(tabId: string): void {
		let tab = this.getTab(tabId);
		let groupId = this.groupOf(tabId);
		if (!tab || !groupId) return;
		this.batch(() => {
			this.moveOutOfMiddle(tab!, groupId!);
			this.zt.setRawGroup(tab, null);
		});
		this.saveSession();
		this.purgeEmptyGroups();
		this.decorator.decorate();
	}

	/** If the tab is not at either end of its group, move it right after the group */
	private moveOutOfMiddle(tab: ZoteroTab, groupId: string): void {
		let members = this.members(groupId);
		let isEdge = members[0] === tab || members[members.length - 1] === tab;
		if (!isEdge) this.zt.moveBefore([tab.id], this.zt.tabAfterGroup(groupId, tab.id) ?? null);
	}

	/** Dissolve a group, keeping its tabs open */
	ungroup(groupId: string): void {
		if (!this.store.has(groupId)) return;
		this.closeEditor();
		this.batch(() => {
			for (let tab of this.members(groupId)) this.zt.setRawGroup(tab, null);
		});
		this.store.remove(groupId);
		this.saveSession();
		this.decorator.decorate();
	}

	/** Close every tab in a group (Undo Close Tab brings the group back) */
	closeGroup(groupId: string): void {
		if (!this.store.has(groupId)) return;
		this.closeEditor();
		let ids = this.members(groupId).map(t => t.id);
		if (ids.length) this.zt.close(ids);
		this.store.remove(groupId);
		this.decorator.decorate();
	}

	toggleCollapsed(groupId: string, force?: boolean): void {
		let group = this.store.get(groupId);
		if (!group) return;
		let collapse = force === undefined ? !group.collapsed : !!force;
		if (collapse === group.collapsed) return;
		if (collapse) {
			// Chrome moves the selection out of a group that is being collapsed
			let selected = this.getTab(this.zt.selectedId);
			if (selected && this.zt.rawGroupOf(selected) === groupId) {
				let next = this.nearestVisibleOutside(groupId);
				if (next) this.zt.select(next.id);
			}
		}
		this.store.update(groupId, { collapsed: collapse });
		this.decorator.decorate();
		this.decorator.refreshTabBarSoon();
	}

	private nearestVisibleOutside(groupId: string): ZoteroTab | null {
		let all = this.zt.all();
		let indices: number[] = [];
		all.forEach((t, i) => {
			if (this.zt.rawGroupOf(t) === groupId) indices.push(i);
		});
		if (!indices.length) return null;
		let ok = (t: ZoteroTab | undefined) => !!t && this.zt.rawGroupOf(t) !== groupId && !this.isHidden(t);
		for (let i = indices[indices.length - 1] + 1; i < all.length; i++) {
			if (ok(all[i])) return all[i];
		}
		for (let i = indices[0] - 1; i >= 0; i--) {
			if (ok(all[i])) return all[i];
		}
		return all[0];
	}

	openEditor(groupId: string, options?: EditorOptions): void {
		this.editor.open(groupId, options);
	}

	closeEditor(): void {
		this.editor.close();
	}

	// ------------------------------------------------------------------
	// Events on the strip
	// ------------------------------------------------------------------

	private onMouseDown = (e: MouseEvent): void => {
		// Clicking a chip must not move keyboard focus to it (Zotero would
		// remember it as the Library tab's last focused element)
		if (this.headerFromEvent(e)) e.preventDefault();
	};

	private onDragStart = (e: DragEvent): void => {
		// Zotero's native HTML5 tab dragging is replaced by our pointer-based one.
		// Gecko reports the drag source as the text node when a drag starts
		// on a tab's title, and a text node has no closest(), so resolve it
		// to its element first. Missing this lets the native drag run, which
		// cancels our pointer events (pointercancel) and the drag never starts.
		let strip = this.decorator.getStrip();
		let node = e.target as Node | null;
		let el = node && node.nodeType === 1 ? node as Element : (node && node.parentElement);
		if (strip && el && strip.contains(el) && el.closest('.tab, .ztg-header')) {
			e.preventDefault();
			e.stopPropagation();
		}
	};

	private onClick = (e: MouseEvent): void => {
		let header = this.headerFromEvent(e);
		if (!header) return;
		e.stopPropagation();
		if (e.button !== 0 || this.suppressClick) return;
		this.toggleCollapsed(header.getAttribute('data-ztg-group-id')!);
	};

	private onContextMenu = (e: MouseEvent): void => {
		let header = this.headerFromEvent(e);
		if (header) {
			e.preventDefault();
			e.stopPropagation();
			this.openEditor(header.getAttribute('data-ztg-group-id')!);
			return;
		}
		let target = e.target as Element | null;
		let tabEl = target && target.closest ? target.closest('.tab[data-id]') : null;
		this.lastContextTabId = tabEl ? tabEl.getAttribute('data-id') : null;
	};

	private onKeyDown = (e: KeyboardEvent): void => {
		let header = this.headerFromEvent(e);
		if (!header) return;
		let gid = header.getAttribute('data-ztg-group-id')!;
		let rtl = this.isRTL((header.parentNode as Element) || header);
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			this.toggleCollapsed(gid);
		}
		else if (e.key === 'ContextMenu' || e.key === 'F2' || (e.key === 'F10' && e.shiftKey)) {
			e.preventDefault();
			this.openEditor(gid, { fromKeyboard: true });
		}
		else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
			e.preventDefault();
			let forward = (e.key === 'ArrowRight') !== rtl;
			let items = this.decorator.focusableItems();
			let target = items[items.indexOf(header) + (forward ? 1 : -1)];
			if (target) this.focusItem(target);
		}
	};
}
