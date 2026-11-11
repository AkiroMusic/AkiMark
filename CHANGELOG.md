# Changelog

All notable changes to AkiMark are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.8] - 2026-11-10

Second- and third-round review: async mode-transition ordering, complete
backend transition critical sections, remaining lifecycle edges, and
config-validation hardening.

### Fixed

- **Mode side-effects are fully awaited** — exit-penetration completes before
  the zoom capture starts, and the board flag is confirmed by
  `set_board_active` before a board switch counts (previously fire-and-forget:
  a global click-through hotkey right after entering board mode could read a
  stale flag and bypass the board protection). Failure semantics unchanged:
  the `togglePenetration` path still rolls back with a toast; other paths
  warn only, and a failed board-flag IPC now rolls `boardMode` back.
- **Stale dispatches stop submitting** — concurrent dispatches interleave at
  await points by design; a dispatch superseded by a newer one now stops
  after its in-flight effect instead of committing remaining effects, writing
  its own post-await UI state (toolbar restore), or running rollbacks (a
  monotonic revision guard, not a global queue). Session-level resets
  (`resetModes` via clear-drawing / re-entry / exit events, and the toolbar's
  exit button) invalidate pending dispatches, so a board switch left hanging
  on its exit-penetration IPC can no longer re-arm the flag after a clear.
  Previously, pressing B twice rapidly from click-through could leave the
  board flag on in the backend while the board UI was off, silently blocking
  click-through.
- **Starting zoom from click-through locks input for the whole transition** —
  during the exit-penetration IPC window the input lock was not yet set, so
  an Escape arriving in that window saw no active overlay mode and quit the
  entire annotation session (a real-machine QA finding, root-caused by
  review). The transition lock is taken before the first effect and released
  in the dispatch's own finally block, so revision invalidation, a rejected
  capture, or any early return still releases it. The toolbar is made inert
  during the lock, and the toolbar's exit entry checks the lock too — the
  exit button could otherwise bypass the lock and quit the session with a
  mouse click (same root as the keyboard path, different device).
- **Mode-transition structured logging** — every backend transition now logs
  its source (hotkey / tray / IPC / window-close / auto focus-loss), before
  and after mode; the capture lifecycle pairs a start entry with an end
  entry on every path, including early exits and the re-show retry failure.
  Previously success paths logged nothing, making post-hoc timeline
  reconstruction impossible.
- **Toolbar dragging stops when the input lock engages** — a drag already in
  progress (its pointer capture survives the toolbar becoming inert) is
  explicitly terminated and released when the lock sets, and new drags are
  declined while locked.
- **Board activation is rejected while hidden** — a late `set_board_active(true)`
  arriving after the overlay was deactivated could re-arm the board flag;
  the backend now rejects it with a new `InvalidState` error so the frontend
  rolls its board UI back.
- **Toolbar race on exiting click-through** — the shared IPC branch hid the
  toolbar for both directions; exiting relied on the backend's
  `drawing-return` event, and the event-vs-IPC race could leave the toolbar
  hidden. Exit now restores it explicitly.
- **Backend transitions are fully locked** — `activate_drawing` previously ran
  without the mode lock and both toggle handlers read the mode outside it:
  concurrent toggles could double-activate, and a racing activate could
  commit between a deactivate's commit and its event, letting the stale
  "hidden" event overwrite frontend state. All four transitions are now
  `*_locked` cores with a single lock spanning window APIs → commit →
  cursor clip → broadcast, and both toggles decide under the lock. Events
  are emitted inside the critical section, so event order = commit order.
- **Click-through exit keeps cursor clip inside the lock** — the post-commit
  `ClipCursor` and `drawing-return` broadcast ran after the lock was
  released; interleaved with a concurrent re-entry they left the backend in
  click-through while the cursor stayed clamped and a stale "returned to
  drawing" event reached the frontend.
- **Partial-failure rollback** — if `set_focus` fails after a successful
  `show()`, activation hides the window again (mode stays Hidden); if
  `hide()` fails after click-through was set, deactivation restores
  interactivity (mode stays Drawing). Neither leaves a visible window
  contradicting the committed mode.
- **Board flag vs click-through is mutually exclusive on the backend** —
  `set_board_active` shares the mode lock with transitions; if a racing
  click-through entry slipped past the flag check, activating the board
  atomically exits click-through first. If that exit fails, the whole call
  fails and the flag is not committed (previously it logged and set the flag
  anyway, so `board_active=true` and `Penetration` could still coexist); the
  error reaches the frontend, which now also restores the click-through UI
  when the exit and the flag IPC fail together.
