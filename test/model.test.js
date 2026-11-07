'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/content/model.js');

const exists = id => ['a', 'b', 'c'].includes(id);

test('normalize: unknown groups are dropped', () => {
	assert.deepEqual(M.normalize(['a', 'zzz', null], exists), ['a', null, null]);
});

test('normalize: tabs enclosed by one group join it', () => {
	assert.deepEqual(M.normalize(['a', null, null, 'a', 'b'], exists), ['a', 'a', 'a', 'a', 'b']);
});

test('normalize: tabs between different groups stay ungrouped', () => {
	assert.deepEqual(M.normalize(['a', null, 'b'], exists), ['a', null, 'b']);
});

test('normalize: leading/trailing ungrouped tabs are untouched', () => {
	assert.deepEqual(M.normalize([null, 'a', 'a', null], exists), [null, 'a', 'a', null]);
});

test('normalize: split group keeps the longest run', () => {
	assert.deepEqual(M.normalize(['a', 'b', 'a', 'a'], exists), [null, 'b', 'a', 'a']);
});

test('normalize: split group tie keeps the first run', () => {
	assert.deepEqual(M.normalize(['a', 'b', 'a'], exists), ['a', 'b', null]);
});

test('pickColor follows palette order, least-used first', () => {
	assert.equal(M.pickColor([]), 'grey');
	assert.equal(M.pickColor(['grey']), 'blue');
	assert.equal(M.pickColor(['grey', 'blue']), 'red');
	assert.equal(M.pickColor(M.COLORS), 'grey');
	assert.equal(M.pickColor([...M.COLORS, 'grey']), 'blue');
});

// Strip: [T1][H(a)][A1][A2][T2] with sizes 100, header 40, gap 4, base 0
function strip() {
	return [
		{ kind: 'tab', tabId: 't1', groupId: null, size: 100 },
		{ kind: 'header', groupId: 'a', firstTabId: 'a1', size: 40, collapsed: false },
		{ kind: 'tab', tabId: 'a1', groupId: 'a', size: 100 },
		{ kind: 'tab', tabId: 'a2', groupId: 'a', size: 100 },
		{ kind: 'tab', tabId: 't2', groupId: null, size: 100 },
	];
}
// slot starts: 0, 104, 148, 252, 356, 460

test('computeDrop: nearest slot wins', () => {
	let r = M.computeDrop({ items: strip(), base: 0, gap: 4, unitKind: 'tab', unitSize: 100, desiredStart: 10, currentGroupId: null });
	assert.equal(r.index, 0);
	assert.equal(r.groupId, null);
	assert.deepEqual(r.starts, [104, 208, 252, 356, 460]);
});

test('computeDrop: right after a header joins the group', () => {
	let r = M.computeDrop({ items: strip(), base: 0, gap: 4, unitKind: 'tab', unitSize: 100, desiredStart: 150, currentGroupId: null });
	assert.equal(r.index, 2);
	assert.equal(r.groupId, 'a');
});

test('computeDrop: right after a collapsed header does not join', () => {
	let items = strip();
	items[1].collapsed = true;
	items.splice(2, 2);
	let r = M.computeDrop({ items, base: 0, gap: 4, unitKind: 'tab', unitSize: 100, desiredStart: 150, currentGroupId: null });
	assert.equal(r.index, 2);
	assert.equal(r.groupId, null);
});

test('computeDrop: between two members joins', () => {
	let r = M.computeDrop({ items: strip(), base: 0, gap: 4, unitKind: 'tab', unitSize: 100, desiredStart: 250, currentGroupId: null });
	assert.equal(r.index, 3);
	assert.equal(r.groupId, 'a');
});

test('computeDrop: trailing edge has hysteresis', () => {
	let base = { items: strip(), base: 0, gap: 4, unitKind: 'tab', unitSize: 100, edgeSlack: 20 };
	// slot 4 starts at 356
	assert.equal(M.computeDrop({ ...base, desiredStart: 356, currentGroupId: 'a' }).groupId, 'a');
	assert.equal(M.computeDrop({ ...base, desiredStart: 356, currentGroupId: null }).groupId, null);
	assert.equal(M.computeDrop({ ...base, desiredStart: 330, currentGroupId: null }).groupId, 'a');
	assert.equal(M.computeDrop({ ...base, desiredStart: 380, currentGroupId: 'a' }).groupId, null);
});

test('computeDrop: a group cannot be dropped inside another group', () => {
	let r = M.computeDrop({ items: strip(), base: 0, gap: 4, unitKind: 'group', unitSize: 200, desiredStart: 250, currentGroupId: null });
	assert.ok([1, 4].includes(r.index), `index ${r.index}`);
	assert.equal(r.groupId, null);
	r = M.computeDrop({ items: strip(), base: 0, gap: 4, unitKind: 'group', unitSize: 200, desiredStart: 330, currentGroupId: null });
	assert.equal(r.index, 4);
});

test('insertionAnchor maps headers to their first tab', () => {
	assert.equal(M.insertionAnchor(strip(), 1), 'a1');
	assert.equal(M.insertionAnchor(strip(), 0), 't1');
	assert.equal(M.insertionAnchor(strip(), 5), null);
});
