# Changelog

All notable changes to AkiMark are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.4] - 2026-09-13

Three user-reported fixes plus WebView2 disk-usage housekeeping.

### Fixed

- **Screen didn't magnify in zoom mode (strokes only)** — the v0.2.3 switch of
  the zoom background to Blob URLs was silently blocked by CSP
  (`img-src` lacked `blob:`), leaving only the magnified strokes visible over
  the real desktop. `blob:` is now allowed.
- **Line width changed in Settings reverted / never applied** — two bugs in
  combination: the overlay ignored preset fields from `config-changed`
  broadcasts, and its exit-time prefs flush unconditionally wrote the stale
  session values back over what Settings had just saved. Preset fields are now
  diffed against a baseline (adopted live when Settings changes them), and the
  overlay only persists when the user actually changed something in-session.
- **Toolbar hard to read / can't move it out of the way quickly** — the
  toolbar background is more opaque (0.82 → 0.90), and `Ctrl+=` / `Ctrl+-`
  scale the whole toolbar between 60%–150% (persisted; also helps when it
  covers content near the top edge).

### Changed

- **WebView2 disk footprint** — HTTP disk cache capped at 16 MB (the app makes
  zero network requests), and the NSIS uninstaller now removes the WebView2
  user-data folder (`%LOCALAPPDATA%\com.akimark.app`), which could grow to
  hundreds of MB and was previously left behind on uninstall.

## [0.2.3] - 2026-09-13

Architecture/i18n/release-engineering closeout.

### Changed

- **Overlay decomposed** — the mode-mutex rules (board / zoom / spotlight /
  click-through / toolbar) that were smeared across six handlers now live in
  `modeMutex.ts`, a pure function (`applyModeAction → { state, effects }`)
  locked by 12 unit tests, executed by a new `useOverlayModes` composable.
  Toast, text-editor, and prefs-sync logic moved into their own composables;
  the overlay script shrank from ~1110 to ~770 lines with unchanged behavior
  (53 → 63 tests green).
- **Backend speaks English too** — user-facing `AppError` messages serialize
  in the configured locale (`Display` stays Chinese for logs); the tray menu
  and settings-window title rebuild on language save.
- **Second launch opens Settings** instead of toggling annotation (a double
  click on the icon most likely means "I want the config window"; the toggle
  already has hotkeys and the tray).

### Fixed

- **Mosaic state is per-instance** — the module-level blur-base/composite
  shared state moved into the composable closure, eliminating cross-instance
  contamination (surfaced once tests ran under a DOM environment).
- Global timer typing pollution from a transitive `@types/node` (fade timer
  now uses `window.setInterval`).

### Added

- **Release pipeline** — pushing a `v*` tag builds the NSIS installer via
  tauri-action and opens a draft GitHub Release; documented in CONTRIBUTING.
- **Component tests** — @vue/test-utils + happy-dom: 7 ToolToolbar cases and
  i18n behavior tests; per-file `@vitest-environment happy-dom` opt-in.
- Tooling anchors: `.prettierrc.json`/`.prettierignore`, `.nvmrc` (CI reads
  it), `.editorconfig`, `tsconfig.node.json` (vite/vitest configs
  type-checked in `build:fe`), CONTRIBUTING/PR checklist synced with CI.

## [0.2.2] - 2026-09-13

Stability/performance pass and the first batch of community-style feature gaps.

### Added

- **Copy annotation to clipboard** — `Ctrl+C` or a toolbar button composites
  annotations onto the screen and puts a PNG on the clipboard (via
  `tauri-plugin-clipboard-manager`; decoding and ACL stay in Rust).
- **Step-counter tool** — click to place auto-incrementing numbered badges
  (number recalculates after undo/clear); toolbar entry, no digit hotkey
  (0–9 are all taken).
- **Custom colors + recent colors** — a "+" swatch opens the native color
  picker; the last 4 custom colors persist alongside drawing prefs.
- **Shape fill** — hold `Shift` while drawing a rectangle/circle to fill it.
- **Settings: language switcher and "keep drawings on exit" switch** — the
  locale and preserveDrawings config values finally have UI controls.
- **Toolbar drag & narrow-screen wrap** — drag the toolbar by its padding,
  position remembered locally; buttons wrap below ~1000px viewports.
