#!/usr/bin/env node
/*
 * Builds build/zotero-tab-groups-<version>.xpi (a zip archive with
 * manifest.json at its root):
 *
 *   1. copies the static files of src/ (everything except TypeScript) into
 *      build/stage/,
 *   2. bundles src/content/index.ts into build/stage/content/plugin.js
 *      (esbuild, IIFE, global ZTG_Bundle; bootstrap.js loads it),
 *   3. zips build/stage/ with the system `zip`, or a built-in zip writer if
 *      that isn't installed (e.g. Windows).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');
const out = path.join(root, 'build');
const stage = path.join(out, 'stage');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const xpi = path.join(out, `zotero-tab-groups-${manifest.version}.xpi`);

// TypeScript sources and type declarations are compiled into the bundle, not shipped
const isSource = rel => rel.endsWith('.ts') || rel.startsWith('types/');

function copyStatic(dir, base = dir) {
	for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
		let full = path.join(dir, entry.name);
		let rel = path.relative(base, full).split(path.sep).join('/');
		if (entry.isDirectory()) {
			if (!isSource(rel + '/')) copyStatic(full, base);
		}
		else if (!isSource(rel)) {
			fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
			fs.copyFileSync(full, path.join(stage, rel));
		}
	}
}

function listFiles(dir, base = dir) {
	let files = [];
	for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
		let full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(full, base));
		else files.push(path.relative(base, full).split(path.sep).join('/'));
	}
	return files.sort();
}

// Minimal zip writer (deflate), used when `zip` isn't installed (e.g. Windows)
function crc32(buf) {
	let c, crc = 0xffffffff;
	for (let n = 0; n < buf.length; n++) {
		c = (crc ^ buf[n]) & 0xff;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crc = (crc >>> 8) ^ c;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function writeZip(file, entries) {
	let parts = [];
	let central = [];
	let offset = 0;
	for (let name of entries) {
		let data = fs.readFileSync(path.join(stage, name));
		let deflated = zlib.deflateRawSync(data, { level: 9 });
		let nameBuf = Buffer.from(name, 'utf8');
		let crc = crc32(data);
		let local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // UTF-8 names
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt32LE(0, 10); // time/date
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(deflated.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		parts.push(local, nameBuf, deflated);

		let cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(0x0800, 8);
		cen.writeUInt16LE(8, 10);
		cen.writeUInt32LE(0, 12);
		cen.writeUInt32LE(crc, 16);
		cen.writeUInt32LE(deflated.length, 20);
		cen.writeUInt32LE(data.length, 24);
		cen.writeUInt16LE(nameBuf.length, 28);
		cen.writeUInt32LE(offset, 42);
		central.push(cen, nameBuf);
		offset += local.length + nameBuf.length + deflated.length;
	}
	let cenBuf = Buffer.concat(central);
	let end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(cenBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	fs.writeFileSync(file, Buffer.concat([...parts, cenBuf, end]));
}

async function main() {
	fs.rmSync(stage, { recursive: true, force: true });
	fs.mkdirSync(stage, { recursive: true });
	if (fs.existsSync(xpi)) fs.unlinkSync(xpi);
	copyStatic(src);
	await esbuild.build({
		entryPoints: [path.join(src, 'content/index.ts')],
		bundle: true,
		format: 'iife',
		globalName: 'ZTG_Bundle',
		target: 'firefox115',
		outfile: path.join(stage, 'content/plugin.js'),
		logLevel: 'warning',
	});
	const files = listFiles(stage);
	let usedZip = false;
	try {
		execFileSync('zip', ['-q', '-9', '-X', xpi, ...files], { cwd: stage, stdio: 'ignore' });
		usedZip = true;
	}
	catch (e) {
		writeZip(xpi, files);
	}
	console.log(`Built ${path.relative(root, xpi)} (${files.length} files${usedZip ? '' : ', built-in zip'})`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
