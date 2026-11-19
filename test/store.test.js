'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/content/store');

function makeStore(initial = '{}') {
	let json = initial;
	let timers = [];
	let store = new Store({
		read: () => json,
		write: (v) => { json = v; },
		setTimeout: (fn) => { timers.push(fn); return timers.length; },
	});
	return { store, timers, get json() { return json; } };
}

test('create picks a color and persists after the debounce', () => {
	let s = makeStore();
	let g = s.store.create({ title: 'Reading' });
	assert.equal(g.title, 'Reading');
	assert.equal(g.color, 'grey');
	assert.equal(s.json, '{}', 'not written yet');
	s.store.flush();
	let saved = JSON.parse(s.json);
	assert.equal(saved.groups[g.id].title, 'Reading');
});

test('load restores groups and sanitizes bad data', () => {
	let s = makeStore(JSON.stringify({ groups: {
		a: { title: 'A', color: 'blue', collapsed: true },
		b: { title: 5, color: 'nope' },
		c: null,
	} }));
	assert.deepEqual(s.store.get('a'), { id: 'a', title: 'A', color: 'blue', collapsed: true });
	assert.deepEqual(s.store.get('b'), { id: 'b', title: '', color: 'grey', collapsed: false });
	assert.equal(s.store.has('c'), false);
});

test('load tolerates corrupt JSON', () => {
	let s = makeStore('{not json');
	assert.deepEqual(s.store.all(), []);
});

test('update validates colors and emits only on change', () => {
	let s = makeStore();
	let g = s.store.create({});
	let events = [];
	s.store.subscribe(e => events.push(e.type));
	s.store.update(g.id, { color: 'not-a-color' });
	assert.equal(s.store.get(g.id).color, g.color);
	assert.deepEqual(events, []);
	s.store.update(g.id, { color: 'red', collapsed: true });
	assert.equal(s.store.get(g.id).color, 'red');
	assert.equal(s.store.get(g.id).collapsed, true);
	assert.deepEqual(events, ['update']);
});

test('remove then resurrect brings a group back expanded', () => {
	let s = makeStore();
	let g = s.store.create({ title: 'T' });
	s.store.update(g.id, { collapsed: true });
	s.store.remove(g.id);
	assert.equal(s.store.has(g.id), false);
	assert.equal(s.store.resurrect(g.id), true);
	assert.equal(s.store.get(g.id).title, 'T');
	assert.equal(s.store.get(g.id).collapsed, false);
	assert.equal(s.store.resurrect('unknown'), false);
});

test('writes are debounced into one', () => {
	let s = makeStore();
	s.store.create({});
	s.store.create({});
	assert.equal(s.timers.length, 1);
});
