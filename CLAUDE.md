# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Tab Groups for Zotero**: a Zotero 10 plugin (Firefox-style `bootstrap.js` add-on, manifest v2) that adds Chrome-style tab groups to Zotero's tab bar. Groups have a name, color, and collapsed state, and they persist across restarts. See `README.md` for the user-facing feature list and the design overview.

Zotero 10 is pinned: `strict_min_version` is `10.0` and `strict_max_version` is `10.0.*` in `src/manifest.json`. The vendored tab bar in `test/harness/vendor/` is from Zotero commit `3b17983092c48dba35588ae088d09ea360252a34` (see `ZOTERO_COMMIT`).

## Commands

```sh
npm install
npm run typecheck   # tsc over src/ (no emit)
npm test            # unit tests (node:test via tsx): model, store, and a smoke test of the built bundle. Fast, no browser
npm run test:ui     # builds test/harness/dist/, then runs browser tests (Playwright + Chromium)
npm run build       # bundles src/content/*.ts and packages build/zotero-tab-groups-<version>.xpi
```

- `test:ui` uses `playwright`, a devDependency pinned to a minor version (`~1.63.0`). It needs a matching Chromium: `npx playwright install chromium`. In Claude Code cloud sessions a Chromium is preinstalled, and the pin matches it; if you bump `playwright`, the preinstalled browser may no longer match.
- `npm run build` stages the static files of `src/` plus an esbuild bundle in `build/stage/`, then zips it. It uses the system `zip` if present and otherwise falls back to a built-in zip writer, so it works on Windows without extra tools.
- Passing `npm test` and `npm run test:ui` (plus `npm run typecheck`) is the bar for changes to `src/content/`. Run all three before saying a change works. The browser harness is Chromium, not Gecko, so anything touching Zotero-only APIs (`Zotero.MenuManager`, `Zotero.Prefs`, `Services`) must also be checked inside Zotero.

## Layout

```
src/
  bootstrap.js            lifecycle: startup/shutdown/uninstall, window load/unload hooks (classic script, not bundled)
  manifest.json           add-on manifest (id, version, Zotero compatibility range)
  prefs.js                default prefs (groups JSON pref)
  types/zotero.d.ts       minimal types for the Zotero globals the plugin uses
  content/index.ts        bundle entry; exports `plugin`
  content/plugin.ts       TabGroupsPlugin: shared store, window management
  content/menu.ts         tab context menu (Zotero.MenuManager)
  content/model.ts        PURE logic: membership normalization, color picking, drop math
  content/store.ts        group metadata store (title/color/collapsed), prefs-backed, debounced writes
  content/zoteroTabs.ts   adapter: the ONLY file that touches Zotero_Tabs internals and monkey-patches it
  content/controller.ts   per-window WindowController: wiring, membership rules, group actions, strip events
  content/decorate.ts     Decorator: MutationObserver, ztg-* attributes, group chips
  content/drag.ts         DragController: pointer-driven dragging (pending -> dragging -> settling)
  content/editor.ts       EditorBubble: name/color/ungroup/close popover
  content/tabGroups.css   all group styling, keyed on ztg-* attributes (shipped as is)
  locale/en-US/*.ftl      Fluent strings
test/
  model.test.js           unit tests for model.ts
  store.test.js           unit tests for store.ts
  bundle.test.js          builds the bundle and loads it as a classic script in a vm sandbox
  ui.test.js              Playwright tests against the harness, real mouse input
  harness/                builds Zotero's real TabBar.jsx + a Zotero_Tabs stand-in + the plugin's TS sources into dist/
scripts/build.js          .xpi packager
updates.json              Zotero auto-update manifest
```

## Architecture notes

