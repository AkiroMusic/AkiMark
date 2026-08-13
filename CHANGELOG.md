# Changelog

All notable changes to AkiMark are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **Updater scaffolding** — `tauri-plugin-updater` wired with a signing keypair;
  publish endpoints are intentionally empty until a release host is configured.

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

[Unreleased]: https://github.com/AkiroMusic/AkiMark/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AkiroMusic/AkiMark/releases/tag/v0.1.0
