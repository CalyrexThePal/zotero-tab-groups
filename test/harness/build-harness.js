#!/usr/bin/env node
/*
 * Builds test/harness/dist/: Zotero's TabBar component + stand-in Zotero_Tabs
 * (bundled with esbuild), Zotero's tab bar styles (compiled with sass), and
 * the plugin's own content scripts and stylesheet, loaded unmodified.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const sass = require('sass');

const here = __dirname;
const root = path.resolve(here, '../..');
const dist = path.join(here, 'dist');
fs.mkdirSync(dist, { recursive: true });

// Fluent messages -> simple map (value messages and .label attributes)
function parseFTL(text) {
	let messages = {};
	let lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		let m = lines[i].match(/^([a-z0-9-]+)\s*=\s*(.*)$/);
		if (!m) continue;
		let value = m[2];
		let j = i + 1;
		while (j < lines.length && /^\s+\S/.test(lines[j])) {
			let attr = lines[j].match(/^\s+\.label\s*=\s*(.*)$/);
			if (attr && !value) value = attr[1];
			else if (!attr) value += '\n' + lines[j];
			j++;
		}
		messages[m[1]] = value;
	}
	return messages;
}

const ftl = parseFTL(fs.readFileSync(path.join(root, 'src/locale/en-US/zotero-tab-groups.ftl'), 'utf8'));
fs.writeFileSync(path.join(dist, 'ftl.js'), 'var FTL_MESSAGES = ' + JSON.stringify(ftl, null, 1) + ';\n');

(async () => {
await esbuild.build({
	entryPoints: [path.join(here, 'entry.jsx')],
	bundle: true,
	outfile: path.join(dist, 'harness.js'),
	format: 'iife',
	jsx: 'transform',
	loader: { '.js': 'jsx', '.jsx': 'jsx' },
	define: { 'process.env.NODE_ENV': '"development"' },
	plugins: [{
		name: 'zotero-icons-stub',
		setup(build) {
			build.onResolve({ filter: /^\.\/icons$/ }, () => ({ path: path.join(here, 'icons-stub.jsx') }));
		},
	}],
	logLevel: 'warning',
});

let scss = '@mixin inactive-opacity {}\n' + fs.readFileSync(path.join(here, 'vendor/_tabBar.scss'), 'utf8');
fs.writeFileSync(path.join(dist, 'tabbar.css'), sass.compileString(scss).css);

for (let f of ['model.js', 'store.js', 'controller.js', 'tabGroups.css']) {
	fs.copyFileSync(path.join(root, 'src/content', f), path.join(dist, f));
}
fs.copyFileSync(path.join(here, 'index.html'), path.join(dist, 'index.html'));
console.log('Harness built in', path.relative(root, dist));
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
