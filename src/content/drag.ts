/*
 * Tab Groups for Zotero — pointer-driven dragging.
 *
 * Replaces Zotero's HTML5 tab drag. Drop positions are computed once at drag
 * start (`computeDrop` in model.ts), and tabs move with CSS transforms until
 * the drop is committed through Zotero_Tabs.
 *
 * Phases: idle -> pending (pressed, below the threshold) -> dragging ->
 * settling (committed; waiting for React to render the new order) -> idle.
 */

import * as Model from './model';
import type { DropItem, DropResult } from './model';
import { LIBRARY_TAB_ID } from './zoteroTabs';
import { setAttr } from './decorate';
import type { WindowController } from './controller';

const AUTOSCROLL_ZONE = 28;
const AUTOSCROLL_MAX_SPEED = 14;
const SETTLE_MS = 220;

interface PendingDrag {
	x: number;
	y: number;
	pointerId: number;
	header: HTMLElement | null;
	tabEl: HTMLElement | null;
}

interface StripItem extends DropItem {
	el: HTMLElement;
	start: number;
}

export interface DragState {
	strip: HTMLElement;
	rtl: boolean;
	unitKind: 'tab' | 'group';
	groupId: string | null;
	tabId: string | null;
	unitEls: HTMLElement[];
	clientX: number;
	gap: number;
	items: StripItem[];
	base: number;
	unitStart: number;
	unitSize: number;
	grabOffset: number;
	currentGroupId: string | null;
	result: DropResult | null;
	pointerId?: number;
	frame: number;
	bridgeEl?: HTMLElement | null;
}

export class DragController {
	private pending: PendingDrag | null = null;
	private drag: DragState | null = null;
	private commitWaiter: (() => void) | null = null;

	constructor(private ctrl: WindowController) {}

	/** The drag in progress (null when idle or pending) */
	get state(): DragState | null {
		return this.drag;
	}

	get active(): boolean {
		return !!this.drag;
	}

	/** After a committed drop, the callback to run on React's next commit */
	takeCommitWaiter(): (() => void) | null {
		let cb = this.commitWaiter;
		this.commitWaiter = null;
		return cb;
	}

	// ------------------------------------------------------------------
	// Pointer events
	// ------------------------------------------------------------------