- **Capture lease keeps the overlay hidden during screenshots** — the
  capture's `hide()` ran outside the mode lock and nothing covered the
  settle-wait/BitBlt window, so two rapid global-hotkey toggles
  (Drawing → Hidden → activate) could re-show the overlay mid-capture and
  bake it into the zoom/mosaic/export base image. A capture lease is now
  taken under the mode lock together with the hide; activations are declined
  (no-op) until the capture's final locked section releases the lease before
  the Hidden check and re-show. Entering click-through is declined during the
  lease too — its event would clear the zoom level, and the returning capture
  would unconditionally reopen it, leaving click-through and zoom active
  together. Captures can only start in drawing mode (a click-through whose
  event was still in flight when the capture began would otherwise race the
  returning zoom commit); the frontend additionally refuses to commit the
  zoom level if the penetration event has already arrived, and the capture's
  finally block respects penetration state when restoring the toolbar (a
  click-through that entered during the pre-capture frame never gets the
  toolbar re-shown over it, and no "capture failed" toast is shown for that
  intentional rejection). Disposing the overlay invalidates pending
  dispatches so an in-flight capture can no longer create a Blob URL after
  unmount. The lock is never held across BitBlt/encode.
- **capture_screen guard leak** — a `WindowNotFound` early return after
  arming the activation guard never disarmed it, permanently disabling auto
  click-through. The window lookup now precedes arming, and the Hidden check
  plus `window.show()` run atomically under the mode lock (a hotkey exit
  during capture can no longer re-pop an empty window).
- **Auto click-through re-checks Settings** — the 120ms delayed thread now
  verifies the settings window isn't focused (opening Settings within the
  window aborts the transition), consistent with "settings focus isn't
  blur".
- **All zoom entries commit the active stroke** — a new `beforeCapture` hook
  fires before every zoom capture; the toolbar button previously skipped the
  commit the keyboard path had.
- **PointerUp final sample** — the release position is fed through
  `drawTo` before ending a stroke (shapes no longer end short of the actual
  release point); `lostpointercapture` is handled as a hang safeguard.
- **Mosaic tail block counts against the cap** — after the 5000-sample cap
  the transient tail block is no longer drawn, keeping preview and
  committed-repaint pixel-identical (previously preview kept appending tail
  blocks past the cap).
- **Mosaic incremental preview clears stale tail blocks** — below the cap the
  transient tail was still painted into the never-cleared incremental preview
  layer each frame, accumulating blocks the committed repaint would not place;
  each incremental frame now clears the previous tail zone and repaints the
  sample blocks it intersects (source-over repaint from the same source is
  idempotent), keeping preview and committed repaint consistent. The test
  mock now shares the canvas size object with the 2D context, so full-canvas
  clears are genuinely distinguishable from tail-zone clears in assertions.
- **Flaky locale tests merged** — two error-localization tests raced on the
  global locale flag (each set → assert → set interleaved with the other's
  assertions), an occasional CI failure unrelated to any code change; they
  are now a single sequential test.
- **Config validation tightened** — hex colors must be exactly
  `#RGB`/`#RRGGBB`/`#RRGGBBAA`; the per-field repair used on load is now
  shared by the save path (`save_general`, and `save_drawing_prefs` rejects
  invalid colors with a new bilingual `InvalidColor` error); shortcut
  rollback persistence retries once (then self-heals on the next save).
- **Docs** — README corrected to the triple-canvas engine and the actual `B`
  behavior (off ⇄ configured default board, not a 3-way cycle); toolchain
  note for the `fetch_update` deprecation shim; mode-runner comments updated
  to the all-awaited effect execution and its exact serialization boundary
  (per-dispatch ordering; concurrent dispatches may interleave at await
  points by design).

Tests: 79 → 98 frontend, 22 → 26 Rust.

## [0.2.7] - 2026-11-10

Reliability release from an external code review: fixes window/mode/capture
lifecycle bugs, a preferences save race, multi-pointer and clear-during-stroke
edge cases, and config persistence robustness.

### Fixed

- **Settings-window focus no longer triggers auto click-through** — the
  focus-loss handler didn't check which window fired, so closing Settings
  while annotating could silently switch the overlay to penetration mode.
- **Penetration failures are no longer swallowed** — the commands returned
  `Ok` regardless of the OS call's result (the frontend rollback path was
  dead code), and the backend committed `Penetration` state *before* calling
  `set_ignore_cursor_events`; a failure left the mode stuck. The mode lock now
  spans the OS call and commits only on success.
- **Capture lifecycle hardened** — if hiding the overlay fails the capture
  aborts (previously it would shoot the overlay's own UI into zoom/mosaic
  bases and exports); a failed re-show retries once, then errors; the
  activation-guard reset now runs on every exit path (an early return could
  leave the guard stuck and permanently disable auto click-through).
- **Alt+F4 exits cleanly** — closing the overlay window ran a bare `hide()`,
  leaving the cursor clamped and the backend mode stuck at `Drawing`; it now
  runs the full deactivation (release cursor, mode → hidden, board reset,
  `hidden` broadcast).
- **Preferences save race** — a save in flight that completed after the user
  changed something else marked the new value as persisted without writing it
  (disk = old, baseline = new), and the next config broadcast then re-adopted
  the stale disk value, losing the user's choice twice. Saves now carry a
  snapshot; after success the baseline advances only to the snapshot and
  dirtiness is recomputed, so newer changes are re-saved.