- **Visible failure feedback** — a persistent banner when overlay
  initialization fails, toasts for mosaic base ready / penetration toggle
  failure, and export-folder picker errors now surface in the UI.

### Performance

- **Fading pen has its own canvas layer** — the 250 ms fade tick now repaints
  only fading strokes instead of replaying the entire history (including
  mosaic re-sampling up to 5000 drawImage calls per stroke).
- **Eraser drag is incremental** — a per-stroke snapshot of the history layer
  replaces the per-frame full-history replay; snapshot invalidates on
  undo/resize and falls back to the full path.
- **Memory**: the zoom background now uses a Blob URL (revoked on exit)
  instead of a persistent base64 data URL; the export canvas scale is clamped
  like the on-screen canvases.

### Changed

- **`Ctrl+D` clears the screen** (was `Ctrl+C`, which now copies) — resolves
  the conflict with the system-wide "copy" reflex.
- **Canvas pixel clamp fixed** — `MAX_CANVAS_PIXELS` (6M → 9M) is no longer
  defeated by `Math.max(1, dpr)`: normal screens keep full resolution, 8K+
  setups downsample the backing bitmap instead of risking OOM.

### Fixed

- `renderTo` restores the mosaic base even when export rendering throws.
- README: version refreshed, `theme` dead config removed from examples,
  Esc step-out description now includes the spotlight layer, undo-stack
  wording corrected.

### Removed

- **`theme` config field** — it never had an implementation (single dark
  theme); the field is dropped from config structs and docs (old config.json
  files load fine; the unknown key is ignored).

## [0.2.1] - 2026-09-13

Zero-defect audit: correctness fixes found by a full code review, plus
hardening of CI, permissions, and logging.

### Changed

- **Tool hotkey remap** (post-0.2.0, now documented): fading pen `9` → `2`,
  line/rect/circle/arrow `4`/`5`/`6`/`7` → `5`/`6`/`7`/`8`, text `8` → `9`
  (highlighter `3`, eraser `4`, blur `0` unchanged). The 0.2.0 entries below
  reflect the mapping at release time.
- **`config-changed` no longer overwrites session state** — the overlay only
  applies non-session fields (locale / board default / preserve drawings) from
  broadcast config; tool/color/line-width presets are applied once at startup.
  `save_drawing_prefs` no longer broadcasts, so a stale echo can no longer roll
  back the user's latest choice during the 500 ms debounce window.
- **Keyboard auto-repeat is ignored for mode toggles** (`B`/Space/X/F/M/Z) —
  holding the key no longer re-triggers `invoke`/capture side effects.
  Meta combos (`Ctrl+Z`/`Ctrl+Y`) still repeat.
- **Shortcut recorder reworked** — parses the physical key via `e.code`, so
  `Ctrl+Shift+1`-style combos are recordable; `Esc`/`Tab` now cancel recording
  instead of being bindable; modifier-only presses no longer clear the field.
- **Hardened WebView2 args** — `additionalBrowserArgs` now includes wry's
  default `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`
  (setting the field previously replaced the defaults entirely).
- **Release logging** — tauri/wry internal logs are capped at Info level in
  release builds; log writes are mutex-serialized; key shortcut/toggle errors
  go to the file log instead of `eprintln!` (invisible in release).

### Fixed

- **Zoom-mode drawing landed away from the cursor** — the zoom layer's visual
  origin followed the live cursor while the inverse mapping used the anchor
  frozen at pointer-down (offset = `(1-z)×(cursor−anchor)`). During a stroke
  the origin is now locked to the same anchor; `mapToCapture` was extracted as
  a pure function with round-trip unit tests. Right-button erasing in zoom mode
  now freezes its own anchor instead of reusing a stale one.
- **Mosaic granularity changed when switching tools** — re-renders sized mosaic
  cells from the *current* tool width; they are now locked to the stroke's own
  captured width (regression test F3).
- **Fading-pen "beading"** — per-segment stroking at alpha < 1 double-composited
  overlapping round caps; fading strokes now render as a single smoothed path.
- **Settings window ignored the saved locale** — it always followed the system
  language; the configured locale is now applied on load.
