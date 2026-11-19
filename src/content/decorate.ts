/*
 * Tab Groups for Zotero — strip decoration.
 *
 * After every React commit of Zotero's tab bar, this adds a "chip" element
 * before each group's first tab, sets the `ztg-*` attributes on Zotero's own
 * tab elements, and hides the tabs of collapsed groups. It never edits
 * Zotero's React output in any other way, and `removeDecorations()` leaves no
 * trace.
 */

import { LIBRARY_TAB_ID } from './zoteroTabs';
import type { Group } from './store';
import type { WindowController } from './controller';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
export const COLLAPSE_ANIMATION_MS = 220;

/** Attributes this module puts on Zotero's tab elements */
const TAB_ATTRIBUTES = [
	'ztg-group', 'ztg-color', 'ztg-hidden', 'ztg-first', 'ztg-last',
	'ztg-drag-unit', 'ztg-settling', 'ztg-instant',
];

export function setAttr(el: Element, name: string, value: string | boolean | null | undefined): void {
	if (value === null || value === undefined || value === false) {
		if (el.hasAttribute(name)) el.removeAttribute(name);
	}
	else {
		let v = value === true ? '' : String(value);
		if (el.getAttribute(name) !== v) el.setAttribute(name, v);
	}
}

export class Decorator {
	/** group id -> chip element */
	readonly headers = new Map<string, HTMLElement>();
	private seenEls = new WeakSet<Element>();
	private sizeKeys = new WeakMap<HTMLElement, string>();
	private applying = false;
	private observer: MutationObserver | null = null;
	private queued = false;
	private refreshTimer: number | null = null;

	constructor(private ctrl: WindowController) {}

	/** Start watching Zotero's tab bar for React commits */
	connect(): void {
		this.observer = new this.ctrl.win.MutationObserver(() => this.onMutations());
		this.observer.observe(this.ctrl.container, { childList: true, subtree: true });
	}

	disconnect(): void {
		if (this.observer) this.observer.disconnect();
		this.observer = null;
	}

	getStrip(): HTMLElement | null {
		return this.ctrl.container.querySelector<HTMLElement>('.tabs-wrapper > .tabs');
	}

	/** Visible, keyboard-reachable strip items (tabs and group chips) */
	focusableItems(): HTMLElement[] {
		let strip = this.getStrip();
		if (!strip) return [];
		return (Array.from(strip.children) as HTMLElement[]).filter(el => (
			el.classList.contains('ztg-header')
			|| (el.classList.contains('tab') && !el.hasAttribute('ztg-hidden'))
		));
	}

	private onMutations(): void {
		if (this.applying) return;
		let waiter = this.ctrl.drag.takeCommitWaiter();
		if (waiter) {
			waiter();
			return;
		}
		if (this.ctrl.drag.active) return;
		this.decorate();
	}

	/**
	 * React may not touch the DOM (e.g. only membership changed), so
	 * decorate after the model change as well as after the next commit.
	 */
	queueDecorate(): void {
		if (this.queued) return;
		this.queued = true;
		Promise.resolve().then(() => {
			this.queued = false;
			this.decorate();
		});
	}

