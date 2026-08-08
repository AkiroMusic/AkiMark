# AkiMark

> Lightweight on-screen annotation tool — mark anything on your screen with a global hotkey, then get out of the way.

AkiMark is a minimal, always-resident screen markup utility built with **Tauri v2 + Vue 3**. It sits quietly in your system tray with near-zero resource usage, and activates a full-screen drawing overlay in milliseconds when you press a global hotkey. Great for presentations, screen recordings, teaching, or live collaboration.

![AkiMark](assets/icon-1024.png)

> ⚠️ **Beta / 内测版** — This is an informal preview release (v0.1.0). Features and behavior may change; expect rough edges. / 这是非正式的内测版本，功能与行为可能随时调整。

---

## ✨ Features / 功能特性

- ⚡ **Instant activation** — Pre-built hidden overlay window; a single global hotkey shows it in milliseconds. / 预建隐藏窗口，全局热键毫秒级激活
- 🪟 **Full-screen drawing overlay** — Transparent, always-on-top, skips taskbar. / 全屏透明置顶覆盖层
- 🖌️ **Three tools** — Pen, highlighter, eraser. / 画笔、荧光笔、橡皮三种工具
- 🎨 **8-color palette** — Quick color cycling with Q/E. / 8 色调色板，Q/E 快速切换
- 🔍 **Buttery-smooth strokes** — Dual-canvas engine with quadratic Bézier midpoint smoothing + coalesced pointer events. / 双画布引擎 + 二次贝塞尔中点平滑
- ↩️ **Undo / Redo / Clear** — Full history stack. / 完整的撤销/重做/清屏
- 🖱️ **Click-through mode** — Toggle mouse pass-through while keeping annotations visible. / 穿透模式：标注保留，鼠标穿透
- 🧹 **Auto click-through** — Overlay auto-penetrates 120ms after losing focus (with a 600ms activation guard). / 失焦自动穿透（带激活保护）
- 🪟 **System tray resident** — Zero-drama background presence; single-instance guard. / 托盘常驻 + 单实例保护
- ⚙️ **Settings window** — Configure global shortcuts, launch-at-startup, default tool/color/line width. / 设置窗口：快捷键、开机自启、默认工具/颜色/线宽
- 🌐 **i18n** — English / 简体中文. / 中英双语

---

## ⌨️ Shortcuts / 快捷键

### Global hotkeys / 全局快捷键 (system-wide)

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+R` | Toggle annotation mode / 开始 / 结束标注 |
| `Ctrl+Shift+C` | Clear screen / 清屏 |
| `Ctrl+Shift+X` | Toggle click-through / 切换穿透模式 |

*Configurable in the settings window. / 可在设置窗口中修改。*

### In-overlay shortcuts / 标注界面内快捷键

| Shortcut | Action |
|---|---|
| `1` / `2` / `3` | Pen / Highlighter / Eraser |
| `Q` / `E` | Cycle color / 循环切换颜色 |
| `Space` | Toggle toolbar / 显示 / 隐藏工具栏 |
| `X` | Toggle click-through / 切换穿透 |
| `Ctrl+C` | Clear / 清屏 |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Esc` | Exit annotation mode / 退出标注 |

### Mouse / 鼠标操作

| Action | Effect |
|---|---|
| Left-drag | Draw with current tool / 用当前工具绘制 |
| Hold right-button | Temporary eraser / 按住临时擦除 |
| Click toolbar area | Toolbar interaction (not drawing) / 工具栏交互 |

---

## 🚀 Getting Started / 快速开始

### Requirements / 环境要求

- [Node.js](https://nodejs.org/) ≥ 20
- [Rust](https://rustup.rs/) (stable, 1.77+)
- [Tauri v2 CLI prerequisites](https://v2.tauri.app/start/prerequisites/) (Windows: WebView2)

### Run in development / 开发运行

```bash
npm install
npm run dev
```

The app starts resident in the tray and opens the settings window. Press `Ctrl+Shift+R` to start annotating. / 应用启动后驻留托盘并打开设置窗口，按 `Ctrl+Shift+R` 开始标注。

### Build / 构建

```bash
npm run build        # bundles installer (NSIS) into src-tauri/target/release/
npm run build:fe     # frontend only (vue-tsc + vite)
```

### Re-generate app icons / 重新生成图标

```bash
npm run icon         # from assets/icon-1024.png
```

---

## 📦 Project Structure / 项目结构

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

## ⚙️ Configuration / 配置

Settings are persisted as JSON in the OS app-config directory (`%APPDATA%\com.akimark.app\config.json` on Windows). Prefer the settings window — but manual edits are honored on next launch. / 配置以 JSON 形式保存在系统应用配置目录，优先使用设置窗口修改。

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

## 🧭 Design / 设计

**Ethereal Glass** — a design language carried over from the Aki design system: frosted-glass surfaces with double bezels, spring easing (`cubic-bezier(0.32,0.72,0,1)`), layered soft shadows, Plus Jakarta Sans / Fraunces / IBM Plex Mono typography. / 延续 Aki 设计系统的 "Ethereal Glass" 语言：毛玻璃双镶边、弹簧缓动、分层柔影。

---

## 📄 License / 开源协议

[MIT](LICENSE) © AkiroMusic

---

## 🙏 Acknowledgements / 致谢

- [Tauri](https://tauri.app/) — the framework that makes a ~4MB annotation tool possible
- [markeron](https://github.com/) — inspiration for the overlay architecture (kept as a reference in `reference-markeron-master/`)

---

*Built with 💙 by AkiroMusic — 内测版 v0.1.0*
