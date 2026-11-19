/*
 * Bundle entry point. build.js compiles this into content/plugin.js with
 * esbuild (IIFE, global `ZTG_Bundle`); bootstrap.js loads it with
 * Services.scriptloader.loadSubScript and reads `ZTG_Bundle.plugin`.
 */

import { TabGroupsPlugin, PREF_GROUPS } from './plugin';

export const plugin = new TabGroupsPlugin();
export { PREF_GROUPS };