	decorate(): void {
		let ctrl = this.ctrl;
		if (ctrl.drag.active) return;
		let strip = this.getStrip();
		if (!strip) return;
		this.applying = true;
		try {
			let groupOfTab = new Map<string, string | null>();
			for (let tab of ctrl.tabList()) groupOfTab.set(tab.id, ctrl.rawGroupOf(tab));

			let tabEls = (Array.from(strip.children) as HTMLElement[]).filter(el => el.classList.contains('tab'));
			let instant: HTMLElement[] = [];
			let firstEl = new Map<string, HTMLElement>();
			let lastEl = new Map<string, HTMLElement>();
			let counts = new Map<string, number>();
			for (let el of tabEls) {
				let id = el.getAttribute('data-id');
				let gid: string | null = id === LIBRARY_TAB_ID || !id ? null : groupOfTab.get(id) || null;
				let g = gid ? ctrl.store.get(gid) : null;
				if (!g) gid = null;
				// Our pointer-based dragging replaces Zotero's native HTML5 drag
				// (React only writes this attribute when the tab is created)
				if (id !== LIBRARY_TAB_ID) setAttr(el, 'draggable', 'false');
				setAttr(el, 'ztg-group', gid);
				setAttr(el, 'ztg-color', g && g.color);
				let hide = !!(g && g.collapsed);
				if (!this.seenEls.has(el)) {
					this.seenEls.add(el);
					// A tab that is rendered already-collapsed (session restore,
					// plugin start) must not play the collapse animation
					if (hide && !el.hasAttribute('ztg-hidden')) {
						el.setAttribute('ztg-instant', '');
						el.setAttribute('ztg-hidden', '');
						instant.push(el);
					}
				}
				setAttr(el, 'ztg-hidden', hide);
				if (gid) {
					if (!firstEl.has(gid)) firstEl.set(gid, el);
					lastEl.set(gid, el);
					counts.set(gid, (counts.get(gid) || 0) + 1);
				}
			}
			for (let el of tabEls) {
				let gid = el.getAttribute('ztg-group');
				setAttr(el, 'ztg-first', !!gid && firstEl.get(gid) === el);
				setAttr(el, 'ztg-last', !!gid && lastEl.get(gid) === el);
			}

			let layoutChanged = false;
			for (let [gid, el] of firstEl) {
				let isNew = !this.headers.has(gid);
				let header = this.ensureHeader(gid);
				if (isNew) {
					header.setAttribute('ztg-instant', '');
					instant.push(header);
				}
				if (this.updateHeader(header, ctrl.store.get(gid)!, counts.get(gid) || 0)) layoutChanged = true;
				if (header.parentNode !== strip || header.nextSibling !== el) {
					strip.insertBefore(header, el);
					if (isNew) layoutChanged = true;
				}
			}
			for (let [gid, header] of this.headers) {
				if (!firstEl.has(gid)) {
					header.remove();
					this.headers.delete(gid);
					layoutChanged = true;
				}
			}
			if (instant.length) {
				// Flush styles so the final state applies without transitions
				strip.getBoundingClientRect();
				for (let el of instant) el.removeAttribute('ztg-instant');
			}
			// Zotero only re-measures its scroll arrows when it renders
			if (layoutChanged) this.refreshTabBarSoon(120);
		}
		catch (e) {
			ctrl.logError(e);
		}
		finally {
			if (this.observer) this.observer.takeRecords();
			this.applying = false;
		}
	}

	private ensureHeader(gid: string): HTMLElement {
		let header = this.headers.get(gid);
		if (header) return header;
		let doc = this.ctrl.doc;
		header = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
		header.className = 'ztg-header';
		header.setAttribute('data-ztg-group-id', gid);
		header.setAttribute('role', 'button');
		header.setAttribute('tabindex', '-1');
		let chip = doc.createElementNS(HTML_NS, 'div') as HTMLElement;
		chip.className = 'ztg-chip';
		let title = doc.createElementNS(HTML_NS, 'span') as HTMLElement;
		title.className = 'ztg-title';
		let count = doc.createElementNS(HTML_NS, 'span') as HTMLElement;
		count.className = 'ztg-count';
		chip.append(title, count);
		header.append(chip);
		this.headers.set(gid, header);
		return header;
	}

	/** @returns whether the chip's size may have changed */
	private updateHeader(header: HTMLElement, group: Group, count: number): boolean {
		let t = this.ctrl.t;
		let title = group.title || '';
		let sizeKey = `${title}\n${group.collapsed}\n${group.collapsed ? count : ''}`;
		let previous = this.sizeKeys.get(header);
		let sizeChanged = previous !== undefined && previous !== sizeKey;
		this.sizeKeys.set(header, sizeKey);
		setAttr(header, 'ztg-color', group.color);
		setAttr(header, 'ztg-collapsed', group.collapsed);
		setAttr(header, 'ztg-untitled', !title);
		setAttr(header, 'aria-expanded', group.collapsed ? 'false' : 'true');
		let titleEl = header.querySelector('.ztg-title')!;
		if (titleEl.textContent !== title) titleEl.textContent = title;
		let countEl = header.querySelector('.ztg-count')!;
		if (countEl.textContent !== String(count)) countEl.textContent = String(count);
		let label = t('ztg-header-tooltip', {
			title: title || t('ztg-unnamed-group'),
			count,
		});
		setAttr(header, 'title', label);
		setAttr(header, 'aria-label', label);
		return sizeChanged;
	}

	/** Zotero recalculates its scroll arrows on render; nudge it after animations */
	refreshTabBarSoon(delay = COLLAPSE_ANIMATION_MS + 30): void {
		let ctrl = this.ctrl;
		if (this.refreshTimer) ctrl.win.clearTimeout(this.refreshTimer);
		this.refreshTimer = ctrl.setTimeout(() => {
			this.refreshTimer = null;
			if (ctrl.drag.active) return;
			try {
				ctrl.zt.update();
			}
			catch (e) {
				ctrl.logError(e);
			}
		}, delay);
	}

	/** Remove every chip and attribute this module added */
	removeDecorations(): void {
		for (let header of this.headers.values()) header.remove();
		this.headers.clear();
		for (let el of this.ctrl.container.querySelectorAll<HTMLElement>('.tab')) {
			for (let attr of TAB_ATTRIBUTES) el.removeAttribute(attr);
			if (el.getAttribute('draggable') === 'false') el.setAttribute('draggable', 'true');
			el.style.removeProperty('transform');
		}
	}
}
