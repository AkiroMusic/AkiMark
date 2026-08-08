# AkiMark

> Lightweight on-screen annotation tool — mark anything on your screen with a global hotkey, then get out of the way.
> 轻量级屏幕标注工具 —— 通过全局热键随时在屏幕上标记任何内容，标记完立即让开，不碍事。

AkiMark is a minimal, always-resident screen markup utility built with **Tauri v2 + Vue 3**. It sits quietly in your system tray with near-zero resource usage, and activates a full-screen drawing overlay in milliseconds when you press a global hotkey. Great for presentations, screen recordings, teaching, or live collaboration.

AkiMark 是一款基于 **Tauri v2 + Vue 3** 构建的极简常驻屏幕标注工具。它安静地驻留在系统托盘中，资源占用近乎为零；按下全局热键即可在毫秒级内唤起全屏绘制覆盖层。非常适合演示、录屏、教学或实时协作。

![AkiMark](assets/icon-1024.png)

> ⚠️ **Beta / 内测版** — This is an informal preview release (v0.1.0). Features and behavior may change; expect rough edges.
> ⚠️ **Beta / 内测版** — 这是非正式的内测预览版（v0.1.0）。功能与行为可能随时调整，可能尚有不完善之处。

---

## ✨ Features
## ✨ 功能特性

- ⚡ **Instant activation** — Pre-built hidden overlay window; a single global hotkey shows it in milliseconds.
- ⚡ **即时激活** — 预建隐藏覆盖窗口，按一次全局热键即可毫秒级显示。
- 🪟 **Full-screen drawing overlay** — Transparent, always-on-top, skips taskbar.
- 🪟 **全屏绘制覆盖层** — 透明、置顶、不占任务栏。
- 🖌️ **Three tools** — Pen, highlighter, eraser.
- 🖌️ **三种工具** — 画笔、荧光笔、橡皮。
- 🎨 **8-color palette** — Quick color cycling with Q/E.
- 🎨 **8 色调色板** — 用 Q/E 快速循环切换颜色。
- 🔍 **Buttery-smooth strokes** — Dual-canvas engine with quadratic Bézier midpoint smoothing + coalesced pointer events.
- 🔍 **顺滑的笔迹** — 双画布引擎，采用二次贝塞尔中点平滑与合并指针事件。
- ↩️ **Undo / Redo / Clear** — Full history stack.
- ↩️ **撤销 / 重做 / 清屏** — 完整的历史操作栈。
- 🖱️ **Click-through mode** — Toggle mouse pass-through while keeping annotations visible.
- 🖱️ **穿透模式** — 切换鼠标穿透，同时保持标注可见。
- 🧹 **Auto click-through** — Overlay auto-penetrates 120ms after losing focus (with a 600ms activation guard).
- 🧹 **自动穿透** — 覆盖层失焦 120ms 后自动穿透（带 600ms 激活保护）。
- 🪟 **System tray resident** — Zero-drama background presence; single-instance guard.
- 🪟 **系统托盘常驻** — 零打扰的后台驻留；带单实例保护。
- ⚙️ **Settings window** — Configure global shortcuts, launch-at-startup, default tool/color/line width.
- ⚙️ **设置窗口** — 配置全局快捷键、开机自启、默认工具 / 颜色 / 线宽。
- 🌐 **i18n** — English / 简体中文.
- 🌐 **i18n** — 英文 / 简体中文。

---

## ⌨️ Shortcuts
## ⌨️ 快捷键

### Global hotkeys (system-wide)
### 全局快捷键（系统级生效）

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+R` | Toggle annotation mode / 开始 / 结束标注 |
| `Ctrl+Shift+C` | Clear screen / 清屏 |
| `Ctrl+Shift+X` | Toggle click-through / 切换穿透模式 |

| 快捷键 | 操作 |
|---|---|
| `Ctrl+Shift+R` | 切换标注模式（开始 / 结束标注） |
| `Ctrl+Shift+C` | 清屏 |
| `Ctrl+Shift+X` | 切换穿透模式 |

*Configurable in the settings window.*
*可在设置窗口中修改。*

### In-overlay shortcuts
### 标注界面内快捷键

| Shortcut | Action |
|---|---|
| `1` / `2` / `3` | Pen / Highlighter / Eraser |
| `Q` / `E` | Cycle color / 循环切换颜色 |
| `Space` | Toggle toolbar / 显示 / 隐藏工具栏 |
| `X` | Toggle click-through / 切换穿透 |
| `Ctrl+C` | Clear / 清屏 |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Esc` | Exit annotation mode / 退出标注 |

