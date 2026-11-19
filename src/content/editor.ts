/*
 * Tab Groups for Zotero — group editor bubble (name, color, ungroup, close).
 */

import { COLORS } from './model';
import type { WindowController } from './controller';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

export interface EditorOptions {
	isNew?: boolean;
	fromKeyboard?: boolean;
	retries?: number;
}

interface OpenEditor {
	el: HTMLElement;
	groupId: string;
	input: HTMLInputElement;
	fromKeyboard: boolean;
	openedAt: number;
	unsubscribe: () => void;
}

export class EditorBubble {
	private current: OpenEditor | null = null;

	constructor(private ctrl: WindowController) {}

	get isOpen(): boolean {
		return !!this.current;
	}

	open(groupId: string, { isNew = false, fromKeyboard = false, retries = 10 }: EditorOptions = {}): void {
		let ctrl = this.ctrl;
		let { store, t, doc } = ctrl;
		let group = store.get(groupId);
		if (!group) return;
		let header = ctrl.decorator.headers.get(groupId);
		if (!header || !header.isConnected) {
			// The tab may not be rendered yet (React renders asynchronously)
			if (retries > 0) ctrl.setTimeout(() => this.open(groupId, { isNew, fromKeyboard, retries: retries - 1 }), 30);
			return;
		}
		this.close();
		let h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, attrs: Record<string, string> = {}) => {
			let el = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
			if (cls) el.className = cls;
			for (let [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
			return el;
		};

		let editor = h('div', 'ztg-editor', {
			role: 'dialog',
			'aria-label': t('ztg-editor-label'),
			'data-ztg-group-id': groupId,
		});
		let input = h('input', 'ztg-editor-name', {
			type: 'text',
			maxlength: '80',
			placeholder: t('ztg-editor-name-placeholder'),
			'aria-label': t('ztg-editor-name-placeholder'),
		});
		input.value = group.title;
		input.addEventListener('input', () => {
			store.update(groupId, { title: input.value.trim() ? input.value : '' });
		});

		let colors = h('div', 'ztg-editor-colors', { role: 'radiogroup', 'aria-label': t('ztg-editor-colors') });
		let swatches: HTMLElement[] = [];
		for (let color of COLORS) {
			let sw = h('button', 'ztg-swatch', {
				type: 'button',
				role: 'radio',
				tabindex: '-1',
				'ztg-color': color,
				'aria-label': t('ztg-color-' + color),
				title: t('ztg-color-' + color),
			});
			// Keep focus in the name field (so it doesn't look like the bubble lost focus)
			sw.addEventListener('mousedown', e => e.preventDefault());
			sw.addEventListener('click', () => {
				store.update(groupId, { color });
				sync();
			});
			swatches.push(sw);
			colors.append(sw);
		}

		let actions = h('div', 'ztg-editor-actions');
		let addAction = (id: string, fn: () => void) => {
			let b = h('button', 'ztg-editor-item', { type: 'button', 'data-action': id });
			b.textContent = t('ztg-editor-' + id);
			b.addEventListener('mousedown', e => e.preventDefault());
			b.addEventListener('click', fn);
			actions.append(b);
		};
		addAction('ungroup', () => ctrl.ungroup(groupId));
		addAction('close-group', () => ctrl.closeGroup(groupId));

		editor.append(input, colors, h('div', 'ztg-editor-separator'), actions);

		let sync = () => {
			let g = store.get(groupId);
			if (!g) return;
			editor.setAttribute('ztg-color', g.color);
			for (let sw of swatches) {
				let on = sw.getAttribute('ztg-color') === g.color;
				sw.setAttribute('aria-checked', on ? 'true' : 'false');
			}
		};
		sync();

		doc.documentElement.appendChild(editor);
		if (typeof editor.showPopover === 'function') {
			// Top layer: stays above the reader iframe and everything else
			editor.setAttribute('popover', 'manual');
			try {
				editor.showPopover();
			}
			catch (e) {
				// fall back to fixed positioning
			}
		}
		this.current = {
			el: editor,
			groupId,
			input,
			fromKeyboard,
			openedAt: Date.now(),
			unsubscribe: store.subscribe(() => {
				if (!store.has(groupId)) this.close();
				else sync();
			}),
		};
		this.position();

		doc.addEventListener('pointerdown', this.onDocPointerDown, true);
		doc.addEventListener('keydown', this.onKeyDown, true);
		ctrl.win.addEventListener('blur', this.onWindowBlur);
		editor.addEventListener('focusout', () => {
			ctrl.setTimeout(() => {
				if (!this.current || this.current.el !== editor) return;
				let active = doc.activeElement;
				// Focus went into a frame (e.g. the PDF reader) or elsewhere
				if (!active || !editor.contains(active)) this.close();
			}, 0);
		});

		input.focus();
		if (!isNew) input.select();
	}

	private position(): void {
		if (!this.current) return;
		let ctrl = this.ctrl;
		let { el, groupId } = this.current;
		let header = ctrl.decorator.headers.get(groupId);
		if (!header) return;
		let r = header.getBoundingClientRect();
		let w = el.offsetWidth || 260;
		let viewport = ctrl.doc.documentElement.clientWidth || ctrl.win.innerWidth;
		let rtl = ctrl.isRTL((header.parentNode as Element) || header);
		let left = rtl ? r.right - w : r.left;
		left = Math.max(8, Math.min(left, viewport - w - 8));
		el.style.left = `${Math.round(left)}px`;
		el.style.top = `${Math.round(r.bottom + 6)}px`;
	}

	close(): void {
		let ed = this.current;
		if (!ed) return;
		let ctrl = this.ctrl;
		this.current = null;
		ed.unsubscribe();
		ctrl.doc.removeEventListener('pointerdown', this.onDocPointerDown, true);
		ctrl.doc.removeEventListener('keydown', this.onKeyDown, true);
		ctrl.win.removeEventListener('blur', this.onWindowBlur);
		try {
			if (ed.el.matches(':popover-open')) ed.el.hidePopover();
		}
		catch (e) {
			// ignore
		}
		ed.el.remove();
		ctrl.store.flush();
	}

	private onDocPointerDown = (e: PointerEvent): void => {
		let ed = this.current;
		if (!ed) return;
		if (ed.el.contains(e.target as Node)) return;
		let header = this.ctrl.headerFromEvent(e);
		if (header && header.getAttribute('data-ztg-group-id') === ed.groupId) {
			// Clicking the chip of the open editor just closes it
			e.stopPropagation();
			this.ctrl.suppressClick = true;
			this.ctrl.setTimeout(() => {
				this.ctrl.suppressClick = false;
			}, 0);
		}
		this.close();
	};

	private onKeyDown = (e: KeyboardEvent): void => {
		let ed = this.current;
		if (!ed) return;
		if (e.key === 'Escape' || (e.key === 'Enter' && e.target === ed.input)) {
			e.preventDefault();
			e.stopPropagation();
			let { groupId, fromKeyboard } = ed;
			this.close();
			// Return focus where it came from: the chip, or the tab content
			let header = this.ctrl.decorator.headers.get(groupId);
			if (fromKeyboard && header) header.focus();
			else this.ctrl.zt.refocus();
		}
	};

	private onWindowBlur = (): void => {
		// Ignore the blur some platforms fire while a context menu closes
		if (this.current && Date.now() - this.current.openedAt < 400) return;
		this.close();
	};
}
