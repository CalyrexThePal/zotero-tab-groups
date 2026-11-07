/*
 * Tab Groups for Zotero — pure model logic.
 *
 * Nothing in this file touches the DOM or Zotero; it is loaded both into the
 * plugin scope (via Services.scriptloader.loadSubScript) and into Node for
 * unit tests.
 */

/* exported ZTG_Model */
var ZTG_Model = (function () {
	'use strict';

	// Chrome's tab group palette, in Chrome's own order.
	const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

	/**
	 * Enforce Chrome's membership invariants on a tab strip.
	 *
	 *   1. Spatial inclusion: an ungrouped run of tabs that sits between two
	 *      members of the same group joins that group.
	 *   2. Contiguity: a group is always one contiguous run of tabs. If a
	 *      group got split (e.g. a member was moved away by "Move to End"),
	 *      the longest run keeps the group; stray members are ungrouped.
	 *   3. Unknown group ids are dropped.
	 *
	 * @param {Array<string|null>} groupIds group id of each tab, in strip order
	 *   (the Library tab excluded)
	 * @param {(id: string) => boolean} groupExists
	 * @returns {Array<string|null>} normalized group ids (same length)
	 */
	function normalize(groupIds, groupExists) {
		let out = groupIds.map(g => (g && groupExists(g) ? g : null));

		// 1. Spatial inclusion
		let i = 0;
		while (i < out.length) {
			if (out[i] !== null) {
				i++;
				continue;
			}
			let start = i;
			while (i < out.length && out[i] === null) i++;
			let before = start > 0 ? out[start - 1] : null;
			let after = i < out.length ? out[i] : null;
			if (before !== null && before === after) {
				for (let j = start; j < i; j++) out[j] = before;
			}
		}

		// 2. Contiguity
		let runs = new Map(); // groupId -> [{start, length}]
		i = 0;
		while (i < out.length) {
			let g = out[i];
			let start = i;
			while (i < out.length && out[i] === g) i++;
			if (g === null) continue;
			if (!runs.has(g)) runs.set(g, []);
			runs.get(g).push({ start, length: i - start });
		}
		for (let [, groupRuns] of runs) {
			if (groupRuns.length < 2) continue;
			let keep = groupRuns.reduce((best, r) => (r.length > best.length ? r : best), groupRuns[0]);
			for (let r of groupRuns) {
				if (r === keep) continue;
				for (let j = r.start; j < r.start + r.length; j++) out[j] = null;
			}
		}
		return out;
	}

	/**
	 * Pick the color for a new group the way Chrome does: the first color in
	 * palette order that is used by the fewest existing groups.
	 *
	 * @param {string[]} usedColors colors of existing groups
	 * @returns {string}
	 */
	function pickColor(usedColors) {
		let counts = new Map(COLORS.map(c => [c, 0]));
		for (let c of usedColors) {
			if (counts.has(c)) counts.set(c, counts.get(c) + 1);
		}
		let min = Math.min(...counts.values());
		return COLORS.find(c => counts.get(c) === min);
	}

	/**
	 * Compute where a dragged unit would land on the strip.
	 *
	 * Coordinates are "flow" coordinates: distance from the start edge of the
	 * strip's scrollable content (left edge in LTR, right edge in RTL).
	 *
	 * @param {object} p
	 * @param {Array<{kind: 'tab'|'header', groupId: string|null, size: number, collapsed?: boolean}>} p.items
	 *   visible strip items in order, *excluding* the Library tab and the dragged unit
	 * @param {number} p.base flow coordinate where the first item starts
	 * @param {number} p.gap gap between items
	 * @param {'tab'|'group'} p.unitKind
	 * @param {number} p.unitSize total size of the dragged unit
	 * @param {number} p.desiredStart where the user is holding the unit's start edge
	 * @param {string|null} p.currentGroupId the dragged tab's group right now (for hysteresis)
	 * @param {number} [p.edgeSlack] how far past a group's trailing edge the tab
	 *   must travel to leave (or join) the group
	 * @returns {{index: number, groupId: string|null, starts: number[], unitStart: number}}
	 *   index: insertion index into items; groupId: group the tab would join
	 *   (always null for group drags); starts: new start of every item;
	 *   unitStart: where the unit would rest
	 */
	function computeDrop(p) {
		let { items, base, gap, unitKind, unitSize, desiredStart, currentGroupId } = p;
		let slack = p.edgeSlack !== undefined ? p.edgeSlack : Math.min(28, unitSize / 3);

		// Rest position of the unit for every insertion index
		let slotStarts = [];
		let x = base;
		for (let k = 0; k <= items.length; k++) {
			slotStarts.push(x);
			if (k < items.length) x += items[k].size + gap;
		}

		let validSlot = (k) => {
			if (unitKind !== 'group') return true;
			// A whole group can't be dropped inside another group
			let next = items[k];
			return !next || next.kind === 'header' || next.groupId === null;
		};

		let best = -1;
		let bestDist = Infinity;
		for (let k = 0; k <= items.length; k++) {
			if (!validSlot(k)) continue;
			let d = Math.abs(slotStarts[k] - desiredStart);
			if (d < bestDist) {
				bestDist = d;
				best = k;
			}
		}
		if (best === -1) best = items.length;

		let groupId = null;
		if (unitKind === 'tab') {
			let prev = items[best - 1];
			let next = items[best];
			if (prev && prev.kind === 'header') {
				// Right after a group's chip: first tab of that group
				// (a collapsed group can't take tabs; its tabs are hidden)
				groupId = prev.collapsed ? null : prev.groupId;
			}
			else if (prev && prev.kind === 'tab' && prev.groupId !== null) {
				if (next && next.kind === 'tab' && next.groupId === prev.groupId) {
					groupId = prev.groupId;
				}
				else {
					// Trailing edge of a group: in or out depends on how far the
					// user dragged, with hysteresis so it doesn't flicker
					let threshold = slotStarts[best] + (currentGroupId === prev.groupId ? slack : -slack);
					groupId = desiredStart < threshold ? prev.groupId : null;
				}
			}
		}

		let starts = items.map((item, i) => {
			let s = slotStarts[i];
			return i < best ? s : s + unitSize + gap;
		});
		return { index: best, groupId, starts, unitStart: slotStarts[best] };
	}

	/**
	 * Translate an insertion index among visible items into "insert before tab X".
	 *
	 * @param {Array<{kind: string, tabId?: string, firstTabId?: string}>} items
	 *   same list given to computeDrop; headers carry the id of the first tab
	 *   of their group
	 * @param {number} index
	 * @returns {string|null} tab id to insert before, or null to append
	 */
	function insertionAnchor(items, index) {
		let next = items[index];
		if (!next) return null;
		return next.kind === 'header' ? next.firstTabId : next.tabId;
	}

	return { COLORS, normalize, pickColor, computeDrop, insertionAnchor };
})();

if (typeof module !== 'undefined') {
	module.exports = ZTG_Model;
}