| 快捷键 | 操作 |
|---|---|
| `1` / `2` / `3` | 画笔 / 荧光笔 / 橡皮 |
| `Q` / `E` | 循环切换颜色 |
| `Space` | 显示 / 隐藏工具栏 |
| `X` | 切换穿透 |
| `Ctrl+C` | 清屏 |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Esc` | 退出标注模式 |

### Mouse
### 鼠标操作

| Action | Effect |
|---|---|
| Left-drag | Draw with current tool / 用当前工具绘制 |
| Hold right-button | Temporary eraser / 按住临时擦除 |
| Click toolbar area | Toolbar interaction (not drawing) / 工具栏交互 |

| 操作 | 效果 |
|---|---|
| 左键拖动 | 用当前工具绘制 |
| 按住右键 | 临时橡皮擦 |
| 点击工具栏区域 | 工具栏交互（非绘制） |

---

## 🚀 Getting Started
## 🚀 快速开始

### Requirements
### 环境要求

- [Node.js](https://nodejs.org/) ≥ 20
- [Node.js](https://nodejs.org/) ≥ 20
- [Rust](https://rustup.rs/) (stable, 1.77+)
- [Rust](https://rustup.rs/)（稳定版，1.77+）
- [Tauri v2 CLI prerequisites](https://v2.tauri.app/start/prerequisites/) (Windows: WebView2)
- [Tauri v2 CLI 前置条件](https://v2.tauri.app/start/prerequisites/)（Windows：WebView2）

### Run in development
### 开发运行

```bash
npm install
npm run dev
```

The app starts resident in the tray and opens the settings window. Press `Ctrl+Shift+R` to start annotating.

应用启动后驻留托盘并打开设置窗口，按 `Ctrl+Shift+R` 开始标注。

### Build
### 构建

```bash
npm run build        # bundles installer (NSIS) into src-tauri/target/release/
npm run build:fe     # frontend only (vue-tsc + vite)
```

### Re-generate app icons
### 重新生成图标

```bash
npm run icon         # from assets/icon-1024.png
```

---

## 📦 Project Structure
## 📦 项目结构

```
├── src/                  # Vue 3 frontend
│   ├── components/       # DrawingOverlay, ToolToolbar
│   ├── composables/      # useDrawing (dual-canvas engine)
│   ├── constants/        # tools, colors
│   ├── i18n/             # en / zh-CN
│   ├── App.vue           # overlay entry
│   ├── SettingsApp.vue   # settings window entry
│   └── main.ts           # window-label based routing
├── src-tauri/            # Rust backend
│   ├── src/              # config, shortcuts, overlay, win32, commands…
│   ├── icons/            # generated icon set
│   └── tauri.conf.json
├── assets/               # fonts, icon source
└── scripts/              # gen-icon.mjs
```

---

## ⚙️ Configuration
## ⚙️ 配置

Settings are persisted as JSON in the OS app-config directory (`%APPDATA%\com.akimark.app\config.json` on Windows). Prefer the settings window — but manual edits are honored on next launch.

配置以 JSON 形式保存在操作系统的应用配置目录中（Windows 下为 `%APPDATA%\com.akimark.app\config.json`）。建议优先使用设置窗口修改 —— 手动编辑同样会在下次启动时生效。

```jsonc
{
  "shortcuts": {
    "toggleDrawing": "Ctrl+Shift+R",
    "clearDrawing": "Ctrl+Shift+C",
    "togglePenetration": "Ctrl+Shift+X"
  },
  "general": {
    "locale": "zh-CN",
    "theme": "dark",
    "preserveDrawings": false,
    "lineWidths": { "stroke": 3, "highlighter": 18, "eraser": 24 },
    "defaultTool": "pen",
    "defaultColor": "#6C8CFF",
    "openSettingsOnStartup": true
  }
}
```

---

## 🧭 Design
## 🧭 设计

**Ethereal Glass** — a design language carried over from the Aki design system: frosted-glass surfaces with double bezels, spring easing (`cubic-bezier(0.32,0.72,0,1)`), layered soft shadows, Plus Jakarta Sans / Fraunces / IBM Plex Mono typography.

**Ethereal Glass（空灵玻璃）** —— 延续自 Aki 设计体系的设计语言：毛玻璃表面配双重包边、弹簧缓动（`cubic-bezier(0.32,0.72,0,1)`）、层叠柔影，以及 Plus Jakarta Sans / Fraunces / IBM Plex Mono 字体组合。

---

## 📄 License
## 📄 开源协议

[MIT](LICENSE) © AkiroMusic
[MIT](LICENSE) 许可 © AkiroMusic

---

## 🙏 Acknowledgements
## 🙏 致谢

- [Tauri](https://tauri.app/) — the framework that makes a ~4MB annotation tool possible
- [Tauri](https://tauri.app/) —— 让约 4MB 大小的标注工具成为可能的框架
- [markeron](https://github.com/) — inspiration for the overlay architecture (kept as a reference in `reference-markeron-master/`)
- [markeron](https://github.com/) —— 覆盖层架构的灵感来源（在 `reference-markeron-master/` 中保留作为参考）

---

*Built with 💙 by AkiroMusic*
*AkiroMusic 用 💙 打造 —— 内测版 v0.1.0*