- **GDI double release in `capture.rs`** — the `GetDIBits` failure path cleaned
  up already-freed handles (use-after-free of recycled GDI handles); the dead
  second cleanup block was removed.
- **Screenshots could come out fully transparent on some machines** — the alpha
  byte from `GetDIBits` is undefined by contract; it is now forced to `0xFF`.
- **Capture/export blocked the whole app** — both commands ran synchronously on
  the main thread (80 ms sleep + full-screen BitBlt + PNG encode / 50 MB base64
  decode); they are now `#[tauri::command(async)]`.
- **Click-through exit clamped the cursor to the wrong monitor** — multi-monitor
  setups clamped to the cursor's monitor instead of the overlay's; the cursor is
  now clamped to the canvas monitor.
- **Activation failure could leave the cursor clipped with no window** —
  `ClipCursor` is applied only after `show()`/`set_focus()` succeed.
- **Pointer race** — starting a second gesture (e.g. tablet palm touch) during
  an active stroke silently dropped the in-progress stroke; new pointer-downs
  are now ignored while one is active.
- **Resize storms** — resize handling is debounced (80 ms) instead of tearing
  down both canvases per event.
- **Orphan watcher** — the drawing-prefs watcher was registered after the first
  `await` in `onMounted`, so it never auto-disposed; it now registers in the
  synchronous setup phase.
- **Duplicate conflict entries** — re-saving an occupied shortcut reported the
  same accelerator twice in the conflict list.
- **Concurrent config saves could clobber each other** — the atomic-write temp
  file is now process-unique instead of a shared fixed name.
- **Corrupted `config.json` was silently overwritten** — the broken file is now
  renamed to `config.json.bak` before falling back to defaults.

### Security

- **Capabilities minimized** — 15 unused `core:window:*` grants and 3 unused
  `autostart:*` grants were removed (all window/autostart operations happen in
  Rust, outside the ACL); the webview now only holds `core:default` +
  `dialog:allow-open`.

### Removed

- `reference-markeron-master/` (a third-party reference snapshot, ~69% of
  tracked files) is no longer tracked; the README credit links to the upstream
  repository.
- Dead code: unused `overlayRoot` template ref, `ToolDef.translucent` flag,
  unused `settings.close` i18n keys, and `.icon-btn` styles.

### Engineering

- CI now enforces `cargo fmt --check`, `cargo clippy -D warnings`,
  `cargo check` with `-D warnings`, and oxlint for the frontend; tests run on
  the dev profile; the workflow declares read-only permissions, timeouts,
  concurrency cancellation, and path filters.
- `@tauri-apps/api` moved to `dependencies` (it is a runtime dependency).

## [0.2.0] - 2026-08-14

### Added

- **Five new drawing tools** — line, rectangle, circle, arrow, and text (toolbar
  keys `4`/`5`/`6`/`7`/`8`), bringing the toolset from three to eight.
- **Text input tool** — type text on the overlay, commit with Enter, cancel with
  Esc; the committed text is part of the drawing history (undoable).
- **Spotlight (`F`)** — dims the whole screen except a highlight that follows the
  cursor.
- **Magnifier (`M`)** — ZoomIt-style screen magnifier (2x / 4x) built on the
  screenshot pipeline.
- **Export screenshot (`S` / toolbar button)** — composites the annotations onto
  the underlying screen and saves a PNG via the native backend.
- **Multi-monitor screenshot capture** — `capture.rs` grabs the cursor's actual
  monitor (via `EnumDisplayMonitors`) instead of assuming the primary display,
  fixing failed/blank exports on secondary or negative-coordinate monitors.
- **File logging** — `log.rs` writes a daily `akimark.log` under the OS app-data
  logs dir (`install_log_facade` routes both Rust and frontend output there).
- **Fading pen (`9`)** — strokes fade out and are purged from history ~3s after
  being drawn; the purge stays consistent with the undo/redo stacks.
- **Blur / mosaic pen (`0`)** — pixelates the underlying screen along the stroke
  path; the mosaic source is a fresh screenshot (taken lazily on first use) and
  the export re-captures so the mosaic always reflects the current screen.
