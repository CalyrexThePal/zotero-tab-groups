/*
 * Browser harness: renders Zotero 10's real TabBar React component, driven by
 * a Zotero_Tabs stand-in, and attaches the plugin's window controller to it.
 */
/* global ZTG_Store, ZTG_WindowController, FTL_MESSAGES */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createZoteroTabs } from './zotero-tabs-shim.js';

window.Zotero = {
	rtl: false,
	dir: 'ltr',
	Utilities: {
		throttle: fn => fn,
		Internal: { renderItemTitle: t => t },
	},
};

// eslint-disable-next-line import/first
const TabBar = require('./vendor/tabBar.jsx').default;

// Minimal Fluent: variable substitution + plural selector on $count
function t(id, args = {}) {
	let msg = FTL_MESSAGES[id];
	if (msg === undefined) return id;
	msg = msg.replace(/\{\s*\$count\s*->([\s\S]*?)\n\s*\}/, (m, body) => {
		let variants = {};
		let def;
		for (let line of body.split('\n')) {
			let mm = line.match(/^\s*(\*?)\[(\w+)\]\s*(.*)$/);
			if (mm) {
				variants[mm[2]] = mm[3];
				if (mm[1]) def = mm[3];
			}
		}
		return (args.count === 1 && variants.one) || def;
	});
	return msg.replace(/\{\s*\$(\w+)\s*\}/g, (m, name) => String(args[name] ?? ''));
}

const tabBarRef = React.createRef();
const Zotero_Tabs = createZoteroTabs(tabBarRef);
window.Zotero_Tabs = Zotero_Tabs;

let prefJSON = '{}';
window.__prefs = { get: () => prefJSON, set: v => (prefJSON = v) };

function start() {
	const store = new ZTG_Store({ read: () => prefJSON, write: v => (prefJSON = v) });
	const controller = new ZTG_WindowController(window, {
		store,
		t,
		saveSession: () => Zotero_Tabs.sessionSaves++,
		logError: e => {
			console.error(e);
			(window.__errors = window.__errors || []).push(String(e && e.stack || e));
		},
	});
	controller.init();
	window.__ztg = { store, controller, t };
	window.__ready = true;
}

createRoot(document.getElementById('tab-bar-container')).render(
	<TabBar
		ref={tabBarRef}
		onTabSelect={id => Zotero_Tabs.select(id)}
		onTabMove={(id, i) => Zotero_Tabs.move(id, i)}
		onTabClose={id => Zotero_Tabs.close(id)}
		onContextMenu={(x, y, id) => Zotero_Tabs._openMenu(x, y, id)}
		onRefocus={() => {}}
		onToggleAudio={() => {}}
		onLoad={() => {
			Zotero_Tabs._update();
			setTimeout(start, 0);
		}}
	/>
);
