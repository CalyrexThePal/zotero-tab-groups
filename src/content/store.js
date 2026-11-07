/*
 * Tab Groups for Zotero — group metadata store.
 *
 * Holds { id, title, color, collapsed } for every group and persists it as
 * JSON through the injected read/write functions (Zotero.Prefs in the
 * plugin, an in-memory string in tests). Which tab is in which group is NOT
 * stored here: it lives in each tab's session data so it is saved and
 * restored by Zotero together with the tabs themselves.
 */

/* exported ZTG_Store */
var ZTG_Store = class {
	/**
	 * @param {object} opts
	 * @param {() => string} opts.read
	 * @param {(json: string) => void} opts.write
	 * @param {(fn: Function, ms: number) => any} [opts.setTimeout]
	 */
	constructor({ read, write, setTimeout: st }) {
		this._read = read;
		this._write = write;
		this._setTimeout = st || ((fn, ms) => setTimeout(fn, ms));
		this._groups = new Map();
		// Recently removed groups, kept for this session so "Undo Close Tab"
		// can bring a closed group back with its name and color.
		this._graveyard = new Map();
		this._listeners = new Set();
		this._saveTimer = null;
		this.load();
	}

	load() {
		this._groups.clear();
		let data = {};
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
				color: ZTG_Model.COLORS.includes(g.color) ? g.color : 'grey',
				collapsed: !!g.collapsed,
			});
		}
	}

	_serialize() {
		let groups = {};
		for (let [id, g] of this._groups) {
			groups[id] = { title: g.title, color: g.color, collapsed: g.collapsed };
		}
		return JSON.stringify({ version: 1, groups });
	}

	_scheduleSave() {
		if (this._saveTimer) return;
		this._saveTimer = this._setTimeout(() => {
			this._saveTimer = null;
			this.flush();
		}, 250);
	}

	flush() {
		if (this._saveTimer) {
			clearTimeout(this._saveTimer);
			this._saveTimer = null;
		}
		try {
			this._write(this._serialize());
		}
		catch (e) {
			// Never let persistence errors break the UI
		}
	}

	_emit(change) {
		for (let fn of this._listeners) {
			try {
				fn(change);
			}
			catch (e) {
				// ignore listener errors
			}
		}
	}

	subscribe(fn) {
		this._listeners.add(fn);
		return () => this._listeners.delete(fn);
	}

	has(id) {
		return !!id && this._groups.has(id);
	}

	get(id) {
		return (id && this._groups.get(id)) || null;
	}

	all() {
		return [...this._groups.values()];
	}

	create({ title = '', color } = {}) {
		let id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
		let group = {
			id,
			title,
			color: ZTG_Model.COLORS.includes(color) ? color : ZTG_Model.pickColor(this.all().map(g => g.color)),
			collapsed: false,
		};
		this._groups.set(id, group);
		this._scheduleSave();
		this._emit({ type: 'create', id });
		return group;
	}

	update(id, patch) {
		let g = this._groups.get(id);
		if (!g) return null;
		let changed = false;
		for (let key of ['title', 'color', 'collapsed']) {
			if (key in patch && g[key] !== patch[key]) {
				if (key === 'color' && !ZTG_Model.COLORS.includes(patch.color)) continue;
				g[key] = key === 'collapsed' ? !!patch[key] : patch[key];
				changed = true;
			}
		}
		if (changed) {
			this._scheduleSave();
			this._emit({ type: 'update', id });
		}
		return g;
	}

	remove(id) {
		let g = this._groups.get(id);
		if (!g) return;
		this._groups.delete(id);
		this._graveyard.set(id, Object.assign({}, g, { collapsed: false }));
		this._scheduleSave();
		this._emit({ type: 'remove', id });
	}

	/**
	 * Bring a recently removed group back (e.g. when its tabs are reopened)
	 * @returns {boolean}
	 */
	resurrect(id) {
		if (this._groups.has(id)) return true;
		let g = this._graveyard.get(id);
		if (!g) return false;
		this._graveyard.delete(id);
		this._groups.set(id, g);
		this._scheduleSave();
		this._emit({ type: 'create', id });
		return true;
	}
};