- **TypeScript, bundled.** `src/content/*.ts` are ES modules. `scripts/build.js` bundles them with esbuild (IIFE, global `ZTG_Bundle`, target `firefox115`) into one `content/plugin.js` in the xpi. `bootstrap.js` stays a classic script (Zotero reads `startup`/`shutdown` from its scope), loads that bundle with `Services.scriptloader.loadSubScript`, and uses `ZTG_Bundle.plugin`. The `.ts` files and `src/types/` are not shipped. There are no runtime dependencies.
- **`model.ts` must stay pure.** No DOM, no `Zotero`, no `Services`, no imports from other plugin files except types. Put any new membership or drop logic here so it can be unit-tested in Node.
- **All Zotero_Tabs internals go through `zoteroTabs.ts`.** `_tabs`, `_selectedID`, `_prevSelectedID`, `_update`, the patched methods and `tabHooks` live only there. If a Zotero update changes `tabs.js`, fix that file.
- **Controller parts.** `WindowController` owns `Decorator`, `DragController` and `EditorBubble` and passes itself to them. They use its public members (`store`, `zt`, `setTimeout`, `logError`, `batch`, ...), not each other's privates.
- **Membership lives on tabs.** Each tab stores its group as `tab.data.tabGroupId`. Zotero already saves `tab.data` in its session file, so membership survives restarts and crashes with no extra storage. Group metadata (`title`, `color`, `collapsed`) lives separately in the pref `extensions.zotero-tab-groups.groups` as JSON, managed by `Store` (`store.ts`).
- **Rules run in `_update()`.** The controller wraps `Zotero_Tabs._update()` so `Model.normalize` runs before every React render. This covers every way a tab can move, not only drag-and-drop.
- **Decoration is after commit.** A MutationObserver adds the chip elements and sets `ztg-*` attributes (and `ztg-hidden` on tabs of collapsed groups) on Zotero's own tab elements. Don't edit Zotero's React output in other ways. The plugin should disappear completely when disabled.
- **Dragging is custom.** Zotero's HTML5 tab drag is replaced with pointer-event dragging. Drop positions are computed once at drag start (`computeDrop`), and tabs move with CSS transforms until drop.
- **Context menu** uses Zotero's `Zotero.MenuManager` API (target `main/tab`). It exists only inside Zotero, not in the harness.
- **Debugging.** Log through `ZoteroTabGroups.log()`, which prefixes messages with `Tab Groups:`. In Zotero, enable Help → Debug Output Logging to see them.

## Test harness

- `test/harness/build-harness.js` bundles `entry.jsx` with esbuild. `entry.jsx` imports the plugin's real `store.ts` and `controller.ts`. It stubs `./icons` with `icons-stub.jsx`, compiles `vendor/_tabBar.scss` with sass, and copies `tabGroups.css` into `dist/` **unmodified**. Keep the plugin source free of harness-only hacks. Put test-only behavior in the harness.
- `entry.jsx` exposes `window.__ztg` (controller and store; tests read `controller.drag.state` for the drag in progress) and `window.__ready`, which the UI tests use.
- `zotero-tabs-shim.js` is a stand-in for Zotero's `tabs.js`. If plugin code depends on a `Zotero_Tabs` method that the shim lacks, add it to the shim and note in the shim header which `tabs.js` behavior it mirrors.
- `test/harness/vendor/` contains Zotero source (AGPL, © Corporation for Digital Scholarship). Do not edit those files. Replace them only by re-vendoring from a specific Zotero commit and updating `ZOTERO_COMMIT`.
- `dist/` and `test/output/` are generated and git-ignored. Set `SHOTS=<dir>` to save screenshots from the UI tests.

## Conventions

- TypeScript (`src/content/`, strict) and JavaScript (`bootstrap.js`, scripts, tests): tab indentation, single quotes, `'use strict'` in CommonJS files, semicolons. Match the style of the file you are editing.
- Node scripts (`scripts/`, `test/harness/build-harness.js`, tests) are CommonJS (`require`).
- Keep the plugin dependency-free at runtime. The shipped artifacts are the static files under `src/` plus the esbuild bundle. The npm devDependencies are for building and testing only.
- Line endings are LF (`.gitattributes` enforces `eol=lf`). `.png` and `.xpi` are binary.
- Commit messages are short imperative or descriptive subject lines in the style of `git log`.

## Versioning and release

- The version is in **two** places that must match: `version` in `src/manifest.json` (what the build and Zotero read) and `version` in `package.json`. Update `updates.json` too, with the new version, `update_link`, and the Zotero range.
- The `.xpi` is built as `build/zotero-tab-groups-<version>.xpi`. `build/` is git-ignored, so do not commit it.
- The update URLs in `src/manifest.json` and `updates.json` point at `CalyrexThePal/zotero-tab-groups` on GitHub (public, `main` is the default branch). Keep them pointed there when you change the release process.
- After confirming behavior in a newer Zotero, raise `strict_max_version` in both `src/manifest.json` and `updates.json`. Do not widen it without testing.

## Things to be careful about

- Zotero's tab session format and `Zotero_Tabs` internals are not public API. Changes that rely on them should be tested inside Zotero, not only in the harness.
- Group membership must stay contiguous. If you change `normalize`, `computeDrop`, or the drag code, add a unit test for the rule and a UI test for the interaction.
- Unknown `tabGroupId` values are dropped on normalize. Don't rely on a group id existing in the store before the tab has been normalized.
- Uninstalling clears the groups pref (`bootstrap.js` `uninstall`). Don't add other persistent state without updating that cleanup.
