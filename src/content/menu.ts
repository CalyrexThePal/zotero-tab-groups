/*
 * Tab Groups for Zotero — tab context menu entries, registered through
 * Zotero.MenuManager (target `main/tab`). Exists only inside Zotero; the
 * browser test harness has no menus.
 */

import { LIBRARY_TAB_ID } from './zoteroTabs';
import type { WindowController } from './controller';
import type { Store } from './store';

const GROUP_COLORS: Record<string, string> = {
	grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
	pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e',
};

export interface MenuHost {
	id: string | null;
	store: Store;
	controllerFor(win: unknown): WindowController | undefined;
	log(msg: string): void;
}

interface MenuInfo {
	controller: WindowController | undefined;
	tabId: string | null;
	groupId: string | null;
	valid: boolean;
	doc: Document | undefined;
}

/** Resolve the controller, right-clicked tab and its group for a menu */
function menuInfo(host: MenuHost, ctx: ZoteroMenuContext): MenuInfo {
	let menuElem = ctx.menuElem;
	let win = menuElem && menuElem.ownerGlobal;
	let controller = win ? host.controllerFor(win) : undefined;
	let tabId: string | null = null;
	try {
		tabId = ctx.tabID || null;
	}
	catch (e) {
		// fall through to our own tracking
	}
	if (!tabId && controller) tabId = controller.lastContextTabId;
	let valid = !!(controller && tabId && tabId !== LIBRARY_TAB_ID && controller.getTab(tabId));
	let groupId = valid ? controller!.groupOf(tabId!) : null;
	return { controller, tabId, groupId, valid, doc: menuElem && menuElem.ownerDocument };
}

function colorIcon(color: string): string {
	let hex = GROUP_COLORS[color] || GROUP_COLORS.grey;
	let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5" fill="${hex}"/></svg>`;
	return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

/** @returns the registered menu id, or null if Zotero.MenuManager is unavailable */
export function registerMenus(host: MenuHost): string | null {
	if (!Zotero.MenuManager || typeof Zotero.MenuManager.registerMenu !== 'function') {
		host.log('Zotero.MenuManager not available; tab context menu entries disabled');
		return null;
	}
	let show = (test: (info: MenuInfo) => boolean) => (ev: Event, ctx: ZoteroMenuContext) => {
		let info = menuInfo(host, ctx);
		ctx.setVisible(info.valid && test(info));
	};
	let always = () => true;
	let grouped = (info: MenuInfo) => !!info.groupId;
	/** A menu item that runs `fn` for the right-clicked tab (or its group) */
	let item = (
		l10nID: string,
		visible: (info: MenuInfo) => boolean,
		fn: (info: MenuInfo & { controller: WindowController; tabId: string }) => void,
		needsGroup = false,
	): ZoteroMenuSpec => ({
		menuType: 'menuitem',
		l10nID,
		onShowing: show(visible),
		onCommand: (ev, ctx) => {
			let info = menuInfo(host, ctx);
			if (!info.valid || (needsGroup && !info.groupId)) return;
			fn(info as MenuInfo & { controller: WindowController; tabId: string });
		},
	});

	let menuID = Zotero.MenuManager.registerMenu({
		menuID: 'zotero-tab-groups-tab-menu',
		pluginID: host.id!,
		target: 'main/tab',
		menus: [
			{ menuType: 'separator', onShowing: show(always) },
			item('ztg-menu-add-to-new-group', always, info => info.controller.addTabToNewGroup(info.tabId)),
			{
				menuType: 'submenu',
				l10nID: 'ztg-menu-add-to-group',
				menus: [],
				onShowing: (ev, ctx) => populateGroupSubmenu(host, ctx),
			},
			item('ztg-menu-remove-from-group', grouped, info => info.controller.removeTabFromGroup(info.tabId)),
			{ menuType: 'separator', onShowing: show(grouped) },
			item('ztg-menu-edit-group', grouped, (info) => {
				// Let the context menu finish closing before focusing the bubble
				info.controller.win.setTimeout(() => info.controller.openEditor(info.groupId!), 0);
			}, true),
			item('ztg-menu-collapse-group', grouped, info => info.controller.toggleCollapsed(info.groupId!, true), true),
			item('ztg-menu-ungroup', grouped, info => info.controller.ungroup(info.groupId!), true),
			item('ztg-menu-close-group', grouped, info => info.controller.closeGroup(info.groupId!), true),
		],
	});
	return menuID || null;
}

export function unregisterMenus(menuID: string): void {
	if (Zotero.MenuManager) Zotero.MenuManager.unregisterMenu(menuID);
}

/** "Add Tab to Group ▸" / "Move Tab to Group ▸" with the current groups */
function populateGroupSubmenu(host: MenuHost, ctx: ZoteroMenuContext): void {
	let info = menuInfo(host, ctx);
	let { controller, doc } = info;
	let menu = ctx.menuElem as any;
	let others = info.valid
		? host.store.all().filter(g => g.id !== info.groupId && controller!.members(g.id).length)
		: [];
	ctx.setVisible(info.valid && others.length > 0);
	if (!info.valid || !others.length || !menu || !controller || !doc) return;

	(doc as any).l10n.setAttributes(menu, info.groupId ? 'ztg-menu-move-to-group' : 'ztg-menu-add-to-group');
	let popup = menu.querySelector(':scope > menupopup') as Element | null;
	if (!popup) return;
	for (let el of popup.querySelectorAll(':scope > .ztg-dynamic')) el.remove();

	let add = (el: Element) => {
		el.classList.add('ztg-dynamic');
		popup!.appendChild(el);
		return el;
	};
	let createXUL = (tag: string) => (doc as any).createXULElement(tag) as Element;
	let newItem = add(createXUL('menuitem'));
	(doc as any).l10n.setAttributes(newItem, 'ztg-menu-new-group');
	newItem.addEventListener('command', () => controller!.addTabToNewGroup(info.tabId!));
	add(createXUL('menuseparator'));

	// Stable order: as the groups appear on the tab strip
	let order = controller.tabList().map(t => controller!.groupOf(t.id));
	others.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
	for (let group of others) {
		let menuItem = add(createXUL('menuitem'));
		menuItem.classList.add('menuitem-iconic');
		menuItem.setAttribute('image', colorIcon(group.color));
		let count = controller.members(group.id).length;
		let name = group.title || controller.t('ztg-unnamed-group');
		menuItem.setAttribute('label', group.title ? name : `${name} (${count})`);
		menuItem.addEventListener('command', () => controller!.addTabToGroup(info.tabId!, group.id));
	}
}
