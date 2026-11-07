/*
 * Tab Groups for Zotero — plugin entry object.
 *
 * Owns the shared group store, the tab context-menu entries (registered
 * through Zotero.MenuManager) and one ZTG_WindowController per main window.
 */

/* global Zotero, ZTG_Store, ZTG_WindowController, ZTG_Model */
/* exported ZoteroTabGroups */

var ZoteroTabGroups = {
	PREF_GROUPS: 'extensions.zotero-tab-groups.groups',
	FTL: 'zotero-tab-groups.ftl',
	STYLESHEET_ID: 'zotero-tab-groups-stylesheet',

	id: null,
	version: null,
	rootURI: null,
	store: null,
	controllers: new Map(),
	menuID: null,

	log(msg) {
		Zotero.debug('Tab Groups: ' + msg);
	},

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.store = new ZTG_Store({
			read: () => Zotero.Prefs.get(this.PREF_GROUPS, true) || '{}',
			write: json => Zotero.Prefs.set(this.PREF_GROUPS, json, true),
		});
		this.registerMenus();
		this.log(`started ${version}`);
	},

	shutdown() {
		this.removeFromAllWindows();
		if (this.menuID && Zotero.MenuManager) {
			try {
				Zotero.MenuManager.unregisterMenu(this.menuID);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		this.menuID = null;
		if (this.store) this.store.flush();
	},

	/** Flush pending writes without tearing down the UI (app quit) */
	flush() {
		if (this.store) this.store.flush();
	},

	addToAllWindows() {
		for (let win of Zotero.getMainWindows()) {
			if (!win.ZoteroPane) continue;
			this.addToWindow(win);
		}
	},

	removeFromAllWindows() {
		for (let win of [...this.controllers.keys()]) {
			this.removeFromWindow(win);
		}
	},

	addToWindow(win) {
		if (this.controllers.has(win)) return;
		let doc = win.document;

		if (!doc.getElementById(this.STYLESHEET_ID)) {
			let link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
			link.id = this.STYLESHEET_ID;
			link.setAttribute('rel', 'stylesheet');
			link.setAttribute('type', 'text/css');
			link.setAttribute('href', this.rootURI + 'content/tabGroups.css');
			doc.documentElement.appendChild(link);
		}
		// Needed for the l10n IDs used by the context menu entries
		win.MozXULElement.insertFTLIfNeeded(this.FTL);

		let l10n = null;
		try {
			l10n = new win.Localization([this.FTL], true);
		}
		catch (e) {
			Zotero.logError(e);
		}
		let t = (id, args) => {
			try {
				return (l10n && l10n.formatValueSync(id, args)) || id;
			}
			catch (e) {
				return id;
			}
		};

		let controller = new ZTG_WindowController(win, {
			store: this.store,
			t,
			saveSession: () => Zotero.Session.debounceSave(),
			log: msg => this.log(msg),
			logError: e => Zotero.logError(e),
			isGroupUsedElsewhere: (groupId, self) => [...this.controllers.values()].some(
				c => c !== self && c.members(groupId).length
			),
		});
		try {
			controller.init();
			this.controllers.set(win, controller);
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	removeFromWindow(win) {
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
		let link = doc.getElementById(this.STYLESHEET_ID);
		if (link) link.remove();
		let ftl = doc.querySelector(`link[rel="localization"][href="${this.FTL}"]`);
		if (ftl) ftl.remove();
	},

	// ----------------------------------------------------------------------
	// Tab context menu
	// ----------------------------------------------------------------------

	/** Resolve the controller, right-clicked tab and its group for a menu */
	_menuInfo(ctx) {
		let menuElem = ctx.menuElem;
		let win = menuElem && menuElem.ownerGlobal;
		let controller = win && this.controllers.get(win);
		let tabId = null;
		try {
			tabId = ctx.tabID;
		}
		catch (e) {
			// fall through to our own tracking
		}
		if (!tabId && controller) tabId = controller.lastContextTabId;
		let valid = !!(controller && tabId && tabId !== 'zotero-pane' && controller._getTab(tabId));
		let groupId = valid ? controller.groupOf(tabId) : null;
		return { controller, tabId, groupId, valid, doc: menuElem && menuElem.ownerDocument };
	},

	_colorIcon(color) {
		let hex = {
			grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
			pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e',
		}[color] || '#5f6368';
		let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5" fill="${hex}"/></svg>`;
		return 'data:image/svg+xml,' + encodeURIComponent(svg);
	},

	registerMenus() {
		if (!Zotero.MenuManager || typeof Zotero.MenuManager.registerMenu !== 'function') {
			this.log('Zotero.MenuManager not available; tab context menu entries disabled');
			return;
		}
		let show = test => (ev, ctx) => {
			let info = this._menuInfo(ctx);
			ctx.setVisible(info.valid && test(info));
		};
		let always = () => true;
		let grouped = info => !!info.groupId;

		let menuID = Zotero.MenuManager.registerMenu({
			menuID: 'zotero-tab-groups-tab-menu',
			pluginID: this.id,
			target: 'main/tab',
			menus: [
				{
					menuType: 'separator',
					onShowing: show(always),
				},
				{
					menuType: 'menuitem',
					l10nID: 'ztg-menu-add-to-new-group',
					onShowing: show(always),
					onCommand: (ev, ctx) => {
						let info = this._menuInfo(ctx);
						if (info.valid) info.controller.addTabToNewGroup(info.tabId);
					},
				},
				{
					menuType: 'submenu',
					l10nID: 'ztg-menu-add-to-group',
					menus: [],
					onShowing: (ev, ctx) => this._populateGroupSubmenu(ctx),
				},
				{
					menuType: 'menuitem',
					l10nID: 'ztg-menu-remove-from-group',
					onShowing: show(grouped),
					onCommand: (ev, ctx) => {
						let info = this._menuInfo(ctx);
						if (info.valid) info.controller.removeTabFromGroup(info.tabId);
					},
				},
				{
					menuType: 'separator',
					onShowing: show(grouped),
				},
				{
					menuType: 'menuitem',
					l10nID: 'ztg-menu-edit-group',
					onShowing: show(grouped),
					onCommand: (ev, ctx) => {
						let info = this._menuInfo(ctx);
						// Let the context menu finish closing before focusing the bubble
						if (info.groupId) info.controller.win.setTimeout(() => info.controller.openEditor(info.groupId), 0);
					},
				},
				{
					menuType: 'menuitem',
					l10nID: 'ztg-menu-collapse-group',
					onShowing: show(grouped),
					onCommand: (ev, ctx) => {
						let info = this._menuInfo(ctx);
						if (info.groupId) info.controller.toggleCollapsed(info.groupId, true);
					},
				},
				{
					menuType: 'menuitem',
					l10nID: 'ztg-menu-ungroup',
					onShowing: show(grouped),
					onCommand: (ev, ctx) => {
						let info = this._menuInfo(ctx);
						if (info.groupId) info.controller.ungroup(info.groupId);
					},
				},
				{
					menuType: 'menuitem',
					l10nID: 'ztg-menu-close-group',
					onShowing: show(grouped),
					onCommand: (ev, ctx) => {
						let info = this._menuInfo(ctx);
						if (info.groupId) info.controller.closeGroup(info.groupId);
					},
				},
			],
		});
		this.menuID = menuID || null;
	},

	/** "Add Tab to Group ▸" / "Move Tab to Group ▸" with the current groups */
	_populateGroupSubmenu(ctx) {
		let info = this._menuInfo(ctx);
		let { controller, doc } = info;
		let menu = ctx.menuElem;
		let others = info.valid
			? this.store.all().filter(g => g.id !== info.groupId && controller.members(g.id).length)
			: [];
		ctx.setVisible(info.valid && others.length > 0);
		if (!info.valid || !others.length || !menu) return;

		doc.l10n.setAttributes(menu, info.groupId ? 'ztg-menu-move-to-group' : 'ztg-menu-add-to-group');
		let popup = menu.querySelector(':scope > menupopup');
		if (!popup) return;
		for (let el of popup.querySelectorAll(':scope > .ztg-dynamic')) el.remove();

		let add = (el) => {
			el.classList.add('ztg-dynamic');
			popup.appendChild(el);
			return el;
		};
		let newItem = add(doc.createXULElement('menuitem'));
		doc.l10n.setAttributes(newItem, 'ztg-menu-new-group');
		newItem.addEventListener('command', () => controller.addTabToNewGroup(info.tabId));
		add(doc.createXULElement('menuseparator'));

		// Stable order: as the groups appear on the tab strip
		let order = controller._tabList().map(t => controller.groupOf(t.id));
		others.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
		for (let group of others) {
			let item = add(doc.createXULElement('menuitem'));
			item.classList.add('menuitem-iconic');
			item.setAttribute('image', this._colorIcon(group.color));
			let count = controller.members(group.id).length;
			let name = group.title || controller.t('ztg-unnamed-group');
			item.setAttribute('label', group.title ? name : `${name} (${count})`);
			item.addEventListener('command', () => controller.addTabToGroup(info.tabId, group.id));
		}
	},
};
