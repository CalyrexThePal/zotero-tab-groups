/*
 * Tab Groups for Zotero — group metadata store.
 *
 * Holds { id, title, color, collapsed } for every group and persists it as
 * JSON through the injected read/write functions (Zotero.Prefs in the
 * plugin, an in-memory string in tests). Which tab is in which group is NOT
 * stored here: it lives in each tab's session data so it is saved and
 * restored by Zotero together with the tabs themselves.
 */

import { COLORS, pickColor, type GroupColor } from './model';

export interface Group {
	id: string;
	title: string;
	color: GroupColor;
	collapsed: boolean;
}

export interface StoreChange {
	type: 'create' | 'update' | 'remove';
	id: string;
}

export interface StoreOptions {
	read: () => string;
	write: (json: string) => void;
	setTimeout?: (fn: () => void, ms: number) => unknown;
}

export class Store {
	private _read: () => string;
	private _write: (json: string) => void;
	private _setTimeout: (fn: () => void, ms: number) => unknown;
	private _groups = new Map<string, Group>();
	private _graveyard = new Map<string, Group>();
	private _listeners = new Set<(change: StoreChange) => void>();
	private _saveTimer: unknown = null;

	constructor({ read, write, setTimeout: st }: StoreOptions) {
		this._read = read;
		this._write = write;
		this._setTimeout = st || ((fn, ms) => setTimeout(fn, ms));
		this.load();
	}

	load(): void {
		this._groups.clear();
		let data: any = {};
		try {
			data = JSON.parse(this._read() || '{}') || {};
		}
		catch (e) {
			data = {};
		}
		let groups = data.groups || {};
		for (let id of Object.keys(groups)) {
			let g = groups[id];
			if (!g || typeof g !== 'object') continue;
			this._groups.set(id, {
				id,
				title: typeof g.title === 'string' ? g.title : '',
				color: (COLORS as readonly string[]).includes(g.color) ? g.color : 'grey',
				collapsed: !!g.collapsed,
			});
		}
	}

	private _serialize() {
		let groups: Record<string, Omit<Group, 'id'>> = {};
		for (let [id, g] of this._groups) {
			groups[id] = { title: g.title, color: g.color, collapsed: g.collapsed };
		}
		return JSON.stringify({ version: 1, groups });
	}

	private _scheduleSave() {
		if (this._saveTimer) return;
		this._saveTimer = this._setTimeout(() => {
			this._saveTimer = null;
			this.flush();
		}, 250);
	}

	flush(): void {
		if (this._saveTimer) {
			clearTimeout(this._saveTimer as any);
			this._saveTimer = null;
		}
		try {
			this._write(this._serialize());
		}
		catch (e) {
			// Never let persistence errors break the UI
		}
	}

	private _emit(change: StoreChange) {
		for (let fn of this._listeners) {
			try {
				fn(change);
			}
			catch (e) {
				// ignore listener errors
			}
		}
	}

	subscribe(fn: (change: StoreChange) => void): () => void {
		this._listeners.add(fn);
		return () => {
			this._listeners.delete(fn);
		};
	}

	has(id: string | null | undefined): boolean {
		return !!id && this._groups.has(id);
	}

	get(id: string | null | undefined): Group | null {
		return (id && this._groups.get(id)) || null;
	}

	all(): Group[] {
		return [...this._groups.values()];
	}

	create({ title = '', color }: { title?: string; color?: string } = {}): Group {
		let id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
		let group: Group = {
			id,
			title,
			color: (COLORS as readonly string[]).includes(color as string) ? color as GroupColor : pickColor(this.all().map(g => g.color)),
			collapsed: false,
		};
		this._groups.set(id, group);
		this._scheduleSave();
		this._emit({ type: 'create', id });
		return group;
	}

	update(id: string, patch: Partial<Omit<Group, 'id'>>): Group | null {
		let g = this._groups.get(id);
		if (!g) return null;
		let changed = false;
		if ('title' in patch && g.title !== patch.title) {
			g.title = patch.title as string;
			changed = true;
		}
		if ('color' in patch && g.color !== patch.color && (COLORS as readonly string[]).includes(patch.color as string)) {
			g.color = patch.color as GroupColor;
			changed = true;
		}
		if ('collapsed' in patch && g.collapsed !== !!patch.collapsed) {
			g.collapsed = !!patch.collapsed;
			changed = true;
		}
		if (changed) {
			this._scheduleSave();
			this._emit({ type: 'update', id });
		}
		return g;
	}

	remove(id: string): void {
		let g = this._groups.get(id);
		if (!g) return;
		this._groups.delete(id);
		this._graveyard.set(id, Object.assign({}, g, { collapsed: false }));
		this._scheduleSave();
		this._emit({ type: 'remove', id });
	}

	/** Bring a recently removed group back (e.g. when its tabs are reopened) */
	resurrect(id: string): boolean {
		if (this._groups.has(id)) return true;
		let g = this._graveyard.get(id);
		if (!g) return false;
		this._graveyard.delete(id);
		this._groups.set(id, g);
		this._scheduleSave();
		this._emit({ type: 'create', id });
		return true;
	}
}
