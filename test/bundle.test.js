'use strict';
// Smoke test: the production bundle (what bootstrap.js loads in Zotero) must
// run as a classic script and expose ZTG_Bundle.plugin.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

test('the bundle is a self-contained classic script exposing the plugin', async () => {
	let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztg-bundle-'));
	let outfile = path.join(dir, 'plugin.js');
	await esbuild.build({
		entryPoints: [path.join(__dirname, '../src/content/index.ts')],
		bundle: true, format: 'iife', globalName: 'ZTG_Bundle', target: 'firefox115', outfile, logLevel: 'silent',
	});
	let code = fs.readFileSync(outfile, 'utf8');
	assert.doesNotMatch(code, /^\s*(import|export)\s/m);
	let prefs = {};
	let sandbox = {
		setTimeout, clearTimeout,
		Zotero: {
			debug() {}, logError() {}, getMainWindows: () => [],
			Prefs: { get: k => prefs[k], set: (k, v) => { prefs[k] = v; }, clear() {} },
			Session: { debounceSave() {} },
		},
	};
	vm.createContext(sandbox);
	vm.runInContext(code + '\nthis.__plugin = ZTG_Bundle.plugin;', sandbox);
	let plugin = sandbox.__plugin;
	for (let fn of ['init', 'shutdown', 'flush', 'addToWindow', 'removeFromWindow', 'addToAllWindows']) {
		assert.equal(typeof plugin[fn], 'function', fn);
	}
	plugin.init({ id: 'x@y', version: '0', rootURI: 'rootURI/' });
	plugin.store.create({ title: 'G' });
	plugin.shutdown();
	assert.match(prefs['extensions.zotero-tab-groups.groups'], /"title":"G"/);
	fs.rmSync(dir, { recursive: true, force: true });
});