- **Multi-pointer isolation** — a second pointer (finger/pen) moving during a
  stroke no longer pollutes the path, and its release no longer ends the
  stroke (`activePointerId` filtering on move/up/cancel/fallback).
- **Clear cancels the in-flight stroke** — `Ctrl+D` while dragging no longer
  resurrects the stroke on mouse-up (also fixed when history was empty).
- **Deterministic export boundary** — export/copy/zoom-capture/blur-base all
  commit the active stroke first; previously an uncommitted stroke could be
  missing from the output depending on capture timing.
- **Mosaic sampling is truly incremental** — the arc-length sampler no longer
  recomputes the whole path every frame (O(n²) over a stroke), and the 5000
  sample cap is now a real cap (the old `break` only exited the inner loop,
  letting long multi-segment strokes overshoot).
- **Config persistence is transactional** — `save_general` /
  `save_drawing_prefs` write to disk first and commit memory only on success
  (matching `save_shortcuts`), so a failed write can't split memory vs disk.
- **Hand-edited configs are field-normalized on load** — invalid
  `defaultTool`/`boardDefault`/`locale`/`defaultColor`/`recentColors` fall
  back per-field to defaults instead of producing a NaN line width or unknown
  tool; out-of-range widths are clamped (with a non-finite guard).
- **Toolbar drag with scaling** — the dragged state now uses a top-left
  transform origin so `left/top` and `getBoundingClientRect` share one
  coordinate system (no drift at 0.6×/1.5×), and remembered positions are
  re-clamped to the viewport on load and on resize.
- **Small UX fixes** — `Shift+Q/E` cycle colors (matching `b/B`, `x/X`,
  `z/Z`); the color picker only records a color into "recent" on confirm
  (`change`), not on every drag `input`; the custom cursor reappears when the
  pointer re-enters the window; IME composition no longer triggers overlay
  hotkeys, and text-tool `Enter`/`Esc` during composition commit/cancel the
  IME candidate instead of the annotation (Chinese IME fix).
- **Docs** — removed the stale `Ctrl+C = Clear` table rows; README now states
  Windows 10/11-only explicitly.

Tests: 72 → 79 frontend, 18 → 22 Rust.

## [0.2.6] - 2026-10-12

Performance release: eliminates the chronic frame drops during annotation.

### Fixed

- **GPU compositing restored** — the `--disable-gpu-compositing` flag (added in
  v0.2.0 to stop WebView2 video overlays from capturing as black) forced full
  CPU software compositing, multiplying the cost of the full-screen transparent
  window × 3 canvases × spotlight gradient × glass surfaces. Replaced with the
  targeted `--disable-direct-composition-video-overlays`: video still renders
  through a capturable path, everything else gets GPU compositing back.
- **Pointer-move no longer re-renders the app** — cursor position was a Vue ref
  feeding five template bindings (custom cursor, spotlight hole, zoom ring,
  zoom origin), so every `pointermove` patched the whole overlay component.
  Cursor-following visuals are now written directly to element styles from a
  single rAF; pointer movement does zero Vue work.
- **Spotlight uses a compositor-friendly cutout** — the per-frame full-screen
  radial-gradient repaint is replaced by a small ring element with a solid
  `box-shadow` fill, moved via `transform` (no repaint while following the
  cursor). Visuals (darkness, feather band, wheel-adjustable radius) unchanged.
- **Zoom origin no longer animates** — the `transform-origin 0.05s` transition
  forced style churn every frame while the origin followed the cursor; the
  origin is now written directly and the transition removed.
- **Long strokes are O(n), not O(n²)** — eraser drag (used to restore a
  full-layer snapshot per move), mosaic preview (up to 5000 `drawImage` calls
  per frame) and pen preview (full-path re-stroke per frame) now draw only the
  newly added segments/blocks. Results are pixel-identical (idempotent
  compositing), locked by 5 new unit tests (67 → 72).
- **`backdrop-filter` removed** from glass surfaces (toolbar, toast, settings
  cards, error banner) — real-time blur behind a full-screen transparent window
  is a standing compositing tax; readability is kept by slightly more opaque
  backgrounds (0.62 → 0.72, 0.82 → 0.92).

## [0.2.5] - 2026-09-13

### Changed

- **New app icon** — replaced the full generated icon set (ICO/PNG/Windows
  Store logos, transparent background) from a new source artwork; also updates
  the README logo and the tray/installer icons via the standard build pipeline.

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

[0.2.5]: https://github.com/AkiroMusic/AkiMark/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/AkiroMusic/AkiMark/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/AkiroMusic/AkiMark/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/AkiroMusic/AkiMark/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/AkiroMusic/AkiMark/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/AkiroMusic/AkiMark/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AkiroMusic/AkiMark/releases/tag/v0.1.0
