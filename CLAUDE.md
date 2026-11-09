# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Tab Groups for Zotero**: a Zotero 10 plugin (Firefox-style `bootstrap.js` add-on, manifest v2) that adds Chrome-style tab groups to Zotero's tab bar. Groups have a name, color, and collapsed state, and they persist across restarts. See `README.md` for the user-facing feature list and the design overview.

Zotero 10 is pinned: `strict_min_version` is `10.0` and `strict_max_version` is `10.0.*` in `src/manifest.json`. The vendored tab bar in `test/harness/vendor/` is from Zotero commit `3b17983092c48dba35588ae088d09ea360252a34` (see `ZOTERO_COMMIT`).

## Commands

```sh
npm install
npm test            # unit tests for the pure model (node:test), fast, no browser
npm run test:ui     # builds test/harness/dist/, then runs browser tests (Playwright + Chromium)
npm run build       # packages src/ into build/zotero-tab-groups-<version>.xpi
```

- `test:ui` `require`s `playwright`, but `playwright` is **not** listed in `package.json` or `package-lock.json`. Before running it, install it (`npm install --no-save playwright && npx playwright install chromium`). Do not assume it is already available.
- `npm run build` uses the system `zip` if present and otherwise falls back to a built-in zip writer, so it works on Windows without extra tools.
- Passing `npm test` and `npm run test:ui` is the bar for changes to `src/content/model.js` or the controller. Run both before saying a change works. The browser harness is Chromium, not Gecko, so anything touching Zotero-only APIs (`Zotero.MenuManager`, `Zotero.Prefs`, `Services`) must also be checked inside Zotero.

## Layout

```
src/
  bootstrap.js            lifecycle: startup/shutdown/uninstall, window load/unload hooks
  manifest.json           add-on manifest (id, version, Zotero compatibility range)
  prefs.js                default prefs (groups JSON pref)
  content/model.js        PURE logic: membership normalization, color picking, drop math
  content/store.js        group metadata store (title/color/collapsed), prefs-backed, debounced writes
  content/controller.js   per-window integration: hooks Zotero_Tabs, decorates the tab strip, drag, editor bubble
  content/plugin.js       ZoteroTabGroups entry object: shared store, context menu, window management
  content/tabGroups.css   all group styling, keyed on ztg-* attributes
  locale/en-US/*.ftl      Fluent strings
test/
  model.test.js           unit tests for model.js (require()s it directly)
  ui.test.js              Playwright tests against the harness, real mouse input
  harness/                builds Zotero's real TabBar.jsx + a Zotero_Tabs stand-in into dist/
scripts/build.js          .xpi packager
updates.json              Zotero auto-update manifest
```

## Architecture notes

- **Load order and globals.** `bootstrap.js` loads `model.js`, `store.js`, `controller.js`, `plugin.js` into the add-on scope with `Services.scriptloader.loadSubScript`. The files in `src/content/` are classic scripts, not ES modules. They share state through globals (`ZTG_Model`, `ZTG_Store`, `ZTG_WindowController`, `ZoteroTabGroups`). Do not add `import`/`export` syntax to anything in `src/`. Keep the `/* global ... */` and `/* exported ... */` header comments up to date.
- **`model.js` must stay pure.** No DOM, no `Zotero`, no `Services`. It also has a CommonJS `module.exports` fallback so `test/model.test.js` can load it in Node. Put any new membership or drop logic here so it can be unit-tested.
- **Membership lives on tabs.** Each tab stores its group as `tab.data.tabGroupId`. Zotero already saves `tab.data` in its session file, so membership survives restarts and crashes with no extra storage. Group metadata (`title`, `color`, `collapsed`) lives separately in the pref `extensions.zotero-tab-groups.groups` as JSON, managed by `ZTG_Store`.
- **Rules run in `_update()`.** The controller wraps `Zotero_Tabs._update()` so `ZTG_Model.normalize` runs before every React render. This covers every way a tab can move, not only drag-and-drop.
- **Decoration is after commit.** A MutationObserver adds the chip elements and sets `ztg-*` attributes (and `ztg-hidden` on tabs of collapsed groups) on Zotero's own tab elements. Don't edit Zotero's React output in other ways. The plugin should disappear completely when disabled.
- **Dragging is custom.** Zotero's HTML5 tab drag is replaced with pointer-event dragging. Drop positions are computed once at drag start (`computeDrop`), and tabs move with CSS transforms until drop.
- **Context menu** uses Zotero's `Zotero.MenuManager` API (target `main/tab`). It exists only inside Zotero, not in the harness.
- **Debugging.** Log through `ZoteroTabGroups.log()`, which prefixes messages with `Tab Groups:`. In Zotero, enable Help → Debug Output Logging to see them.

## Test harness

- `test/harness/build-harness.js` bundles `entry.jsx` with esbuild. It stubs `./icons` with `icons-stub.jsx`, compiles `vendor/_tabBar.scss` with sass, and copies the plugin's `model.js`, `store.js`, `controller.js`, and `tabGroups.css` into `dist/` **unmodified**. Keep the plugin source free of harness-only hacks. Put test-only behavior in the harness.
- `entry.jsx` exposes `window.__ztg` (controller and store) and `window.__ready`, which the UI tests use.
- `zotero-tabs-shim.js` is a stand-in for Zotero's `tabs.js`. If plugin code depends on a `Zotero_Tabs` method that the shim lacks, add it to the shim and note in the shim header which `tabs.js` behavior it mirrors.
- `test/harness/vendor/` contains Zotero source (AGPL, © Corporation for Digital Scholarship). Do not edit those files. Replace them only by re-vendoring from a specific Zotero commit and updating `ZOTERO_COMMIT`.
- `dist/` and `test/output/` are generated and git-ignored. Set `SHOTS=<dir>` to save screenshots from the UI tests.

## Conventions

- JavaScript: tab indentation, single quotes, `'use strict'` inside IIFEs and CommonJS files, semicolons. Match the style of the file you are editing.
- Node scripts (`scripts/`, `test/harness/build-harness.js`, tests) are CommonJS (`require`).
- Keep the plugin dependency-free at runtime. The only runtime artifacts are the files under `src/`. The npm devDependencies are for building and testing only.
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
