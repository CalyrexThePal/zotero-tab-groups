/*
 * Tab Groups for Zotero — per-window controller.
 *
 * Zotero 10 renders its tab strip with React (components/tabBar.jsx) from
 * the state in `Zotero_Tabs._tabs`. Rather than replacing that component,
 * this controller:
 *
 *   - keeps group membership in each tab's `data.tabGroupId` (saved and
 *     restored by Zotero's session code together with the tabs),
 *   - hooks `Zotero_Tabs._update()` to enforce Chrome's membership rules
 *     before every render,
 *   - decorates the rendered strip after every React commit: inserts a
 *     group "chip" before each group's first tab, colors member tabs, and
 *     hides tabs of collapsed groups (with CSS transitions),
 *   - replaces Zotero's HTML5 tab dragging with pointer-driven dragging that
 *     understands groups (drag a tab into/out of a group, drag a chip to move
 *     the whole group),
 *   - shows a Chrome-like editor bubble (name, color, ungroup, close).
 *
 * The class receives everything environment-specific through `deps`, so it
 * can run unmodified inside Zotero and in the browser test harness.
 */

/* global ZTG_Model */
/* exported ZTG_WindowController */

var ZTG_WindowController = (function () {
	'use strict';

	const HTML_NS = 'http://www.w3.org/1999/xhtml';
	const LIBRARY_TAB_ID = 'zotero-pane';
	const DRAG_THRESHOLD = 4;
	const AUTOSCROLL_ZONE = 28;
	const AUTOSCROLL_MAX_SPEED = 14;
	const COLLAPSE_ANIMATION_MS = 220;
	const PENDING_JOIN_TTL_MS = 15000;

	class WindowController {
		/**
		 * @param {Window} win
		 * @param {object} deps
		 * @param {ZTG_Store} deps.store
		 * @param {(id: string, args?: object) => string} deps.t localized string
		 * @param {() => void} [deps.saveSession] ask Zotero to persist tab session
		 * @param {(msg: string) => void} [deps.log]
		 * @param {(e: Error) => void} [deps.logError]
		 */
		constructor(win, deps) {
			this.win = win;
			this.doc = win.document;
			this.deps = deps;
			this.store = deps.store;
			this.t = deps.t;
			this.tabs = win.Zotero_Tabs;

			this._headers = new Map();
			this._knownTabIds = new Set();
			this._pendingJoins = [];
			this._batchDepth = 0;
			this._applying = false;
			this._pending = null;
			this._drag = null;
			this._suppressClick = false;
			this._editor = null;
			this._restorers = [];
			this._timers = new Set();
			this._lastTabCount = 0;
			this._commitWaiter = null;

			for (let name of [
				'_onMutations', '_onPointerDown', '_onPointerMove', '_onPointerUp',
				'_onDragStart', '_onMouseDown', '_onClick', '_onContextMenu', '_onKeyDown', '_onDragKeyDown',
				'_dragFrame', '_onEditorDocPointerDown', '_onEditorKeyDown', '_onWindowBlur',
			]) {
				this[name] = this[name].bind(this);
			}
		}

		// ------------------------------------------------------------------
		// Lifecycle
		// ------------------------------------------------------------------

		init() {
			this.container = this.doc.getElementById('tab-bar-container');
			if (!this.container || !this.tabs) {
				throw new Error('Tab Groups: tab bar not found');
			}

			let controller = this;
			this._patch(this.tabs, '_update', orig => function (...args) {
				controller._beforeUpdate();
				return orig.apply(this, args);
			});
			this._patch(this.tabs, 'selectNext', () => function (options) {
				controller._selectAdjacent(1, options);
			});
			this._patch(this.tabs, 'selectPrev', () => function (options) {
				controller._selectAdjacent(-1, options);
			});
			// Closing the selected tab must not land on a tab hidden in a
			// collapsed group (that would pop the group open)
			this._patch(this.tabs, 'close', orig => function (ids) {
				try {
					controller._beforeClose(ids);
				}
				catch (e) {
					controller._logError(e);
				}
				return orig.call(this, ids);
			});
			// Ctrl/Cmd+Arrow keyboard focus: skip hidden tabs, stop on group chips
			this._patch(this.tabs, 'moveFocus', orig => function (direction) {
				if ((direction === 'next' || direction === 'previous') && controller._moveFocus(direction)) {
					return undefined;
				}
				return orig.call(this, direction);
			});
			this._wrapTabHooks();

			this._observer = new this.win.MutationObserver(this._onMutations);
			this._observer.observe(this.container, { childList: true, subtree: true });

			this.container.addEventListener('pointerdown', this._onPointerDown);
			this.container.addEventListener('mousedown', this._onMouseDown, true);
			this.container.addEventListener('dragstart', this._onDragStart, true);
			this.container.addEventListener('click', this._onClick, true);
			this.container.addEventListener('contextmenu', this._onContextMenu, true);
			this.container.addEventListener('keydown', this._onKeyDown);

			this._unsubscribe = this.store.subscribe(() => this._decorate());

			for (let tab of this._tabList()) this._knownTabIds.add(tab.id);
			this._prevOrder = this._tabList().map(t => t.id);
			this._lastTabCount = this._tabList().length;
			this._seenEls = new WeakSet();
			this.refresh();
			// Zotero restores the previous session asynchronously; once that has
			// certainly happened, drop groups whose tabs no longer exist
			this._setTimeout(() => this.purgeEmptyGroups(), 60000);
		}

		destroy() {
			this._cancelDrag(false);
			this.closeEditor();
			for (let timer of this._timers) this.win.clearTimeout(timer);
			this._timers.clear();
			if (this._observer) this._observer.disconnect();
			if (this._unsubscribe) this._unsubscribe();
			if (this.container) {
				this.container.removeEventListener('pointerdown', this._onPointerDown);
				this.container.removeEventListener('mousedown', this._onMouseDown, true);
				this.container.removeEventListener('dragstart', this._onDragStart, true);
				this.container.removeEventListener('click', this._onClick, true);
				this.container.removeEventListener('contextmenu', this._onContextMenu, true);
				this.container.removeEventListener('keydown', this._onKeyDown);
			}
			for (let restore of this._restorers.reverse()) {
				try {
					restore();
				}
				catch (e) {
					this._logError(e);
				}
			}
			this._restorers = [];
			// Remove all decorations
			for (let header of this._headers.values()) header.remove();
			this._headers.clear();
			for (let el of this.container ? this.container.querySelectorAll('.tab') : []) {
				for (let attr of ['ztg-group', 'ztg-color', 'ztg-hidden', 'ztg-first', 'ztg-last', 'ztg-drag-unit', 'ztg-settling', 'ztg-instant']) {
					el.removeAttribute(attr);
				}
				if (el.getAttribute('draggable') === 'false') el.setAttribute('draggable', 'true');
				el.style.removeProperty('transform');
			}
			// Let Zotero re-render without our hooks
			try {
				this.tabs._update();
			}
			catch (e) {
				this._logError(e);
			}
		}

		/** Re-run normalization and redraw everything */
		refresh() {
			try {
				this.tabs._update();
			}
			catch (e) {
				this._logError(e);
			}
			this._decorate();
		}

		// ------------------------------------------------------------------
		// Utilities
		// ------------------------------------------------------------------

		_log(msg) {
			if (this.deps.log) this.deps.log(msg);
		}

		_logError(e) {
			if (this.deps.logError) this.deps.logError(e);
			else if (this.win.console) this.win.console.error(e);
		}

		_setTimeout(fn, ms) {
			let id = this.win.setTimeout(() => {
				this._timers.delete(id);
				fn();
			}, ms);
			this._timers.add(id);
			return id;
		}

		/**
		 * Replace obj[name] with a wrapper and remember how to undo it. If
		 * someone else wraps the method after us, we can't unwrap cleanly, so
		 * the wrapper turns itself into a pass-through instead.
		 */
		_patch(obj, name, makeWrapper) {
			let orig = obj[name];
			if (typeof orig !== 'function') return;
			let active = true;
			let wrapper = makeWrapper(orig);
			let guarded = function (...args) {
				if (!active) return orig.apply(this, args);
				return wrapper.apply(this, args);
			};
			obj[name] = guarded;
			this._restorers.push(() => {
				active = false;
				if (obj[name] === guarded) obj[name] = orig;
			});
		}

		_wrapTabHooks() {
			let hooks = this.tabs.tabHooks;
			if (!hooks) return;
			let controller = this;
			for (let action of ['duplicate', 'undoClose']) {
				if (!hooks[action]) continue;
				for (let type of Object.keys(hooks[action])) {
					this._patch(hooks[action], type, orig => function (tab, tabIndex) {
						try {
							let groupId = action === 'duplicate'
								? controller.groupOf(tab.id)
								: tab && tab.data && tab.data.tabGroupId;
							let itemID = tab && tab.data && tab.data.itemID;
							if (groupId && itemID) {
								controller._pendingJoins.push({ itemID, groupId, expires: Date.now() + PENDING_JOIN_TTL_MS });
							}
						}
						catch (e) {
							controller._logError(e);
						}
						return orig.call(this, tab, tabIndex);
					});
				}
			}
		}

		_tabList() {
			return (this.tabs._tabs || []).slice(1);
		}

		_getTab(id) {
			return (this.tabs._tabs || []).find(t => t.id === id) || null;
		}

		_rawGroupOf(tab) {
			return (tab && tab.data && tab.data.tabGroupId) || null;
		}

		/** Group id of a tab, or null */
		groupOf(tabId) {
			let tab = this._getTab(tabId);
			let gid = this._rawGroupOf(tab);
			return gid && this.store.has(gid) ? gid : null;
		}

		/** Tabs of a group, in strip order */
		members(groupId) {
			return this._tabList().filter(t => this._rawGroupOf(t) === groupId);
		}

		isHidden(tab) {
			let gid = this._rawGroupOf(tab);
			let g = gid && this.store.get(gid);
			return !!(g && g.collapsed);
		}

		_setRawGroup(tab, groupId) {
			if (!tab || tab.id === LIBRARY_TAB_ID) return false;
			if (this._rawGroupOf(tab) === (groupId || null)) return false;
			if (!tab.data) tab.data = {};
			if (groupId) tab.data.tabGroupId = groupId;
			else delete tab.data.tabGroupId;
			return true;
		}

		_saveSession() {
			if (this.deps.saveSession) {
				try {
					this.deps.saveSession();
				}
				catch (e) {
					this._logError(e);
				}
			}
		}

		/**
		 * Run several model changes without re-normalizing in between, then
		 * normalize and render once.
		 */
		_batch(fn) {
			this._batchDepth++;
			try {
				fn();
			}
			finally {
				this._batchDepth--;
			}
			if (!this._batchDepth) {
				this.tabs._update();
			}
		}

		/**
		 * Move tabs (keeping their relative order) so they sit right before
		 * `beforeId` (or at the end if null). Uses Zotero's own move().
		 */
		_moveTabsBefore(ids, beforeId) {
			for (let id of ids) {
				let all = this.tabs._tabs;
				let index = beforeId ? all.findIndex(t => t.id === beforeId) : all.length;
				if (index < 1) index = all.length;
				this.tabs.move(id, index);
			}
		}

		/** Id of the tab right after the group (ignoring `exceptId`), or null */
		_tabAfterGroup(groupId, exceptId) {
			let all = this.tabs._tabs;
			let lastIndex = -1;
			all.forEach((t, i) => {
				if (t.id !== exceptId && this._rawGroupOf(t) === groupId) lastIndex = i;
			});
			if (lastIndex === -1) return undefined;
			for (let i = lastIndex + 1; i < all.length; i++) {
				if (all[i].id !== exceptId) return all[i].id;
			}
			return null;
		}

		// ------------------------------------------------------------------
		// Model maintenance (runs before every Zotero_Tabs render)
		// ------------------------------------------------------------------

		_beforeUpdate() {
			if (this._batchDepth) return;
			try {
				this._normalize();
			}
			catch (e) {
				this._logError(e);
			}
		}

		_normalize() {
			let tabs = this._tabList();
			let changed = false;

			// New tabs: apply pending joins (duplicated / reopened tabs)
			let now = Date.now();
			this._pendingJoins = this._pendingJoins.filter(p => p.expires > now);
			let seen = new Set();
			for (let tab of tabs) {
				seen.add(tab.id);
				if (this._knownTabIds.has(tab.id)) continue;
				let itemID = tab.data && tab.data.itemID;
				let i = itemID ? this._pendingJoins.findIndex(p => p.itemID === itemID) : -1;
				if (i !== -1) {
					let { groupId } = this._pendingJoins[i];
					this._pendingJoins.splice(i, 1);
					if (this.store.has(groupId) || this.store.resurrect(groupId)) {
						changed = this._setRawGroup(tab, groupId) || changed;
					}
				}
			}
			this._knownTabIds = seen;

			// Tabs restored with a group that was removed earlier this session
			for (let tab of tabs) {
				let gid = this._rawGroupOf(tab);
				if (gid && !this.store.has(gid)) this.store.resurrect(gid);
			}

			let order = tabs.map(t => t.id);
			let moved = ZTG_Model.changedSince(this._prevOrder || order, order);
			this._prevOrder = order;
			let before = tabs.map(t => this._rawGroupOf(t));
			let after = ZTG_Model.normalize(before, gid => this.store.has(gid), moved);
			for (let i = 0; i < tabs.length; i++) {
				if (before[i] !== after[i]) {
					changed = this._setRawGroup(tabs[i], after[i]) || changed;
					// A tab that lands inside a collapsed group expands it (Chrome)
					let g = after[i] && this.store.get(after[i]);
					if (g && g.collapsed) this.store.update(g.id, { collapsed: false });
				}
			}

			// Selecting a tab of a collapsed group expands the group (Chrome)
			let selected = this._getTab(this.tabs._selectedID);
			let selectedGroup = this.store.get(this._rawGroupOf(selected));
			if (selectedGroup && selectedGroup.collapsed) {
				this.store.update(selectedGroup.id, { collapsed: false });
			}

			if (tabs.length < this._lastTabCount) {
				this._schedulePurge();
			}
			this._lastTabCount = tabs.length;

			if (changed) this._saveSession();
			// React may not touch the DOM (e.g. only membership changed), so
			// decorate now as well as after the next commit
			this._queueDecorate();
		}

		_queueDecorate() {
			if (this._decorateQueued) return;
			this._decorateQueued = true;
			Promise.resolve().then(() => {
				this._decorateQueued = false;
				this._decorate();
			});
		}

		_schedulePurge() {
			if (this._purgeTimer) return;
			this._purgeTimer = this._setTimeout(() => {
				this._purgeTimer = null;
				this.purgeEmptyGroups();
			}, 400);
		}

		/** Delete groups that no longer have any tab (Chrome removes empty groups) */
		purgeEmptyGroups() {
			let used = new Set(this._tabList().map(t => this._rawGroupOf(t)).filter(Boolean));
			for (let g of this.store.all()) {
				if (!used.has(g.id) && !(this.deps.isGroupUsedElsewhere && this.deps.isGroupUsedElsewhere(g.id, this))) {
					this.store.remove(g.id);
				}
			}
		}

		_selectAdjacent(direction, options) {
			let all = this.tabs._tabs;
			let index = all.findIndex(t => t.id === this.tabs._selectedID);
			let n = all.length;
			for (let step = 1; step <= n; step++) {
				let tab = all[(((index + direction * step) % n) + n) % n];
				if (!this.isHidden(tab)) {
					this.tabs.select(tab.id, false, options || {});
					return;
				}
			}
		}

		_beforeClose(ids) {
			let selectedID = this.tabs._selectedID;
			let list = !ids ? [selectedID] : (Array.isArray(ids) ? ids : [ids]);
			if (!list.includes(selectedID)) return;
			let all = this.tabs._tabs;
			let ok = t => t && !list.includes(t.id) && !this.isHidden(t);
			let prev = this.tabs._prevSelectedID && this._getTab(this.tabs._prevSelectedID);
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
			if (pick) this.tabs._prevSelectedID = pick.id;
		}

		/** Visible, keyboard-reachable strip items (tabs and group chips) */
		_focusableItems() {
			let strip = this._getStrip();
			if (!strip) return [];
			return Array.from(strip.children).filter(el => (
				el.classList.contains('ztg-header')
				|| (el.classList.contains('tab') && !el.hasAttribute('ztg-hidden'))
			));
		}

		/** @returns {boolean} whether focus was handled */
		_moveFocus(direction) {
			if (!this._headers.size) return false;
			let items = this._focusableItems();
			let active = this.doc.activeElement;
			let index = items.indexOf(active);
			if (index === -1) {
				let id = active && active.getAttribute && active.getAttribute('data-id');
				if (!id || !this._getTab(id)) id = this.tabs._selectedID;
				index = items.findIndex(el => el.classList.contains('tab') && el.getAttribute('data-id') === id);
				if (index === -1 && id === LIBRARY_TAB_ID) index = 0;
			}
			if (index === -1) return false;
			let target = items[index + (direction === 'next' ? 1 : -1)];
			if (!target) return true;
			if (target.getAttribute('data-id') === LIBRARY_TAB_ID) {
				// Zotero knows which of its two Library tab nodes is visible
				this.tabs.moveFocus('first');
			}
			else {
				target.focus();
			}
			return true;
		}

		// ------------------------------------------------------------------
		// Rendering
		// ------------------------------------------------------------------

		_getStrip() {
			return this.container.querySelector('.tabs-wrapper > .tabs');
		}

		_onMutations() {
			if (this._applying) return;
			if (this._commitWaiter) {
				let cb = this._commitWaiter;
				this._commitWaiter = null;
				cb();
				return;
			}
			if (this._drag) return;
			this._decorate();
		}

		_setAttr(el, name, value) {
			if (value === null || value === undefined || value === false) {
				if (el.hasAttribute(name)) el.removeAttribute(name);
			}
			else {
				let v = value === true ? '' : String(value);
				if (el.getAttribute(name) !== v) el.setAttribute(name, v);
			}
		}

		_decorate() {
			if (this._drag) return;
			let strip = this._getStrip();
			if (!strip) return;
			this._applying = true;
			try {
				let groupOfTab = new Map();
				for (let tab of this._tabList()) groupOfTab.set(tab.id, this._rawGroupOf(tab));

				let tabEls = Array.from(strip.children).filter(el => el.classList.contains('tab'));
				let instant = [];
				let firstEl = new Map();
				let lastEl = new Map();
				let counts = new Map();
				for (let el of tabEls) {
					let id = el.getAttribute('data-id');
					let gid = id === LIBRARY_TAB_ID ? null : groupOfTab.get(id) || null;
					let g = gid ? this.store.get(gid) : null;
					if (!g) gid = null;
					// Our pointer-based dragging replaces Zotero's native HTML5 drag
					// (React only writes this attribute when the tab is created)
					if (id !== LIBRARY_TAB_ID) this._setAttr(el, 'draggable', 'false');
					this._setAttr(el, 'ztg-group', gid);
					this._setAttr(el, 'ztg-color', g && g.color);
					let hide = !!(g && g.collapsed);
					if (!this._seenEls.has(el)) {
						this._seenEls.add(el);
						// A tab that is rendered already-collapsed (session restore,
						// plugin start) must not play the collapse animation
						if (hide && !el.hasAttribute('ztg-hidden')) {
							el.setAttribute('ztg-instant', '');
							el.setAttribute('ztg-hidden', '');
							instant.push(el);
						}
					}
					this._setAttr(el, 'ztg-hidden', hide);
					if (gid) {
						if (!firstEl.has(gid)) firstEl.set(gid, el);
						lastEl.set(gid, el);
						counts.set(gid, (counts.get(gid) || 0) + 1);
					}
				}
				for (let el of tabEls) {
					let gid = el.getAttribute('ztg-group');
					this._setAttr(el, 'ztg-first', !!gid && firstEl.get(gid) === el);
					this._setAttr(el, 'ztg-last', !!gid && lastEl.get(gid) === el);
				}

				let layoutChanged = false;
				for (let [gid, el] of firstEl) {
					let isNew = !this._headers.has(gid);
					let header = this._ensureHeader(gid);
					if (isNew) {
						header.setAttribute('ztg-instant', '');
						instant.push(header);
					}
					if (this._updateHeader(header, this.store.get(gid), counts.get(gid))) layoutChanged = true;
					if (header.parentNode !== strip || header.nextSibling !== el) {
						strip.insertBefore(header, el);
						if (isNew) layoutChanged = true;
					}
				}
				for (let [gid, header] of this._headers) {
					if (!firstEl.has(gid)) {
						header.remove();
						this._headers.delete(gid);
						layoutChanged = true;
					}
				}
				if (instant.length) {
					// Flush styles so the final state applies without transitions
					strip.getBoundingClientRect();
					for (let el of instant) el.removeAttribute('ztg-instant');
				}
				// Zotero only re-measures its scroll arrows when it renders
				if (layoutChanged) this._refreshTabBarSoon(120);
			}
			catch (e) {
				this._logError(e);
			}
			finally {
				if (this._observer) this._observer.takeRecords();
				this._applying = false;
			}
		}

		_ensureHeader(gid) {
			let header = this._headers.get(gid);
			if (header) return header;
			let doc = this.doc;
			header = doc.createElementNS(HTML_NS, 'div');
			header.className = 'ztg-header';
			header.setAttribute('data-ztg-group-id', gid);
			header.setAttribute('role', 'button');
			header.setAttribute('tabindex', '-1');
			let chip = doc.createElementNS(HTML_NS, 'div');
			chip.className = 'ztg-chip';
			let title = doc.createElementNS(HTML_NS, 'span');
			title.className = 'ztg-title';
			let count = doc.createElementNS(HTML_NS, 'span');
			count.className = 'ztg-count';
			chip.append(title, count);
			header.append(chip);
			this._headers.set(gid, header);
			return header;
		}

		/** @returns {boolean} whether the chip's size may have changed */
		_updateHeader(header, group, count) {
			let title = group.title || '';
			let sizeKey = `${title}\n${group.collapsed}\n${group.collapsed ? count : ''}`;
			let sizeChanged = header._ztgSizeKey !== undefined && header._ztgSizeKey !== sizeKey;
			header._ztgSizeKey = sizeKey;
			this._setAttr(header, 'ztg-color', group.color);
			this._setAttr(header, 'ztg-collapsed', group.collapsed);
			this._setAttr(header, 'ztg-untitled', !title);
			this._setAttr(header, 'aria-expanded', group.collapsed ? 'false' : 'true');
			let titleEl = header.querySelector('.ztg-title');
			if (titleEl.textContent !== title) titleEl.textContent = title;
			let countEl = header.querySelector('.ztg-count');
			if (countEl.textContent !== String(count)) countEl.textContent = String(count);
			let label = this.t('ztg-header-tooltip', {
				title: title || this.t('ztg-unnamed-group'),
				count,
			});
			this._setAttr(header, 'title', label);
			this._setAttr(header, 'aria-label', label);
			return sizeChanged;
		}

		/** Zotero recalculates its scroll arrows on render; nudge it after animations */
		_refreshTabBarSoon(delay = COLLAPSE_ANIMATION_MS + 30) {
			if (this._refreshTimer) this.win.clearTimeout(this._refreshTimer);
			this._refreshTimer = this._setTimeout(() => {
				this._refreshTimer = null;
				if (this._drag) return;
				try {
					this.tabs._update();
				}
				catch (e) {
					this._logError(e);
				}
			}, delay);
		}

		// ------------------------------------------------------------------
		// Group actions
		// ------------------------------------------------------------------

		/** Create a new group containing `tabId` and open its editor */
		addTabToNewGroup(tabId, { openEditor = true } = {}) {
			let tab = this._getTab(tabId);
			if (!tab || tab.id === LIBRARY_TAB_ID) return null;
			// Like Chrome, pick the least-used color among groups on the strip
			let inUse = new Set(this._tabList().map(t => this._rawGroupOf(t)).filter(Boolean));
			let group = this.store.create({
				color: ZTG_Model.pickColor(this.store.all().filter(g => inUse.has(g.id)).map(g => g.color)),
			});
			this._batch(() => {
				let current = this.groupOf(tabId);
				if (current) {
					let members = this.members(current);
					let isEdge = members[0] === tab || members[members.length - 1] === tab;
					if (!isEdge) this._moveTabsBefore([tabId], this._tabAfterGroup(current, tabId));
				}
				this._setRawGroup(tab, group.id);
			});
			this._saveSession();
			this._decorate();
			if (openEditor) this.openEditor(group.id, { isNew: true });
			return group.id;
		}

		/** Add (or move) a tab to the end of an existing group */
		addTabToGroup(tabId, groupId) {
			let tab = this._getTab(tabId);
			if (!tab || tab.id === LIBRARY_TAB_ID || !this.store.has(groupId)) return;
			if (this.groupOf(tabId) === groupId) return;
			this._batch(() => {
				let anchor = this._tabAfterGroup(groupId, tabId);
				this._setRawGroup(tab, groupId);
				if (anchor !== undefined) this._moveTabsBefore([tabId], anchor);
			});
			this._saveSession();
			this._decorate();
		}

		/** Take a tab out of its group, placing it right after the group if needed */
		removeTabFromGroup(tabId) {
			let tab = this._getTab(tabId);
			let groupId = this.groupOf(tabId);
			if (!tab || !groupId) return;
			this._batch(() => {
				let members = this.members(groupId);
				let isEdge = members[0] === tab || members[members.length - 1] === tab;
				if (!isEdge) this._moveTabsBefore([tabId], this._tabAfterGroup(groupId, tabId));
				this._setRawGroup(tab, null);
			});
			this._saveSession();
			this.purgeEmptyGroups();
			this._decorate();
		}

		/** Dissolve a group, keeping its tabs open */
		ungroup(groupId) {
			if (!this.store.has(groupId)) return;
			this.closeEditor();
			this._batch(() => {
				for (let tab of this.members(groupId)) this._setRawGroup(tab, null);
			});
			this.store.remove(groupId);
			this._saveSession();
			this._decorate();
		}

		/** Close every tab in a group (Undo Close Tab brings the group back) */
		closeGroup(groupId) {
			if (!this.store.has(groupId)) return;
			this.closeEditor();
			let ids = this.members(groupId).map(t => t.id);
			if (ids.length) this.tabs.close(ids);
			this.store.remove(groupId);
			this._decorate();
		}

		toggleCollapsed(groupId, force) {
			let group = this.store.get(groupId);
			if (!group) return;
			let collapse = force === undefined ? !group.collapsed : !!force;
			if (collapse === group.collapsed) return;
			if (collapse) {
				// Chrome moves the selection out of a group that is being collapsed
				let selected = this._getTab(this.tabs._selectedID);
				if (selected && this._rawGroupOf(selected) === groupId) {
					let next = this._nearestVisibleOutside(groupId);
					if (next) this.tabs.select(next.id);
				}
			}
			this.store.update(groupId, { collapsed: collapse });
			this._decorate();
			this._refreshTabBarSoon();
		}

		_nearestVisibleOutside(groupId) {
			let all = this.tabs._tabs;
			let indices = [];
			all.forEach((t, i) => {
				if (this._rawGroupOf(t) === groupId) indices.push(i);
			});
			if (!indices.length) return null;
			let ok = t => t && this._rawGroupOf(t) !== groupId && !this.isHidden(t);
			for (let i = indices[indices.length - 1] + 1; i < all.length; i++) {
				if (ok(all[i])) return all[i];
			}
			for (let i = indices[0] - 1; i >= 0; i--) {
				if (ok(all[i])) return all[i];
			}
			return all[0];
		}

		// ------------------------------------------------------------------
		// Event handling on the strip
		// ------------------------------------------------------------------

		_headerFromEvent(e) {
			let el = e.target && e.target.closest ? e.target.closest('.ztg-header') : null;
			return el && this.container.contains(el) ? el : null;
		}

		_onMouseDown(e) {
			// Clicking a chip must not move keyboard focus to it (Zotero would
			// remember it as the Library tab's last focused element)
			if (this._headerFromEvent(e)) e.preventDefault();
		}

		_onDragStart(e) {
			// Zotero's native HTML5 tab dragging is replaced by our pointer-based one
			let strip = this._getStrip();
			if (strip && e.target && e.target.closest && e.target.closest('.tab') && strip.contains(e.target)) {
				e.preventDefault();
				e.stopPropagation();
			}
		}

		_onClick(e) {
			let header = this._headerFromEvent(e);
			if (!header) return;
			e.stopPropagation();
			if (e.button !== 0 || this._suppressClick) return;
			this.toggleCollapsed(header.getAttribute('data-ztg-group-id'));
		}

		_onContextMenu(e) {
			let header = this._headerFromEvent(e);
			if (header) {
				e.preventDefault();
				e.stopPropagation();
				this.openEditor(header.getAttribute('data-ztg-group-id'));
				return;
			}
			let tabEl = e.target && e.target.closest ? e.target.closest('.tab[data-id]') : null;
			this.lastContextTabId = tabEl ? tabEl.getAttribute('data-id') : null;
		}

		_onKeyDown(e) {
			let header = this._headerFromEvent(e);
			if (!header) return;
			let gid = header.getAttribute('data-ztg-group-id');
			let rtl = this._isRTL(header.parentNode || header);
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
				let items = this._focusableItems();
				let target = items[items.indexOf(header) + (forward ? 1 : -1)];
				if (target && target.getAttribute('data-id') === LIBRARY_TAB_ID) this.tabs.moveFocus('first');
				else if (target) target.focus();
			}
		}

		// ------------------------------------------------------------------
		// Drag and drop
		// ------------------------------------------------------------------

		_onPointerDown(e) {
			if (e.button !== 0 || this._drag || this._pending) return;
			let strip = this._getStrip();
			if (!strip || !strip.contains(e.target)) return;
			let header = this._headerFromEvent(e);
			let tabEl = header ? null : e.target.closest('.tab');
			if (tabEl) {
				if (tabEl.parentNode !== strip) return;
				if (tabEl.getAttribute('data-id') === LIBRARY_TAB_ID) return;
				if (e.target.closest('.tab-close, .tab-audio-status')) return;
			}
			if (!header && !tabEl) return;
			this._pending = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, header, tabEl };
			this.win.addEventListener('pointermove', this._onPointerMove, true);
			this.win.addEventListener('pointerup', this._onPointerUp, true);
			this.win.addEventListener('pointercancel', this._onPointerUp, true);
		}

		_removePointerListeners() {
			this.win.removeEventListener('pointermove', this._onPointerMove, true);
			this.win.removeEventListener('pointerup', this._onPointerUp, true);
			this.win.removeEventListener('pointercancel', this._onPointerUp, true);
		}

		_onPointerMove(e) {
			if (this._pending && !this._drag) {
				if (e.pointerId !== this._pending.pointerId) return;
				let dx = e.clientX - this._pending.x;
				let dy = e.clientY - this._pending.y;
				if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
				if (!this._beginDrag()) {
					this._pending = null;
					this._removePointerListeners();
					return;
				}
			}
			if (this._drag) {
				this._drag.clientX = e.clientX;
				this._updateDrag();
			}
		}

		_onPointerUp(e) {
			let wasDragging = !!this._drag;
			this._pending = null;
			this._removePointerListeners();
			if (wasDragging) {
				this._suppressClick = true;
				this._setTimeout(() => {
					this._suppressClick = false;
				}, 0);
				this._finishDrag(e.type === 'pointerup');
			}
		}

		_onDragKeyDown(e) {
			if (e.key === 'Escape' && this._drag) {
				e.preventDefault();
				e.stopPropagation();
				this._pending = null;
				this._removePointerListeners();
				this._finishDrag(false);
			}
		}

		_isRTL(strip) {
			return this.win.getComputedStyle(strip).direction === 'rtl';
		}

		/** Distance from the strip's content start edge (scroll-independent) */
		_flowX(clientX) {
			let d = this._drag;
			let r = d.strip.getBoundingClientRect();
			return d.rtl
				? (r.right - clientX) - d.strip.scrollLeft
				: (clientX - r.left) + d.strip.scrollLeft;
		}

		_measure(el) {
			let r = el.getBoundingClientRect();
			return { start: this._flowX(this._drag.rtl ? r.right : r.left), size: r.width };
		}

		_beginDrag() {
			let { header, tabEl, pointerId, x } = this._pending;
			let strip = this._getStrip();
			if (!strip) return false;
			this.closeEditor();

			let unitKind = header ? 'group' : 'tab';
			let groupId = header ? header.getAttribute('data-ztg-group-id') : null;
			let tabId = tabEl ? tabEl.getAttribute('data-id') : null;
			if (tabId && !this._getTab(tabId)) return false;

			let visible = el => el.getClientRects().length > 0 && !el.hasAttribute('ztg-hidden');
			let all = Array.from(strip.children).filter(el => (
				(el.classList.contains('ztg-header')
					|| (el.classList.contains('tab') && el.getAttribute('data-id') !== LIBRARY_TAB_ID))
				&& visible(el)
			));
			let unitEls = header
				? all.filter(el => el === header || el.getAttribute('ztg-group') === groupId)
				: [tabEl];

			this._drag = {
				strip,
				rtl: this._isRTL(strip),
				unitKind,
				groupId,
				tabId,
				unitEls,
				clientX: x,
			};
			let gap = parseFloat(this.win.getComputedStyle(strip).columnGap);
			this._drag.gap = Number.isFinite(gap) ? gap : 0;

			let items = [];
			let unitStart = Infinity;
			let unitEnd = -Infinity;
			let base = Infinity;
			for (let el of all) {
				let m = this._measure(el);
				base = Math.min(base, m.start);
				if (unitEls.includes(el)) {
					unitStart = Math.min(unitStart, m.start);
					unitEnd = Math.max(unitEnd, m.start + m.size);
					continue;
				}
				if (el.classList.contains('ztg-header')) {
					let gid = el.getAttribute('data-ztg-group-id');
					let first = this.members(gid)[0];
					items.push({
						el, kind: 'header', groupId: gid, firstTabId: first && first.id,
						collapsed: el.hasAttribute('ztg-collapsed'), start: m.start, size: m.size,
					});
				}
				else {
					items.push({
						el, kind: 'tab', tabId: el.getAttribute('data-id'),
						groupId: el.getAttribute('ztg-group') || null, start: m.start, size: m.size,
					});
				}
			}
			if (!Number.isFinite(unitStart)) {
				this._drag = null;
				return false;
			}
			Object.assign(this._drag, {
				items,
				base,
				unitStart,
				unitSize: unitEnd - unitStart,
				grabOffset: this._flowX(x) - unitStart,
				currentGroupId: tabId ? this.groupOf(tabId) : null,
				result: null,
			});

			strip.setAttribute('ztg-dragging', '');
			for (let el of unitEls) el.setAttribute('ztg-drag-unit', '');
			try {
				strip.setPointerCapture(pointerId);
				this._drag.pointerId = pointerId;
			}
			catch (e) {
				// pointer capture is a nicety, not a requirement
			}
			this.win.addEventListener('keydown', this._onDragKeyDown, true);
			this._drag.frame = this.win.requestAnimationFrame(this._dragFrame);
			this._updateDrag();
			return true;
		}

		_translate(el, dx) {
			let v = Math.abs(dx) < 0.01 ? '' : `translateX(${this._drag.rtl ? -dx : dx}px)`;
			if (el.style.transform !== v) el.style.transform = v;
		}

		_updateDrag() {
			let d = this._drag;
			if (!d) return;
			let maxStart = d.base;
			for (let item of d.items) maxStart += item.size + d.gap;
			let desired = this._flowX(d.clientX) - d.grabOffset;
			desired = Math.max(d.base, Math.min(maxStart, desired));

			let res = ZTG_Model.computeDrop({
				items: d.items,
				base: d.base,
				gap: d.gap,
				unitKind: d.unitKind,
				unitSize: d.unitSize,
				desiredStart: desired,
				currentGroupId: d.currentGroupId,
			});
			d.result = res;
			d.items.forEach((item, i) => this._translate(item.el, res.starts[i] - item.start));
			for (let el of d.unitEls) this._translate(el, desired - d.unitStart);

			if (d.unitKind === 'tab') {
				d.currentGroupId = res.groupId;
				let el = d.unitEls[0];
				let g = res.groupId ? this.store.get(res.groupId) : null;
				this._setAttr(el, 'ztg-group', g ? g.id : null);
				this._setAttr(el, 'ztg-color', g ? g.color : null);
				// Recompute underline end caps in the order the strip will have
				let seq = d.items.filter(it => it.kind === 'tab').map(it => ({ el: it.el, gid: it.groupId }));
				let insertAt = d.items.slice(0, res.index).filter(it => it.kind === 'tab').length;
				seq.splice(insertAt, 0, { el, gid: res.groupId });
				seq.forEach((s, i) => {
					this._setAttr(s.el, 'ztg-first', !!s.gid && (i === 0 || seq[i - 1].gid !== s.gid));
					this._setAttr(s.el, 'ztg-last', !!s.gid && (i === seq.length - 1 || seq[i + 1].gid !== s.gid));
				});
			}
		}

		_dragFrame() {
			let d = this._drag;
			if (!d) return;
			let strip = d.strip;
			if (strip.scrollWidth > strip.clientWidth + 1) {
				let r = strip.getBoundingClientRect();
				let speed = 0;
				if (d.clientX < r.left + AUTOSCROLL_ZONE) {
					speed = -Math.ceil(AUTOSCROLL_MAX_SPEED * (1 - Math.max(0, d.clientX - r.left) / AUTOSCROLL_ZONE));
				}
				else if (d.clientX > r.right - AUTOSCROLL_ZONE) {
					speed = Math.ceil(AUTOSCROLL_MAX_SPEED * (1 - Math.max(0, r.right - d.clientX) / AUTOSCROLL_ZONE));
				}
				if (speed) {
					let before = strip.scrollLeft;
					strip.scrollLeft += speed;
					if (strip.scrollLeft !== before) this._updateDrag();
				}
			}
			d.frame = this.win.requestAnimationFrame(this._dragFrame);
		}

		_cancelDrag(animate) {
			if (this._drag) this._finishDrag(false, animate);
			this._pending = null;
			this._removePointerListeners();
		}

		/**
		 * End the drag. If `commit`, apply the new order/membership through
		 * Zotero_Tabs; then animate the dragged unit into its resting place.
		 */
		_finishDrag(commit, animate = true) {
			let d = this._drag;
			if (!d) return;
			this.win.cancelAnimationFrame(d.frame);
			this.win.removeEventListener('keydown', this._onDragKeyDown, true);
			if (d.pointerId !== undefined) {
				try {
					d.strip.releasePointerCapture(d.pointerId);
				}
				catch (e) {
					// ignore
				}
			}

			// FLIP: remember where the unit is on screen right now
			let firstRects = new Map(d.unitEls.map(el => [el, el.getBoundingClientRect()]));
			let orderChanged = false;

			if (commit && d.result) {
				try {
					orderChanged = this._commitDrop(d);
				}
				catch (e) {
					this._logError(e);
				}
			}

			let settle = () => {
				this._drag = null;
				// If the order changed, the strip already shows the final layout
				// and transforms must go away instantly. Otherwise (cancel, or a
				// membership-only change) let the other tabs glide back.
				let glideBack = animate && !orderChanged;
				if (!glideBack) d.strip.removeAttribute('ztg-dragging');
				for (let item of d.items) item.el.style.removeProperty('transform');
				for (let el of d.unitEls) el.style.removeProperty('transform');
				this._decorate();
				if (glideBack) {
					this._setTimeout(() => {
						if (!this._drag) d.strip.removeAttribute('ztg-dragging');
					}, 220);
				}
				if (!animate) {
					for (let el of d.unitEls) el.removeAttribute('ztg-drag-unit');
					return;
				}
				// Animate the unit from where it was dropped to where it now is
				let moved = [];
				for (let el of d.unitEls) {
					if (!el.isConnected) continue;
					let first = firstRects.get(el);
					let last = el.getBoundingClientRect();
					let dx = first.left - last.left;
					if (Math.abs(dx) < 0.5) {
						el.removeAttribute('ztg-drag-unit');
						continue;
					}
					el.style.transform = `translateX(${dx}px)`;
					moved.push(el);
				}
				if (!moved.length) return;
				// Force style flush so the transition starts from the offset
				moved[0].getBoundingClientRect();
				for (let el of moved) {
					el.setAttribute('ztg-settling', '');
					el.style.removeProperty('transform');
				}
				this._setTimeout(() => {
					for (let el of moved) {
						el.removeAttribute('ztg-settling');
						el.removeAttribute('ztg-drag-unit');
					}
				}, 220);
			};

			if (orderChanged) {
				// Wait for React to re-render the strip in the new order, then
				// swap transforms for real positions in the same frame
				let done = false;
				let run = () => {
					if (done) return;
					done = true;
					settle();
				};
				this._commitWaiter = run;
				this._setTimeout(() => {
					if (this._commitWaiter === run) this._commitWaiter = null;
					run();
				}, 250);
			}
			else {
				settle();
			}
		}

		/** @returns {boolean} whether the tab order changed */
		_commitDrop(d) {
			let res = d.result;
			let anchor = ZTG_Model.insertionAnchor(d.items, res.index);
			let ids = d.unitKind === 'group'
				? this.members(d.groupId).map(t => t.id)
				: [d.tabId];
			if (!ids.length) return false;

			let orderBefore = this.tabs._tabs.map(t => t.id).join('\n');
			let membershipChanged = false;
			this._batch(() => {
				if (d.unitKind === 'tab') {
					membershipChanged = this._setRawGroup(this._getTab(d.tabId), res.groupId);
				}
				this._moveTabsBefore(ids, anchor);
			});
			let orderChanged = this.tabs._tabs.map(t => t.id).join('\n') !== orderBefore;
			if (orderChanged || membershipChanged) this._saveSession();
			if (membershipChanged) this.purgeEmptyGroups();
			return orderChanged;
		}

		// ------------------------------------------------------------------
		// Group editor bubble
		// ------------------------------------------------------------------

		openEditor(groupId, { isNew = false, fromKeyboard = false, retries = 10 } = {}) {
			let group = this.store.get(groupId);
			if (!group) return;
			let header = this._headers.get(groupId);
			if (!header || !header.isConnected) {
				// The tab may not be rendered yet (React renders asynchronously)
				if (retries > 0) this._setTimeout(() => this.openEditor(groupId, { isNew, fromKeyboard, retries: retries - 1 }), 30);
				return;
			}
			this.closeEditor();
			let doc = this.doc;
			let h = (tag, cls, attrs = {}) => {
				let el = doc.createElementNS(HTML_NS, tag);
				if (cls) el.className = cls;
				for (let [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
				return el;
			};

			let editor = h('div', 'ztg-editor', {
				role: 'dialog',
				'aria-label': this.t('ztg-editor-label'),
				'data-ztg-group-id': groupId,
			});
			let input = h('input', 'ztg-editor-name', {
				type: 'text',
				maxlength: '80',
				placeholder: this.t('ztg-editor-name-placeholder'),
				'aria-label': this.t('ztg-editor-name-placeholder'),
			});
			input.value = group.title;
			input.addEventListener('input', () => {
				this.store.update(groupId, { title: input.value.trim() ? input.value : '' });
			});

			let colors = h('div', 'ztg-editor-colors', { role: 'radiogroup', 'aria-label': this.t('ztg-editor-colors') });
			let swatches = [];
			for (let color of ZTG_Model.COLORS) {
				let sw = h('button', 'ztg-swatch', {
					type: 'button',
					role: 'radio',
					tabindex: '-1',
					'ztg-color': color,
					'aria-label': this.t('ztg-color-' + color),
					title: this.t('ztg-color-' + color),
				});
				// Keep focus in the name field (so it doesn't look like the bubble lost focus)
				sw.addEventListener('mousedown', e => e.preventDefault());
				sw.addEventListener('click', () => {
					this.store.update(groupId, { color });
					sync();
				});
				swatches.push(sw);
				colors.append(sw);
			}

			let actions = h('div', 'ztg-editor-actions');
			let addAction = (id, fn) => {
				let b = h('button', 'ztg-editor-item', { type: 'button', 'data-action': id });
				b.textContent = this.t('ztg-editor-' + id);
				b.addEventListener('mousedown', e => e.preventDefault());
				b.addEventListener('click', fn);
				actions.append(b);
			};
			addAction('ungroup', () => this.ungroup(groupId));
			addAction('close-group', () => this.closeGroup(groupId));

			editor.append(input, colors, h('div', 'ztg-editor-separator'), actions);

			let sync = () => {
				let g = this.store.get(groupId);
				if (!g) return;
				editor.setAttribute('ztg-color', g.color);
				for (let sw of swatches) {
					let on = sw.getAttribute('ztg-color') === g.color;
					sw.setAttribute('aria-checked', on ? 'true' : 'false');
				}
			};
			sync();

			let host = doc.documentElement;
			host.appendChild(editor);
			if (typeof editor.showPopover === 'function') {
				// Top layer: stays above the reader iframe and everything else
				editor.setAttribute('popover', 'manual');
				try {
					editor.showPopover();
				}
				catch (e) {
					// fall back to fixed positioning
				}
			}
			this._editor = { el: editor, groupId, input, fromKeyboard, openedAt: Date.now(), unsubscribe: this.store.subscribe(() => {
				if (!this.store.has(groupId)) this.closeEditor();
				else sync();
			}) };
			this._positionEditor();

			doc.addEventListener('pointerdown', this._onEditorDocPointerDown, true);
			doc.addEventListener('keydown', this._onEditorKeyDown, true);
			this.win.addEventListener('blur', this._onWindowBlur);
			editor.addEventListener('focusout', () => {
				this._setTimeout(() => {
					if (!this._editor || this._editor.el !== editor) return;
					let active = doc.activeElement;
					// Focus went into a frame (e.g. the PDF reader) or elsewhere
					if (!active || !editor.contains(active)) this.closeEditor();
				}, 0);
			});

			input.focus();
			if (!isNew) input.select();
		}

		_positionEditor() {
			if (!this._editor) return;
			let { el, groupId } = this._editor;
			let header = this._headers.get(groupId);
			if (!header) return;
			let r = header.getBoundingClientRect();
			let w = el.offsetWidth || 260;
			let viewport = this.doc.documentElement.clientWidth || this.win.innerWidth;
			let rtl = this._isRTL(header.parentNode || header);
			let left = rtl ? r.right - w : r.left;
			left = Math.max(8, Math.min(left, viewport - w - 8));
			el.style.left = `${Math.round(left)}px`;
			el.style.top = `${Math.round(r.bottom + 6)}px`;
		}

		closeEditor() {
			let ed = this._editor;
			if (!ed) return;
			this._editor = null;
			ed.unsubscribe();
			this.doc.removeEventListener('pointerdown', this._onEditorDocPointerDown, true);
			this.doc.removeEventListener('keydown', this._onEditorKeyDown, true);
			this.win.removeEventListener('blur', this._onWindowBlur);
			try {
				if (ed.el.matches(':popover-open')) ed.el.hidePopover();
			}
			catch (e) {
				// ignore
			}
			ed.el.remove();
			this.store.flush();
		}

		_onEditorDocPointerDown(e) {
			if (!this._editor) return;
			if (this._editor.el.contains(e.target)) return;
			let header = this._headerFromEvent(e);
			if (header && header.getAttribute('data-ztg-group-id') === this._editor.groupId) {
				// Clicking the chip of the open editor just closes it
				e.stopPropagation();
				this._suppressClick = true;
				this._setTimeout(() => {
					this._suppressClick = false;
				}, 0);
			}
			this.closeEditor();
		}

		_onEditorKeyDown(e) {
			if (!this._editor) return;
			if (e.key === 'Escape' || (e.key === 'Enter' && e.target === this._editor.input)) {
				e.preventDefault();
				e.stopPropagation();
				let { groupId, fromKeyboard } = this._editor;
				this.closeEditor();
				// Return focus where it came from: the chip, or the tab content
				let header = this._headers.get(groupId);
				if (fromKeyboard && header) header.focus();
				else if (typeof this.tabs.refocus === 'function') this.tabs.refocus();
			}
		}

		_onWindowBlur() {
			// Ignore the blur some platforms fire while a context menu closes
			if (this._editor && Date.now() - this._editor.openedAt < 400) return;
			this.closeEditor();
		}
	}

	return WindowController;
})();