- **Whiteboard / blackboard mode (`B`)** — toggles a plain white or black full-
  screen board for free-hand lecturing; export skips the screen capture and
  composites strokes onto the solid color instead.
- **Screen zoom (`Z`)** — ZoomIt-style frozen 2x/4x/6x/8x zoom of the entire
  overlay anchored at the cursor, with drawing still possible while zoomed
  (cursor coordinates are inverse-mapped to the capture space at stroke start);
  scroll to change the level, mutually exclusive with the magnifier.

### Removed

- **移除未生效的软件更新（Updater）功能** — `tauri-plugin-updater`、签名密钥、
  更新端点与发布清单（`RELEASE.md`）一并移除；应用不再检查更新。

### Fixed

- **Eraser punched transparent holes into exported PNGs** — strokes are now
  rendered onto a separate transparent layer and composited over the captured
  background, so `destination-out` erasing can only affect the strokes.
- **Screenshot during an active stroke could race the history** — keyboard and
  pointer input are locked while the export/magnifier capture is in flight
  (`uiLocked`), and opening the magnifier commits any in-progress text first.
- **Activation-guard race** — `capture_screen` (150 ms reset) and
  `activate_drawing` (600 ms reset) both wrote the same raw flag; a stale
  short-delay reset could cancel a newer activation. Replaced with a generation
  counter (`arm_activation_guard` / `disarm_activation_guard`) so an old reset
  is a no-op once a newer arm has occurred.
- **Settings window WebView2 failure (`0x8007139F`)** — the `additionalBrowserArgs`
  for the overlay window now match the settings window; opening settings no
  longer throws and correctly focuses.
- **Line-width defaults drift** — README/config examples previously claimed
  highlighter 14 / eraser 18 while the code defaults to 10 / 12; documentation
  now matches the implementation.
- **Stale pressure documentation** — mouse/trackpad no longer simulate pressure
  by stroke speed (removed earlier); README and settings help text now say pen
  tablets get real pressure and mouse/trackpad draw at constant width.

### Security

- **Export payload size cap** — `save_export` rejects base64 payloads above
  50 MB instead of decoding unbounded input.
- **Export-dir path normalization** — relative `exportDir` values are resolved
  against the user home directory rather than the process CWD, preventing
  writes to unexpected locations.

## [0.1.0] - 2026-08-06

Initial public beta of AkiMark — a lightweight, always-resident screen
annotation tool built with Tauri v2 + Vue 3.

### Added

- **Instant activation** — a pre-built hidden overlay window shows in
  milliseconds via global hotkey (`Ctrl+Shift+R`).
- **Pen / highlighter / eraser** tools with an 8-color palette (`Q`/`E` cycle).
- **Dual-canvas drawing engine** — quadratic Bézier midpoint smoothing,
  coalesced pointer events, pen-tablet pressure support.
- **Undo / Redo / Clear** (`Ctrl+Z` / `Ctrl+Y` / `Ctrl+C`) with a full history
  stack; last-used tool/color/width persist across launches.
- **Click-through mode** (`Ctrl+Shift+X` global, `X` in-overlay) — annotations
  stay visible while the mouse passes through; strokes are preserved across
  mode switches.
- **Auto click-through** — the overlay penetrates 120 ms after losing focus
  (guarded for 600 ms after activation so toolbar clicks don't trigger it).
- **System-tray resident** with single-instance guard; `Ctrl+Shift+C` clears the
  screen globally.
- **Settings window** — global-shortcut configuration with conflict detection,
  launch-at-startup, default tool/color/line width, locale, and export folder.
- **Pen-styled cursor** (45° pen tip) and **i18n** (English / 简体中文).
- **Bilingual README** and project documentation.

### Fixed

- Settings-window loading, shortcut conflict detection UX, and the pen cursor
  behavior (early preview fixes).
- Black screen over video content while drawing on the overlay.
- CI pipeline (runs frontend checks and Windows backend build) and Node-20
  action deprecations.

[0.2.4]: https://github.com/AkiroMusic/AkiMark/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/AkiroMusic/AkiMark/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/AkiroMusic/AkiMark/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/AkiroMusic/AkiMark/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/AkiroMusic/AkiMark/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AkiroMusic/AkiMark/releases/tag/v0.1.0