	onPointerDown = (e: PointerEvent): void => {
		if (e.button !== 0 || this.drag || this.pending) return;
		// Ctrl+click is a right click on macOS (trackpad secondary click)
		if (e.ctrlKey) return;
		let strip = this.ctrl.decorator.getStrip();
		let target = e.target as Element | null;
		if (!strip || !target || !strip.contains(target)) return;
		let header = this.ctrl.headerFromEvent(e);
		let tabEl = header ? null : target.closest<HTMLElement>('.tab');
		if (tabEl) {
			if (tabEl.parentNode !== strip) return;
			if (tabEl.getAttribute('data-id') === LIBRARY_TAB_ID) return;
			if (target.closest('.tab-close, .tab-audio-status')) return;
		}
		if (!header && !tabEl) return;
		this.pending = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, header, tabEl };
		let win = this.ctrl.win;
		win.addEventListener('pointermove', this.onPointerMove, true);
		win.addEventListener('pointerup', this.onPointerUp, true);
		win.addEventListener('pointercancel', this.onPointerUp, true);
	};

	private removePointerListeners(): void {
		let win = this.ctrl.win;
		win.removeEventListener('pointermove', this.onPointerMove, true);
		win.removeEventListener('pointerup', this.onPointerUp, true);
		win.removeEventListener('pointercancel', this.onPointerUp, true);
	}

	private onPointerMove = (e: PointerEvent): void => {
		if (this.pending && !this.drag) {
			if (e.pointerId !== this.pending.pointerId) return;
			let dx = e.clientX - this.pending.x;
			let dy = e.clientY - this.pending.y;
			if (!Model.exceedsDragThreshold(dx, dy)) return;
			if (!this.begin()) {
				this.pending = null;
				this.removePointerListeners();
				return;
			}
		}
		if (this.drag) {
			this.drag.clientX = e.clientX;
			this.update();
		}
	};

	private onPointerUp = (e: PointerEvent): void => {
		let wasDragging = !!this.drag;
		this.pending = null;
		this.removePointerListeners();
		if (wasDragging) {
			this.ctrl.suppressClick = true;
			this.ctrl.setTimeout(() => {
				this.ctrl.suppressClick = false;
			}, 0);
			this.finish(e.type === 'pointerup');
		}
	};

	private onWheel = (e: WheelEvent): void => {
		// A resting second finger or trackpad momentum scrolls the strip
		// under the held tab, and drop positions (computed at drag start)
		// would drift from what's on screen. Autoscroll is the only scroll.
		// Zotero's own wheel handler scrolls from JS, so stop it too.
		if (!this.drag) return;
		e.preventDefault();
		e.stopPropagation();
	};

	private onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === 'Escape' && this.drag) {
			e.preventDefault();
			e.stopPropagation();
			this.pending = null;
			this.removePointerListeners();
			this.finish(false);
		}
	};

	/** Abort any press or drag (window teardown) */
	cancel(animate: boolean): void {
		if (this.drag) this.finish(false, animate);
		this.pending = null;
		this.removePointerListeners();
	}

	// ------------------------------------------------------------------
	// Geometry
	// ------------------------------------------------------------------

	/** Distance from the strip's content start edge (scroll-independent) */
	private flowX(strip: HTMLElement, rtl: boolean, clientX: number): number {
		let r = strip.getBoundingClientRect();
		return rtl
			? (r.right - clientX) - strip.scrollLeft
			: (clientX - r.left) + strip.scrollLeft;
	}

	private measure(strip: HTMLElement, rtl: boolean, el: HTMLElement): { start: number; size: number } {
		let r = el.getBoundingClientRect();
		return { start: this.flowX(strip, rtl, rtl ? r.right : r.left), size: r.width };
	}

	private translate(el: HTMLElement, dx: number, rtl: boolean): void {
		let v = Math.abs(dx) < 0.01 ? '' : `translateX(${rtl ? -dx : dx}px)`;
		if (el.style.transform !== v) el.style.transform = v;
	}

	// ------------------------------------------------------------------
	// Phases
	// ------------------------------------------------------------------

	private begin(): boolean {
		let ctrl = this.ctrl;
		let { header, tabEl, pointerId, x } = this.pending!;
		let strip = ctrl.decorator.getStrip();
		if (!strip) return false;
		ctrl.closeEditor();
		// Native dragging is disabled, so pressing on a tab name would
		// otherwise leave a sliver of text selected behind the drag
		try {
			let selection = ctrl.win.getSelection();
			if (selection) selection.removeAllRanges();
		}
		catch (e) {
			// not worth failing a drag over
		}

		let unitKind: 'tab' | 'group' = header ? 'group' : 'tab';
		let groupId = header ? header.getAttribute('data-ztg-group-id') : null;
		let tabId = tabEl ? tabEl.getAttribute('data-id') : null;
		if (tabId && !ctrl.getTab(tabId)) return false;

		let visible = (el: HTMLElement) => el.getClientRects().length > 0 && !el.hasAttribute('ztg-hidden');
		let all = (Array.from(strip.children) as HTMLElement[]).filter(el => (
			(el.classList.contains('ztg-header')
				|| (el.classList.contains('tab') && el.getAttribute('data-id') !== LIBRARY_TAB_ID))
			&& visible(el)
		));
		let unitEls = header
			? all.filter(el => el === header || el.getAttribute('ztg-group') === groupId)
			: [tabEl!];

		let rtl = ctrl.isRTL(strip);
		let gap = parseFloat(ctrl.win.getComputedStyle(strip).columnGap);

		let items: StripItem[] = [];
		let unitStart = Infinity;
		let unitEnd = -Infinity;
		let base = Infinity;
		for (let el of all) {
			let m = this.measure(strip, rtl, el);
			base = Math.min(base, m.start);
			if (unitEls.includes(el)) {
				unitStart = Math.min(unitStart, m.start);
				unitEnd = Math.max(unitEnd, m.start + m.size);
				continue;
			}
			if (el.classList.contains('ztg-header')) {
				let gid = el.getAttribute('data-ztg-group-id')!;
				let first = ctrl.members(gid)[0];
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
		if (!Number.isFinite(unitStart)) return false;

		this.drag = {
			strip,
			rtl,
			unitKind,
			groupId,
			tabId,
			unitEls,
			clientX: x,
			gap: Number.isFinite(gap) ? gap : 0,
			items,
			base,
			unitStart,
			unitSize: unitEnd - unitStart,
			grabOffset: this.flowX(strip, rtl, x) - unitStart,
			currentGroupId: tabId ? ctrl.groupOf(tabId) : null,
			result: null,
			frame: 0,
		};
		let d = this.drag;

		strip.setAttribute('ztg-dragging', '');
		for (let el of unitEls) el.setAttribute('ztg-drag-unit', '');
		try {
			strip.setPointerCapture(pointerId);
			d.pointerId = pointerId;
		}
		catch (e) {
			// pointer capture is a nicety, not a requirement
		}
		ctrl.win.addEventListener('keydown', this.onKeyDown, true);
		strip.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
		d.frame = ctrl.win.requestAnimationFrame(this.onFrame);
		this.update();
		return true;
	}

	private update(): void {
		let d = this.drag;
		if (!d) return;
		let maxStart = d.base;
		for (let item of d.items) maxStart += item.size + d.gap;
		let desired = this.flowX(d.strip, d.rtl, d.clientX) - d.grabOffset;
		desired = Math.max(d.base, Math.min(maxStart, desired));

		let res = Model.computeDrop({
			items: d.items,
			base: d.base,
			gap: d.gap,
			unitKind: d.unitKind,
			unitSize: d.unitSize,
			desiredStart: desired,
			currentGroupId: d.currentGroupId,
		});
		d.result = res;
		let rtl = d.rtl;
		d.items.forEach((item, i) => this.translate(item.el, res.starts[i] - item.start, rtl));
		for (let el of d.unitEls) this.translate(el, desired - d.unitStart, rtl);

		if (d.unitKind === 'tab') {
			d.currentGroupId = res.groupId;
			this.setBridge(d, res);
			let el = d.unitEls[0];
			let g = res.groupId ? this.ctrl.store.get(res.groupId) : null;
			setAttr(el, 'ztg-group', g ? g.id : null);
			setAttr(el, 'ztg-color', g ? g.color : null);
			// Recompute underline end caps in the order the strip will have
			let seq = d.items.filter(it => it.kind === 'tab').map(it => ({ el: it.el, gid: it.groupId }));
			let insertAt = d.items.slice(0, res.index).filter(it => it.kind === 'tab').length;
			seq.splice(insertAt, 0, { el, gid: res.groupId });
			seq.forEach((s, i) => {
				setAttr(s.el, 'ztg-first', !!s.gid && (i === 0 || seq[i - 1].gid !== s.gid));
				setAttr(s.el, 'ztg-last', !!s.gid && (i === seq.length - 1 || seq[i + 1].gid !== s.gid));
			});
		}
	}

	/**
	 * While a tab hovers over a group, the neighbors open a gap for it, but
	 * the tab itself is usually held away from that gap, which would leave
	 * a hole in the group's color bar. The member (or chip) right before
	 * the slot stretches its bar across the gap instead.
	 */
	private setBridge(d: DragState, res: DropResult): void {
		let prev = res.groupId ? d.items[res.index - 1] : null;
		let el = prev && prev.groupId === res.groupId ? prev.el : null;
		if (d.bridgeEl && d.bridgeEl !== el) d.bridgeEl.style.removeProperty('--ztg-bridge');
		d.bridgeEl = el;
		if (el) el.style.setProperty('--ztg-bridge', `${d.unitSize + d.gap}px`);
	}

	private onFrame = (): void => {
		let d = this.drag;
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
				if (strip.scrollLeft !== before) this.update();
			}
		}
		d.frame = this.ctrl.win.requestAnimationFrame(this.onFrame);
	};

	/**
	 * End the drag. If `commit`, apply the new order/membership through
	 * Zotero_Tabs; then animate the dragged unit into its resting place.
	 */
	private finish(commit: boolean, animate = true): void {
		let d = this.drag;
		if (!d) return;
		let ctrl = this.ctrl;
		ctrl.win.cancelAnimationFrame(d.frame);
		ctrl.win.removeEventListener('keydown', this.onKeyDown, true);
		d.strip.removeEventListener('wheel', this.onWheel, true);
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
				orderChanged = this.commitDrop(d);
			}
			catch (e) {
				ctrl.logError(e);
			}
		}

		let settle = () => {
			this.drag = null;
			// If the order changed, the strip already shows the final layout
			// and transforms must go away instantly. Otherwise (cancel, or a
			// membership-only change) let the other tabs glide back.
			let glideBack = animate && !orderChanged;
			if (!glideBack) d!.strip.removeAttribute('ztg-dragging');
			for (let item of d!.items) item.el.style.removeProperty('transform');
			for (let el of d!.unitEls) el.style.removeProperty('transform');
			if (d!.bridgeEl) d!.bridgeEl.style.removeProperty('--ztg-bridge');
			ctrl.decorator.decorate();
			if (glideBack) {
				ctrl.setTimeout(() => {
					if (!this.drag) d!.strip.removeAttribute('ztg-dragging');
				}, SETTLE_MS);
			}
			if (!animate) {
				for (let el of d!.unitEls) el.removeAttribute('ztg-drag-unit');
				return;
			}
			// Animate the unit from where it was dropped to where it now is
			let moved: HTMLElement[] = [];
			for (let el of d!.unitEls) {
				if (!el.isConnected) continue;
				let first = firstRects.get(el)!;
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
			ctrl.setTimeout(() => {
				for (let el of moved) {
					el.removeAttribute('ztg-settling');
					el.removeAttribute('ztg-drag-unit');
				}
			}, SETTLE_MS);
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
			this.commitWaiter = run;
			ctrl.setTimeout(() => {
				if (this.commitWaiter === run) this.commitWaiter = null;
				run();
			}, 250);
		}
		else {
			settle();
		}
	}

	/** @returns whether the tab order changed */
	private commitDrop(d: DragState): boolean {
		let ctrl = this.ctrl;
		let res = d.result!;
		let anchor = Model.insertionAnchor(d.items, res.index);
		let ids = d.unitKind === 'group'
			? ctrl.members(d.groupId!).map(t => t.id)
			: [d.tabId!];
		if (!ids.length) return false;

		let orderBefore = ctrl.zt.all().map(t => t.id).join('\n');
		let membershipChanged = false;
		ctrl.batch(() => {
			if (d.unitKind === 'tab') {
				membershipChanged = ctrl.zt.setRawGroup(ctrl.getTab(d.tabId), res.groupId);
			}
			ctrl.zt.moveBefore(ids, anchor);
		});
		let orderChanged = ctrl.zt.all().map(t => t.id).join('\n') !== orderBefore;
		if (orderChanged || membershipChanged) ctrl.saveSession();
		if (membershipChanged) ctrl.purgeEmptyGroups();
		return orderChanged;
	}
}
