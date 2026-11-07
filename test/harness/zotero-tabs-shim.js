/*
 * A small stand-in for Zotero 10's `Zotero_Tabs` (chrome/content/zotero/tabs.js),
 * keeping the parts the plugin relies on with the same semantics:
 * _tabs, _selectedID, _getTab, _update (-> React setTabs), add, close, move,
 * select, selectNext/selectPrev, setTabData, getState, undoClose, tabHooks.
 * The code of add/close/move/select/_update follows tabs.js closely.
 */
/* eslint-env browser */
'use strict';

export function createZoteroTabs(tabBarRef, log) {
	let counter = 0;
	const Zotero_Tabs = {
		_tabs: [{ id: 'zotero-pane', type: 'library', title: 'My Library', data: {} }],
		_selectedID: 'zotero-pane',
		_prevSelectedID: null,
		_history: [],
		sessionSaves: 0,

		get selectedID() {
			return this._selectedID;
		},

		_getTab(id) {
			let tabIndex = this._tabs.findIndex(tab => tab.id == id);
			return { tab: this._tabs[tabIndex], tabIndex };
		},

		_update() {
			tabBarRef.current.setTabs(this._tabs.map(tab => ({
				id: tab.id,
				type: tab.type,
				title: tab.title,
				renderTitle: false,
				selected: tab.id == this._selectedID,
				isItemType: tab.id !== 'zotero-pane',
				icon: tab.id === 'zotero-pane' ? 'library' : 'attachmentPDF',
			})));
		},

		setTabData(tabID, data) {
			let { tab } = this._getTab(tabID);
			Object.assign(tab.data, data);
			this.sessionSaves++;
		},

		getState() {
			return this._tabs.map(tab => {
				let o = { type: tab.type, title: tab.title };
				if (tab.data) o.data = tab.data;
				if (tab.id == this._selectedID) o.selected = true;
				return o;
			});
		},

		add({ id, type = 'reader', data = {}, title = '', index, select } = {}) {
			if (index !== undefined && (!Number.isInteger(index) || index < 1)) {
				throw new Error(`'index' should be an integer > 0 (was ${index})`);
			}
			id = id || 'tab-' + (++counter);
			let tab = { id, type, title, data };
			index = index || this._tabs.length;
			this._tabs.splice(index, 0, tab);
			this._update();
			if (select) this.select(id);
			return { id };
		},

		close(ids) {
			if (!ids) ids = [this._selectedID];
			else if (!Array.isArray(ids)) ids = [ids];
			if (ids.includes('zotero-pane')) throw new Error('Library tab cannot be closed');
			let historyEntry = [];
			let tmpTabs = this._tabs.slice();
			for (let id of ids) {
				let { tab, tabIndex } = this._getTab(id);
				if (!tab) continue;
				if (tab.id == this._selectedID) {
					let tabToSelect = null;
					if (this._prevSelectedID && !ids.includes(this._prevSelectedID)) {
						tabToSelect = this._getTab(this._prevSelectedID).tab;
					}
					else {
						tabToSelect = this._tabs.slice(tabIndex + 1)
							.concat(this._tabs.slice(0, tabIndex).reverse())
							.find(x => !ids.includes(x.id));
					}
					this.select(tabToSelect.id);
				}
				if (tab.id == this._prevSelectedID) this._prevSelectedID = null;
				tabIndex = this._tabs.findIndex(x => x.id === id);
				this._tabs.splice(tabIndex, 1);
				historyEntry.push({ index: tmpTabs.indexOf(tab), data: tab.data, type: tab.type });
			}
			this._history.push(historyEntry);
			this._update();
		},

		async undoClose() {
			let entry = this._history.pop();
			if (!entry) return;
			for (let tab of entry) {
				await this.tabHooks.undoClose.reader({ data: tab.data }, tab.index);
			}
		},

		move(id, newIndex) {
			if (!Number.isInteger(newIndex) || newIndex < 1) {
				throw new Error(`'newIndex' should be an interger > 0 (was ${newIndex})`);
			}
			let { tab, tabIndex } = this._getTab(id);
			if (tabIndex == 0) throw new Error('Library tab cannot be moved');
			if (!tab || tabIndex == newIndex) return;
			if (newIndex > tabIndex) newIndex--;
			this._tabs.splice(tabIndex, 1);
			this._tabs.splice(newIndex, 0, tab);
			this._update();
		},

		select(id, reopening) {
			let { tab } = this._getTab(id);
			if (!tab || tab.id === this._selectedID) return;
			this._prevSelectedID = reopening ? this._selectedID : null;
			this._selectedID = id;
			this._update();
		},

		// Same logic as tabs.js moveFocus()
		moveFocus(direction) {
			let focusedTabID = document.activeElement.getAttribute('data-id');
			let { tabIndex } = this._getTab(this._selectedID);
			let tabIndexToFocus = null;
			if (direction === 'last') tabIndexToFocus = this._tabs.length - 1;
			else if (direction == 'first') tabIndexToFocus = 0;
			else if (direction == 'current') tabIndexToFocus = tabIndex;
			else {
				let focusedTabIndex = this._tabs.findIndex(tab => tab.id === focusedTabID);
				if (focusedTabIndex === -1) focusedTabIndex = tabIndex;
				if (direction === 'previous') tabIndexToFocus = focusedTabIndex > 0 ? focusedTabIndex - 1 : null;
				else tabIndexToFocus = focusedTabIndex < this._tabs.length - 1 ? focusedTabIndex + 1 : null;
			}
			if (tabIndexToFocus !== null) {
				const nextTab = this._tabs[tabIndexToFocus];
				let candidates = document.querySelectorAll(`#tab-bar-container .tab[data-id="${nextTab.id}"]`);
				for (let node of candidates) {
					node.focus();
					if (document.activeElement == node) return;
				}
			}
		},

		selectPrev() {
			let { tabIndex } = this._getTab(this._selectedID);
			this.select((this._tabs[tabIndex - 1] || this._tabs[this._tabs.length - 1]).id);
		},

		selectNext() {
			let { tabIndex } = this._getTab(this._selectedID);
			this.select((this._tabs[tabIndex + 1] || this._tabs[0]).id);
		},

		refocus() {},
		_openMenu(x, y, id) {
			log && log('menu ' + id);
		},
	};

	Zotero_Tabs.tabHooks = {
		duplicate: {
			reader: async (tab, tabIndex) => {
				Zotero_Tabs.add({ title: tab.title + ' (copy)', data: { itemID: tab.data.itemID }, index: tabIndex + 1 });
			},
		},
		undoClose: {
			reader: async (tab, tabIndex) => {
				Zotero_Tabs.add({ title: 'Reopened ' + tab.data.itemID, data: { itemID: tab.data.itemID }, index: tabIndex });
				return true;
			},
		},
	};
	return Zotero_Tabs;
}
