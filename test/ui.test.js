/*
 * UI tests: drive Zotero 10's real TabBar component (in the harness) with a
 * real browser and real mouse input, with the plugin controller attached.
 *
 *   npm run test:ui          (builds the harness first)
 *   SHOTS=dir npm run test:ui  also writes screenshots to `dir`
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const URL = 'file://' + path.join(__dirname, 'harness/dist/index.html');
const SHOTS = process.env.SHOTS;
const TITLES = [
	'Smith 2020 – Deep learning', 'Doe 2019 – Graph theory', 'Lee 2021 – Protein folding',
	'Kim 2018 – Climate models', 'Wu 2022 – Medical imaging', 'Park 2017 – Economics',
];

let browser;
test.before(async () => {
	browser = await chromium.launch();
	if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
});
test.after(async () => {
	await browser.close();
});

async function setup({ colorScheme = 'light', width = 1200, tabs = TITLES } = {}) {
	let page = await browser.newPage({ viewport: { width, height: 360 }, colorScheme });
	let errors = [];
	page.on('pageerror', e => errors.push(e.message));
	await page.goto(URL);
	await page.waitForFunction(() => window.__ready);
	await page.evaluate((titles) => {
		titles.forEach((t, i) => Zotero_Tabs.add({ title: t, data: { itemID: 100 + i } }));
	}, tabs);
	await page.waitForTimeout(50);
	page.errors = errors;
	return page;
}

const ids = page => page.evaluate(() => Zotero_Tabs._tabs.slice(1).map(t => t.id));
const groupsOf = page => page.evaluate(() => Zotero_Tabs._tabs.slice(1).map(t => t.data.tabGroupId || null));
const strip = page => page.evaluate(() => Array.from(document.querySelectorAll('.tabs-wrapper > .tabs > *'))
	.map((el) => {
		if (el.classList.contains('ztg-header')) return 'H:' + (el.querySelector('.ztg-title').textContent || '·');
		if (el.classList.contains('tab')) return el.dataset.id + (el.hasAttribute('ztg-hidden') ? '(hidden)' : '');
		return null;
	}).filter(Boolean));

async function group(page, tabIds, title = '', opts = {}) {
	return page.evaluate(({ tabIds, title, opts }) => {
		let c = __ztg.controller;
		let gid = c.addTabToNewGroup(tabIds[0], { openEditor: false });
		for (let id of tabIds.slice(1)) c.addTabToGroup(id, gid);
		__ztg.store.update(gid, Object.assign({ title }, opts));
		return gid;
	}, { tabIds, title, opts });
}

// Let chip/color transitions finish before measuring
const settle = page => page.waitForTimeout(260);

async function center(page, selector) {
	let box = await page.locator(selector).first().boundingBox();
	return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function drag(page, from, toX, { steps = 12, release = true } = {}) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + Math.sign(toX - from.x) * 6, from.y, { steps: 2 });
	await page.mouse.move(toX, from.y, { steps });
	if (release) {
		await page.mouse.up();
		await page.waitForTimeout(320);
	}
}

async function shot(page, name) {
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), clip: { x: 0, y: 0, width: page.viewportSize().width, height: 46 } });
}

const tabSel = id => `.tabs-wrapper .tab[data-id="${id}"]`;
const headerSel = gid => `.ztg-header[data-ztg-group-id="${gid}"]`;

test('creating a group draws a chip before its first tab and a color bar under members', async () => {
	let page = await setup();
	let [a, b, c] = await ids(page);
	let gid = await group(page, [b, c], 'Reading');
	assert.deepEqual(await strip(page), ['zotero-pane', a, 'H:Reading', b, c, ...(await ids(page)).slice(3)]);
	let attrs = await page.evaluate(id => {
		let el = document.querySelector(`.tabs-wrapper .tab[data-id="${id}"]`);
		return [el.getAttribute('ztg-group'), el.getAttribute('ztg-color'), getComputedStyle(el, '::after').backgroundColor];
	}, b);
	assert.equal(attrs[0], gid);
	assert.equal(attrs[1], 'grey');
	assert.notEqual(attrs[2], 'rgba(0, 0, 0, 0)');
	await shot(page, '01-group');
	assert.deepEqual(page.errors, []);
	await page.close();
});

test('"Add Tab to New Group" opens the editor bubble; name and color apply live', async () => {
	let page = await setup();
	let [, b] = await ids(page);
	let gid = await page.evaluate(id => __ztg.controller.addTabToNewGroup(id), b);
	await page.waitForTimeout(50);
	assert.ok(await page.locator('.ztg-editor').isVisible());
	assert.equal(await page.evaluate(() => document.activeElement.className), 'ztg-editor-name');
	await page.keyboard.type('Methods');
	await page.locator('.ztg-swatch[ztg-color="blue"]').click();
	assert.equal(await page.locator('.ztg-editor-name').evaluate(el => el === document.activeElement), true);
	await shot(page, '02-editor');
	assert.equal(await page.locator(headerSel(gid) + ' .ztg-title').textContent(), 'Methods');
	assert.equal(await page.locator(headerSel(gid)).getAttribute('ztg-color'), 'blue');
	await page.keyboard.press('Enter');
	assert.equal(await page.locator('.ztg-editor').count(), 0);
	// Persisted
	await page.waitForTimeout(300);
	let saved = JSON.parse(await page.evaluate(() => __prefs.get()));
	assert.deepEqual(saved.groups[gid], { title: 'Methods', color: 'blue', collapsed: false });
	// Right-clicking the chip reopens it; clicking outside closes it
	await page.locator(headerSel(gid)).click({ button: 'right' });
	assert.ok(await page.locator('.ztg-editor').isVisible());
	await page.mouse.click(600, 200);
	assert.equal(await page.locator('.ztg-editor').count(), 0);
	assert.deepEqual(page.errors, []);
	await page.close();
});

test('new groups get Chrome\'s colors in order', async () => {
	let page = await setup();
	let all = await ids(page);
	let colors = [];
	for (let id of all.slice(0, 4)) {
		let gid = await page.evaluate(id => __ztg.controller.addTabToNewGroup(id, { openEditor: false }), id);
		colors.push(await page.evaluate(gid => __ztg.store.get(gid).color, gid));
	}
	assert.deepEqual(colors, ['grey', 'blue', 'red', 'yellow']);
	await page.close();
});

test('clicking the chip collapses and expands the group; selection leaves a collapsing group', async () => {
	let page = await setup();
	let [a, b, c, d] = await ids(page);
	let gid = await group(page, [b, c], 'Reading', { color: 'green' });
	await page.evaluate(id => Zotero_Tabs.select(id), c);
	await settle(page);
	let before = (await page.locator(tabSel(d)).boundingBox()).x;
	await page.locator(headerSel(gid)).click();
	await page.waitForTimeout(320);
	assert.equal(await page.evaluate(() => Zotero_Tabs._selectedID), d, 'selection moves to the tab after the group');
	assert.deepEqual(await strip(page), ['zotero-pane', a, 'H:Reading', b + '(hidden)', c + '(hidden)', d, ...(await ids(page)).slice(4)]);
	assert.equal(await page.locator(tabSel(b)).isVisible(), false);
	assert.equal(await page.locator(headerSel(gid) + ' .ztg-count').textContent(), '2');
	assert.ok(await page.locator(headerSel(gid) + ' .ztg-count').isVisible());
	let after = (await page.locator(tabSel(d)).boundingBox()).x;
	assert.ok(after < before - 150, `tabs after the group slide left (${before} -> ${after})`);
	assert.equal(await page.locator(headerSel(gid)).getAttribute('aria-expanded'), 'false');
	await shot(page, '03-collapsed');
	await page.locator(headerSel(gid)).click();
	await page.waitForTimeout(320);
	assert.equal(await page.locator(tabSel(b)).isVisible(), true);
	let restored = (await page.locator(tabSel(d)).boundingBox()).x;
	assert.ok(Math.abs(restored - before) < 1, `restored ${restored} vs ${before}`);
	let saved = JSON.parse(await page.evaluate(() => __prefs.get()));
	assert.equal(saved.groups[gid].collapsed, false);
	assert.deepEqual(page.errors, []);
	await page.close();
});

test('selecting a tab of a collapsed group expands it; Ctrl+Tab (selectNext) skips collapsed tabs', async () => {
	let page = await setup();
	let [a, b, c, d] = await ids(page);
	let gid = await group(page, [b, c]);
	await page.evaluate(id => Zotero_Tabs.select(id), a);
	await page.evaluate(gid => __ztg.controller.toggleCollapsed(gid, true), gid);
	await page.evaluate(() => Zotero_Tabs.selectNext());
	assert.equal(await page.evaluate(() => Zotero_Tabs._selectedID), d);
	await page.evaluate(() => Zotero_Tabs.selectPrev());
	assert.equal(await page.evaluate(() => Zotero_Tabs._selectedID), a);
	assert.equal(await page.evaluate(gid => __ztg.store.get(gid).collapsed, gid), true);
	// e.g. picking the tab from Zotero's "List all tabs" menu
	await page.evaluate(id => Zotero_Tabs.select(id), c);
	assert.equal(await page.evaluate(gid => __ztg.store.get(gid).collapsed, gid), false);
	await page.waitForTimeout(260);
	assert.equal(await page.locator(tabSel(c)).isVisible(), true);
	await page.close();
});

test('dragging an ungrouped tab between two members adds it to the group', async () => {
	let page = await setup();
	let [a, b, c, d, e] = await ids(page);
	let gid = await group(page, [b, c, d], 'G', { color: 'purple' });
	let from = await center(page, tabSel(e));
	let target = await center(page, tabSel(c));
	// Hold the tab so that its start edge passes the middle of c
	await drag(page, from, target.box.x + target.box.width + target.box.width * 0.25, { release: false });
	await shot(page, '04-dragging');
	await page.mouse.up();
	await page.waitForTimeout(320);
	assert.deepEqual(await ids(page), [a, b, c, e, d, ...(await ids(page)).slice(5)]);
	assert.equal(await page.evaluate(id => Zotero_Tabs._getTab(id).tab.data.tabGroupId, e), gid);
	// Transforms are cleaned up
	let transforms = await page.evaluate(() => Array.from(document.querySelectorAll('.tabs-wrapper .tabs > *')).map(el => el.style.transform).filter(Boolean));
	assert.deepEqual(transforms, []);
	assert.deepEqual(page.errors, []);
	await page.close();
});

test('starting a drag in small steps does not leave tab text selected', async () => {
	let page = await setup();
	let [a, b, c, d, e] = await ids(page);
	await group(page, [b, c], 'G');
	let name = await page.locator(tabSel(e) + ' .tab-name').boundingBox();
	let x = name.x + name.width / 2, y = name.y + name.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	// Tiny first moves (below the drag threshold) are how a real hand starts
	for (let i = 1; i <= 3; i++) await page.mouse.move(x - i * 2, y);
	await page.mouse.move(x - 200, y, { steps: 10 });
	assert.equal(await page.evaluate(() => String(getSelection())), '', 'no selection while dragging');
	await page.mouse.up();
	await page.waitForTimeout(320);
	assert.equal(await page.evaluate(() => String(getSelection())), '', 'no selection after the drop');
	assert.equal(await page.evaluate(id => getComputedStyle(document.querySelector(`.tabs-wrapper .tab[data-id="${id}"]`)).userSelect, a), 'none');
	await page.close();
});

test('while a tab hovers over a group, the group bar is continuous through the gap it will fill', async () => {
	let page = await setup();
	let [a, b, c, d, e] = await ids(page);
	let gid = await group(page, [b, c, d], 'G');
	let from = await center(page, tabSel(e));
	let cBox = (await center(page, tabSel(c))).box;
	// Hold e so it would land between c and d (inside the group), displaced from its slot
	await drag(page, from, cBox.x + cBox.width + 60, { release: false });
	let bridge = () => page.evaluate(() => Array.from(document.querySelectorAll('.tabs-wrapper .tabs > *'))
		.filter(el => el.style.getPropertyValue('--ztg-bridge'))
		.map(el => ({ id: el.dataset.id || 'H', px: parseFloat(el.style.getPropertyValue('--ztg-bridge')), right: parseFloat(getComputedStyle(el, '::after').right) })));
	let during = await bridge();
	assert.equal(during.length, 1, 'exactly one element bridges the hole');
	assert.equal(during[0].id, c, 'the member right before the slot bridges it');
	assert.ok(during[0].px >= from.box.width, `bridge spans the dragged tab (${during[0].px})`);
	assert.ok(during[0].right <= -during[0].px, `bar actually extends (${during[0].right})`);
	// Dragging out of the group removes the bridge again
	await page.mouse.move(from.x + 300, from.y, { steps: 8 });
	assert.deepEqual(await bridge(), []);
	await page.mouse.move(cBox.x + cBox.width + 60, from.y, { steps: 8 });
	assert.equal((await bridge()).length, 1);
	await page.mouse.up();
	await page.waitForTimeout(320);
	assert.deepEqual(await bridge(), [], 'bridge is cleaned up after the drop');
	assert.equal(await page.evaluate(id => Zotero_Tabs._getTab(id).tab.data.tabGroupId, e), gid);
	assert.deepEqual(page.errors, []);
	await page.close();
});

test('native dragstart is cancelled whatever part of a tab it starts on (Gecko targets the title text node)', async () => {
	let page = await setup();
	let [a, b] = await ids(page);
	let gid = await group(page, [b], 'G');
	let result = await page.evaluate(({ a, gid }) => {
		let fire = (node) => {
			let ev = new DragEvent('dragstart', { bubbles: true, cancelable: true });
			node.dispatchEvent(ev);
			return ev.defaultPrevented;
		};
		let tab = document.querySelector(`.tabs-wrapper .tab[data-id="${a}"]`);
		let nameText = tab.querySelector('.tab-name').firstChild;
		let chipText = document.querySelector(`.ztg-header[data-ztg-group-id="${gid}"] .ztg-title`).firstChild;
		return {
			nameTextNode: nameText.nodeType === 3 && fire(nameText),
			nameElement: fire(tab.querySelector('.tab-name')),
			icon: fire(tab.querySelector('.tab-icon')),
			chipTextNode: !chipText || fire(chipText),
			// Anything outside the strip is none of our business
			content: !fire(document.getElementById('content')),
		};
	}, { a, gid });
	assert.deepEqual(result, { nameTextNode: true, nameElement: true, icon: true, chipTextNode: true, content: true });
	await page.close();
});

test('a tab dropped on a collapsed group\'s chip joins the group at its end', async () => {
	let page = await setup();
	let [a, b, c, d, e, f] = await ids(page);
	let gid = await group(page, [b, c], 'Pair', { color: 'red' });
	await page.evaluate(g => __ztg.controller.toggleCollapsed(g, true), gid);
	await page.waitForTimeout(300);
	let from = await center(page, tabSel(e));
	let chip = (await center(page, headerSel(gid))).box;
	// Hold e so that its start edge is over the chip's middle
	await drag(page, from, chip.x + chip.width / 2 + from.box.width / 2, { release: false });
	assert.equal(await page.evaluate(() => __ztg.controller._drag.result.groupId), gid, 'previews joining');
	await shot(page, '06-drop-on-collapsed-chip');
	await page.mouse.up();
	await page.waitForTimeout(320);
	assert.deepEqual(await ids(page), [a, b, c, e, d, f]);
	assert.deepEqual(await groupsOf(page), [null, gid, gid, gid, null, null]);
	// The dragged tab is the selected one, and a selected tab can't hide
	// inside a collapsed group, so the group opens (like Chrome)
	assert.equal(await page.evaluate(g => __ztg.store.get(g).collapsed, gid), false);
	assert.equal(await page.locator(tabSel(e)).isVisible(), true);
	assert.deepEqual(page.errors, []);
	await page.close();
});

test('dragging a member far outside the group removes it from the group', async () => {
	let page = await setup();
	let [a, b, c, d, e, f] = await ids(page);
	let gid = await group(page, [b, c, d]);
	let from = await center(page, tabSel(c));
	let target = await center(page, tabSel(f));
	await drag(page, from, target.x + 40);
	assert.deepEqual(await ids(page), [a, b, d, e, f, c]);
	assert.deepEqual(await groupsOf(page), [null, gid, gid, null, null, null]);
	await page.close();
});

test('a tab dropped right after a group\'s last tab joins it; a bit further it stays out', async () => {
	let page = await setup();
	let [a, b, c, d, e] = await ids(page);
	let gid = await group(page, [b, c]);
	// Drag e left to sit right after c, overlapping c a little -> joins
	let from = await center(page, tabSel(e));
	let cBox = (await center(page, tabSel(c))).box;
	await drag(page, from, cBox.x + cBox.width + from.box.width / 2 - 30);
	assert.deepEqual(await ids(page), [a, b, c, e, d, ...(await ids(page)).slice(5)]);
	assert.equal(await page.evaluate(id => Zotero_Tabs._getTab(id).tab.data.tabGroupId || null, e), gid);
	// Drag d (now right after the group) a bit right: stays out of the group
	let dFrom = await center(page, tabSel(d));
	await drag(page, dFrom, dFrom.x + 10);
	assert.equal(await page.evaluate(id => Zotero_Tabs._getTab(id).tab.data.tabGroupId || null, d), null);
	await page.close();
});

test('dragging a group chip moves the whole group as one unit', async () => {
	let page = await setup();
	let [a, b, c, d, e, f] = await ids(page);
	let gid = await group(page, [b, c], 'Pair', { color: 'red' });
	let from = await center(page, headerSel(gid));
	let fBox = (await center(page, tabSel(f))).box;
	await drag(page, from, fBox.x + fBox.width - 10, { release: false });
	await shot(page, '05-dragging-group');
	await page.mouse.up();
	await page.waitForTimeout(320);
	assert.deepEqual(await ids(page), [a, d, e, f, b, c]);
	assert.deepEqual(await groupsOf(page), [null, null, null, null, gid, gid]);
	assert.deepEqual((await strip(page)).slice(-3), ['H:Pair', b, c]);
	// And back to the start
	let from2 = await center(page, headerSel(gid));
	let aBox = (await center(page, tabSel(a))).box;
	await drag(page, from2, aBox.x + aBox.width + 10);
	assert.deepEqual(await ids(page), [a, b, c, d, e, f]);
	assert.deepEqual(page.errors, []);
	await page.close();
});

test('a collapsed group can be dragged too, and a group never lands inside another group', async () => {
	let page = await setup();
	let [a, b, c, d, e, f] = await ids(page);
	let g1 = await group(page, [b, c], 'One');
	let g2 = await group(page, [d, e, f], 'Two', { color: 'cyan' });
	await page.evaluate(g => __ztg.controller.toggleCollapsed(g, true), g1);
	await page.waitForTimeout(260);
	let from = await center(page, headerSel(g1));
	let eBox = (await center(page, tabSel(e))).box;
	// Aim at the middle of group Two
	await drag(page, from, eBox.x + eBox.width / 2);
	let order = await ids(page);
	let groups = await groupsOf(page);
	// Group Two must still be contiguous and group One intact
	let runs = groups.map((g, i) => (i === 0 || groups[i - 1] !== g ? g : null)).filter(Boolean);
	assert.deepEqual(runs.sort(), [g1, g2].sort(), `order ${order} groups ${groups}`);
	assert.equal(groups.filter(g => g === g2).length, 3);
	assert.equal(groups.filter(g => g === g1).length, 2);
	await page.close();
});

test('Escape cancels a drag', async () => {
	let page = await setup();
	let before = await ids(page);
	let from = await center(page, tabSel(before[0]));
	await drag(page, from, from.x + 400, { release: false });
	await page.keyboard.press('Escape');
	await page.mouse.up();
	await page.waitForTimeout(320);
	assert.deepEqual(await ids(page), before);
	await page.close();
});

test('a plain click on a tab still selects it, and a click on its close button still closes it', async () => {
	let page = await setup();
	let [, b, c] = await ids(page);
	await group(page, [b, c]);
	await page.locator(tabSel(c)).click();
	assert.equal(await page.evaluate(() => Zotero_Tabs._selectedID), c);
	await page.locator(tabSel(b) + ' .tab-close').click();
	assert.ok(!(await ids(page)).includes(b));
	await page.close();
});

test('membership rules: tabs opened inside a group join it; tabs moved away leave it', async () => {
	let page = await setup();
	let [a, b, c, d] = await ids(page);
	let gid = await group(page, [b, c, d]);
	// A tab inserted between members (e.g. opened next to them) joins
	let n = await page.evaluate(() => Zotero_Tabs.add({ title: 'New', data: { itemID: 999 }, index: 3 }).id);
	assert.equal(await page.evaluate(id => Zotero_Tabs._getTab(id).tab.data.tabGroupId, n), gid);
	// Zotero's own "Move to End" on a middle member takes it out of the group
	await page.evaluate(id => Zotero_Tabs.move(id, Zotero_Tabs._tabs.length), c);
	assert.equal(await page.evaluate(id => Zotero_Tabs._getTab(id).tab.data.tabGroupId || null, c), null);
	let groups = await groupsOf(page);
	assert.deepEqual(groups.slice(0, 5), [null, gid, gid, gid, null]);
	void a;
	await page.close();
});

test('remove from group / ungroup / close group (+ undo close restores the group)', async () => {
	let page = await setup();
	let [a, b, c, d, e] = await ids(page);
	let gid = await group(page, [b, c, d], 'Trio', { color: 'orange' });
	await page.evaluate(id => __ztg.controller.removeTabFromGroup(id), c);
	assert.deepEqual((await ids(page)).slice(0, 4), [a, b, d, c]);
	assert.deepEqual((await groupsOf(page)).slice(0, 4), [null, gid, gid, null]);

	await page.evaluate(gid => __ztg.controller.closeGroup(gid), gid);
	await page.waitForTimeout(50);
	assert.deepEqual(await ids(page), [a, c, e, (await ids(page))[3]]);
	assert.equal(await page.locator('.ztg-header').count(), 0);
	await page.evaluate(() => Zotero_Tabs.undoClose());
	await page.waitForTimeout(100);
	let reopened = await page.evaluate(() => Zotero_Tabs._tabs.slice(1).filter(t => t.data.tabGroupId).map(t => t.data.itemID));
	assert.deepEqual(reopened, [101, 103]);
	let g = await page.evaluate(() => __ztg.store.all().map(g => [g.title, g.color]));
	assert.deepEqual(g, [['Trio', 'orange']]);
	assert.equal(await page.locator('.ztg-header .ztg-title').textContent(), 'Trio');

	let gid2 = await page.evaluate(() => __ztg.store.all()[0].id);
	await page.evaluate(gid => __ztg.controller.ungroup(gid), gid2);
	assert.deepEqual((await groupsOf(page)).filter(Boolean), []);
	assert.equal(await page.locator('.ztg-header').count(), 0);
	assert.equal(await page.evaluate(() => __ztg.store.all().length), 0);
	assert.deepEqual(page.errors, []);
	await page.close();
});

test('a duplicated tab joins its source tab\'s group; an emptied group disappears', async () => {
	let page = await setup();
	let [, b, c] = await ids(page);
	let gid = await group(page, [b, c]);
	await page.evaluate(id => Zotero_Tabs.tabHooks.duplicate.reader(Zotero_Tabs._getTab(id).tab, Zotero_Tabs._getTab(id).tabIndex), c);
	await page.waitForTimeout(50);
	let groups = await groupsOf(page);
	assert.deepEqual(groups.slice(0, 4), [null, gid, gid, gid]);
	// Close all of them one by one -> group is purged
	for (let id of await page.evaluate(gid => Zotero_Tabs._tabs.filter(t => t.data.tabGroupId === gid).map(t => t.id), gid)) {
		await page.evaluate(id => Zotero_Tabs.close(id), id);
	}
	await page.waitForTimeout(500);
	assert.equal(await page.evaluate(() => __ztg.store.all().length), 0);
	await page.close();
});

test('groups survive a restart (membership in tab session data, metadata in prefs)', async () => {
	let page = await setup();
	let [, b, c, d, e] = await ids(page);
	let g1 = await group(page, [b, c], 'Kept', { color: 'pink' });
	let g2 = await group(page, [d, e], '', { color: 'blue' });
	await page.evaluate(g => __ztg.controller.toggleCollapsed(g, true), g2);
	await page.waitForTimeout(300);
	let session = await page.evaluate(() => JSON.stringify(Zotero_Tabs.getState()));
	let prefs = await page.evaluate(() => __prefs.get());
	await page.close();

	// "Restart": new window, prefs loaded first, then Zotero restores the tabs
	let page2 = await browser.newPage({ viewport: { width: 1200, height: 360 } });
	await page2.goto(URL);
	await page2.waitForFunction(() => window.__ready);
	await page2.evaluate(({ session, prefs }) => {
		__prefs.set(prefs);
		__ztg.store.load();
		for (let tab of JSON.parse(session).slice(1)) {
			Zotero_Tabs.add({ title: tab.title, data: tab.data });
		}
	}, { session, prefs });
	await page2.waitForTimeout(100);
	let s = await strip(page2);
	assert.equal(s.filter(x => x.startsWith('H:')).length, 2);
	assert.ok(s.includes('H:Kept'));
	assert.equal(s.filter(x => x.endsWith('(hidden)')).length, 2);
	let colors = await page2.evaluate(() => __ztg.store.all().map(g => g.color).sort());
	assert.deepEqual(colors, ['blue', 'pink']);
	void g1;
	await shot(page2, '06-restored');
	await page2.close();
});

test('dark mode renders lighter group colors', async () => {
	let page = await setup({ colorScheme: 'dark' });
	let [, b, c, d] = await ids(page);
	await group(page, [b, c], 'Dark', { color: 'blue' });
	await group(page, [d], '', { color: 'green' });
	await settle(page);
	let color = await page.locator('.ztg-chip').first().evaluate(el => getComputedStyle(el).backgroundColor);
	assert.equal(color, 'rgb(138, 180, 248)');
	await shot(page, '07-dark');
	await page.close();
});

test('with many tabs (scrolling strip) dragging still works and auto-scrolls', async () => {
	let many = Array.from({ length: 18 }, (_, i) => `Paper ${i + 1} – Some long title`);
	let page = await setup({ tabs: many, width: 900 });
	let all = await ids(page);
	let gid = await group(page, all.slice(2, 5), 'Scroll');
	await page.evaluate(() => {
		document.querySelector('.tabs-wrapper > .tabs').scrollLeft = 0;
	});
	await page.waitForTimeout(100);
	let from = await center(page, tabSel(all[0]));
	let stripBox = await page.locator('.tabs-wrapper > .tabs').boundingBox();
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(stripBox.x + stripBox.width - 5, from.y, { steps: 10 });
	await page.waitForTimeout(600);
	let scrolled = await page.evaluate(() => document.querySelector('.tabs-wrapper > .tabs').scrollLeft);
	await page.mouse.up();
	await page.waitForTimeout(320);
	assert.ok(scrolled > 50, `auto-scrolled ${scrolled}px`);
	let order = await ids(page);
	assert.ok(order.indexOf(all[0]) > 5, `moved to ${order.indexOf(all[0])}`);
	assert.deepEqual((await groupsOf(page)).filter(g => g === gid).length, 3);
	assert.deepEqual(page.errors, []);
	await page.close();
});

test('controller.destroy() removes every trace from the strip', async () => {
	let page = await setup();
	let [, b, c] = await ids(page);
	await group(page, [b, c], 'Bye');
	await page.evaluate(() => __ztg.controller.destroy());
	let leftovers = await page.evaluate(() => ({
		headers: document.querySelectorAll('.ztg-header').length,
		attrs: Array.from(document.querySelectorAll('.tab')).filter(el => Array.from(el.attributes).some(a => a.name.startsWith('ztg-'))).length,
		draggable: Array.from(document.querySelectorAll('.tabs-wrapper .tab')).map(el => el.getAttribute('draggable')),
	}));
	assert.equal(leftovers.headers, 0);
	assert.equal(leftovers.attrs, 0);
	assert.ok(leftovers.draggable.every(v => v === 'true'));
	// Zotero's original methods are restored
	assert.equal(await page.evaluate(() => Zotero_Tabs._update.toString().includes('_beforeUpdate')), false);
	await page.close();
});

test('closing the selected tab never lands inside a collapsed group', async () => {
	let page = await setup();
	let [a, b, c, d] = await ids(page);
	let gid = await group(page, [b, c]);
	await page.evaluate(g => __ztg.controller.toggleCollapsed(g, true), gid);
	await page.locator(tabSel(a)).click();
	await page.evaluate(() => Zotero_Tabs.close());
	assert.equal(await page.evaluate(() => Zotero_Tabs._selectedID), d);
	assert.equal(await page.evaluate(g => __ztg.store.get(g).collapsed, gid), true);
	await page.close();
});

test('clicking a chip does not steal keyboard focus; Ctrl+Arrow focus skips hidden tabs and stops on chips', async () => {
	let page = await setup();
	let [a, b, c, d] = await ids(page);
	let g1 = await group(page, [b, c]);
	await page.locator(tabSel(a)).click();
	let before = await page.evaluate(() => document.activeElement.getAttribute('data-id'));
	await page.locator(headerSel(g1)).click();
	await page.waitForTimeout(260);
	assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-id')), before);
	// Group is now collapsed: a -> chip -> d
	await page.evaluate(id => document.querySelector(`.tabs-wrapper .tab[data-id="${id}"]`).focus(), a);
	await page.evaluate(() => Zotero_Tabs.moveFocus('next'));
	assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-ztg-group-id')), g1);
	await page.keyboard.press('Enter');
	assert.equal(await page.evaluate(g => __ztg.store.get(g).collapsed, g1), false);
	await page.evaluate(g => __ztg.controller.toggleCollapsed(g, true), g1);
	await page.evaluate(() => Zotero_Tabs.moveFocus('next'));
	assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-id')), d);
	await page.evaluate(() => Zotero_Tabs.moveFocus('previous'));
	await page.evaluate(() => Zotero_Tabs.moveFocus('previous'));
	assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-id')), a);
	await page.close();
});

test('tabs restored into a collapsed group appear collapsed without animating', async () => {
	let page = await setup({ tabs: ['One'] });
	let widths = await page.evaluate(async () => {
		let g = __ztg.store.create({ title: 'Saved' });
		__ztg.store.update(g.id, { collapsed: true });
		Zotero_Tabs.add({ title: 'Restored A', data: { itemID: 1, tabGroupId: g.id } });
		Zotero_Tabs.add({ title: 'Restored B', data: { itemID: 2, tabGroupId: g.id } });
		// first frame after React renders the new tabs
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
		return Array.from(document.querySelectorAll('.tabs-wrapper .tab[ztg-hidden]')).map(el => el.getBoundingClientRect().width);
	});
	assert.deepEqual(widths, [0, 0]);
	await page.close();
});
