# AkiMark

> Lightweight on-screen annotation tool — mark anything on your screen with a global hotkey, then get out of the way.

AkiMark is a minimal, always-resident screen markup utility built with **Tauri v2 + Vue 3**. It sits quietly in your system tray with near-zero resource usage, and activates a full-screen drawing overlay in milliseconds when you press a global hotkey. Great for presentations, screen recordings, teaching, or live collaboration.

![AkiMark](assets/icon-1024.png)

> ⚠️ **Beta** — This is an informal preview release (v0.2.0). Features and behavior may change; expect rough edges.

---

## ✨ Features

- ⚡ **Instant activation** — Pre-built hidden overlay window; a single global hotkey shows it in milliseconds.
- 🪟 **Full-screen drawing overlay** — Transparent, always-on-top, skips taskbar.
- 🖌️ **Ten tools** — Pen, highlighter, eraser, line, rectangle, circle, arrow, text, fading pen, blur.
- 🎨 **8-color palette** — Quick color cycling with Q/E.
- 🔍 **Buttery-smooth strokes** — Dual-canvas engine with quadratic Bézier midpoint smoothing + coalesced pointer events. Pressure-sensitive on pen tablets; mouse/trackpad draw at a constant width.
- ⏳ **Fading pen** — Strokes dissolve automatically ~3s after being drawn (press `2`); perfect for transient emphasis.
- 🧊 **Blur (mosaic) pen** — Pixelate regions of the underlying screen along the stroke path (press `0`).
- 🔦 **Spotlight** — Dim everything except a follow-cursor highlight (press `F`; scroll adjusts radius).
- 🧑‍🏫 **Whiteboard / Blackboard mode** — Flip the overlay into a plain white or black board for free-hand lecturing (press `B`; export skips the screen capture).
- 🔍 **Screen zoom** — Freeze-zoom the whole overlay 2x–8x with the cursor as the anchor, and keep drawing while zoomed (press `M` / `Z`; scroll to change the level).
- 📸 **Export screenshot** — Composite annotations onto the underlying screen and save as PNG (press `S` or the toolbar button; custom export folder).
- ↩️ **Undo / Redo / Clear** — Full history stack.
- 🖱️ **Click-through mode** — Toggle mouse pass-through while keeping annotations visible.
- 🧹 **Auto click-through** — Overlay auto-penetrates 120ms after losing focus (with a 600ms activation guard).
- 🪟 **System tray resident** — Zero-drama background presence; single-instance guard.
- ⚙️ **Settings window** — Configure global shortcuts, launch-at-startup, default tool/color/line width, export folder.
- 📁 **Custom export folder** — Choose where exported PNG screenshots go (defaults to Desktop).
- 🚦 **Shortcut conflict detection** — Saving a hotkey already taken by another app shows an inline warning and keeps the previous binding.
- ✏️ **Pen-styled cursor** — A 45° pen-tip cursor that feels like writing.
- 🌐 **i18n** — English / 简体中文.

---

## ⌨️ Shortcuts

### Global hotkeys (system-wide)

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+R` | Toggle annotation mode |
| `Ctrl+Shift+C` | Clear screen |
| `Ctrl+Shift+X` | Toggle click-through |

*Configurable in the settings window.*

> 🚦 If a hotkey is already taken by another app, the settings window shows an inline warning and keeps the previous binding.

### In-overlay shortcuts

| Shortcut | Action |
|---|---|
| `1` / `2` / `3` | Pen / Fading pen / Highlighter |
| `4` / `5` / `6` | Eraser / Line / Rectangle |
| `7` / `8` | Circle / Arrow |
| `9` / `0` | Text / Blur |
| `Q` / `E` | Cycle color |
| `F` | Toggle spotlight (scroll adjusts radius) |
| `M` / `Z` | Toggle screen zoom (click to focus at cursor, scroll changes 2x / 4x / 6x / 8x) |
| `B` | Cycle board mode (off → whiteboard → blackboard) |
| `S` | Export screenshot as PNG |
| `Space` | Toggle toolbar |
| `X` | Toggle click-through |
| `Ctrl+C` | Clear |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Esc` | Exit annotation mode |

### Mouse

| Action | Effect |
|---|---|
| Left-drag | Draw with current tool |
| Hold right-button | Temporary eraser |
| Click toolbar area | Toolbar interaction (not drawing) |

### Mode interactions

AkiMark's overlay modes are designed to be mutually self-consistent — each mode combination behaves predictably, with no dead states:

- **Board mode (B) blocks screen zoom & click-through** — while a whiteboard/blackboard is on, the overlay is a pure writing surface: zoom would leak the real screen behind it, and click-through would let the mouse operate the app underneath. Entering board mode exits zoom and click-through automatically; the zoom and click-through toolbar buttons are disabled with a hint.
- **Zoom ↔ spotlight are mutually exclusive** — entering one exits the other, so the scroll wheel always has a single meaning (spotlight radius when spotlight is on, zoom level when zoomed).
- **Zoom ↔ click-through are mutually exclusive** — entering one exits the other, avoiding a frozen zoomed screenshot blocking the app you are clicking through to.
- **Spotlight + click-through are allowed** — spotlight is a pure visual overlay (it never intercepts the mouse), so it works as a "laser pointer" while clicking through.
- **`Esc` steps out layer by layer** — zoom first, then board mode, then annotation mode.
- Click-through is additionally refused at the backend level while a board is active, so the global hotkey and the auto-penetration-on-focus-loss feature can never bypass the rule.

---

## 🚀 Getting Started

### Requirements

- [Node.js](https://nodejs.org/) ≥ 20
- [Rust](https://rustup.rs/) (stable, 1.77+)
- [Tauri v2 CLI prerequisites](https://v2.tauri.app/start/prerequisites/) (Windows: WebView2)

### Run in development

```bash
npm install
npm run dev
```

The app starts resident in the tray and opens the settings window. Press `Ctrl+Shift+R` to start annotating.

### Build

```bash
npm run build        # bundles installer (NSIS) into src-tauri/target/release/
npm run build:fe     # frontend only (vue-tsc + vite)
```

### Re-generate app icons

```bash
npm run icon         # from assets/icon-1024.png
```

---

## 📦 Project Structure

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

Settings are persisted as JSON in the OS app-config directory (`%APPDATA%\com.akimark.app\config.json` on Windows). Prefer the settings window — but manual edits are honored on next launch.

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
    "lineWidths": { "stroke": 3, "highlighter": 10, "eraser": 12 },
    "defaultTool": "pen",
    "defaultColor": "#6C8CFF",
    "boardDefault": "white",
    "openSettingsOnStartup": true,
    "exportDir": null
  }
}
```

---

## 🧭 Design

**Ethereal Glass** — a design language carried over from the Aki design system: frosted-glass surfaces with double bezels, spring easing (`cubic-bezier(0.32,0.72,0,1)`), layered soft shadows, Plus Jakarta Sans / Fraunces / IBM Plex Mono typography.

---

## 📄 License

[MIT](LICENSE) © AkiroMusic

---

## 🙏 Acknowledgements

- [Tauri](https://tauri.app/) — the framework that makes a ~4MB annotation tool possible
- [markeron](https://github.com/) — inspiration for the overlay architecture (kept as a reference in `reference-markeron-master/`)

---

*Built with 💙 by AkiroMusic*

---

# AkiMark（轻量级屏幕标注工具）

> 轻量级屏幕标注工具 —— 通过全局热键随时在屏幕上标记任何内容，标记完立即让开，不碍事。

AkiMark 是一款基于 **Tauri v2 + Vue 3** 构建的极简常驻屏幕标注工具。它安静地驻留在系统托盘中，资源占用近乎为零；按下全局热键即可在毫秒级内唤起全屏绘制覆盖层。非常适合演示、录屏、教学或实时协作。

![AkiMark](assets/icon-1024.png)

> ⚠️ **内测版** — 这是非正式的内测预览版（v0.2.0）。功能与行为可能随时调整，可能尚有不完善之处。

---

## ✨ 功能特性

- ⚡ **即时激活** — 预建隐藏覆盖窗口，按一次全局热键即可毫秒级显示。
- 🪟 **全屏绘制覆盖层** — 透明、置顶、不占任务栏。
- 🖌️ **十种工具** — 画笔、荧光笔、橡皮、直线、矩形、圆形、箭头、文字、渐隐笔、马赛克笔。
- 🎨 **8 色调色板** — 用 Q/E 快速循环切换颜色。
- 🔍 **顺滑的笔迹** — 双画布引擎，采用二次贝塞尔中点平滑与合并指针事件。数位板笔支持真实压感；鼠标 / 触控板以恒定宽度绘制。
- ⏳ **渐隐笔** — 笔画绘制约 3 秒后自动溶解消失（按 `2`）；适合临时强调。
- 🧊 **马赛克笔** — 沿笔画路径将底层屏幕画面打上马赛克（按 `0`）。
- 🔦 **聚光灯** — 压暗周围，突出跟随光标的亮点（按 `F`；滚轮调节半径）。
- 🧑‍🏫 **白板 / 黑板模式** — 一键切换纯白 / 纯黑板书底，自由板书（按 `B`；导出时跳过截屏）。
- 🔍 **屏幕缩放** — 以光标为锚点将整个覆盖层冻结放大 2x–8x，放大状态下仍可绘制（按 `M` / `Z`；滚轮调整倍率）。
- 📸 **导出截图** — 将标注合成到底层屏幕并保存为 PNG（按 `S` 或工具栏按钮；可自定义导出目录）。
- ↩️ **撤销 / 重做 / 清屏** — 完整的历史操作栈。
- 🖱️ **穿透模式** — 切换鼠标穿透，同时保持标注可见。
- 🧹 **自动穿透** — 覆盖层失焦 120ms 后自动穿透（带 600ms 激活保护）。
- 🪟 **系统托盘常驻** — 零打扰的后台驻留；带单实例保护。
- ⚙️ **设置窗口** — 配置全局快捷键、开机自启、默认工具 / 颜色 / 线宽、导出目录。
- 📁 **自定义导出目录** — 可自由选择截图导出的保存位置（默认桌面）。
- 🚦 **快捷键占用检测** — 保存被其他程序占用的快捷键时，内联提示冲突并保留原绑定。
- ✏️ **笔尖光标** — 45° 倾斜的笔尖光标，更接近真实书写的手感。
- 🌐 **i18n** — 英文 / 简体中文。

---

## ⌨️ 快捷键

### 全局快捷键（系统级生效）

| 快捷键 | 操作 |
|---|---|
| `Ctrl+Shift+R` | 切换标注模式（开始 / 结束标注） |
| `Ctrl+Shift+C` | 清屏 |
| `Ctrl+Shift+X` | 切换穿透模式 |

*可在设置窗口中修改。*

> 🚦 若快捷键已被其他程序占用，设置窗口会提示冲突并保留原绑定。

### 标注界面内快捷键

| 快捷键 | 操作 |
|---|---|
| `1` / `2` / `3` | 画笔 / 渐隐笔 / 荧光笔 |
| `4` / `5` / `6` | 橡皮 / 直线 / 矩形 |
| `7` / `8` | 圆形 / 箭头 |
| `9` / `0` | 文字 / 马赛克笔 |
| `Q` / `E` | 循环切换颜色 |
| `F` | 开关聚光灯（滚轮调节半径） |
| `M` / `Z` | 开关屏幕缩放（点击以光标处聚焦，滚轮切换 2x / 4x / 6x / 8x） |
| `B` | 循环黑板模式（关 → 白板 → 黑板） |
| `S` | 导出截图 PNG |
| `Space` | 显示 / 隐藏工具栏 |
| `X` | 切换穿透 |
| `Ctrl+C` | 清屏 |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Esc` | 退出标注模式 |

### 鼠标操作

| 操作 | 效果 |
|---|---|
| 左键拖动 | 用当前工具绘制 |
| 按住右键 | 临时橡皮擦 |
| 点击工具栏区域 | 工具栏交互（非绘制） |

### 模式互斥逻辑

AkiMark 的叠加模式经过全面设计，保证逻辑完全自洽 —— 任意模式组合的行为都可预期，不存在死状态：

- **板书模式（B）下禁用屏幕缩放与鼠标穿透** —— 板书开启时覆盖层是纯粹的书写面：缩放会透过板书纯色底露出真实屏幕，穿透则会让鼠标操作到下层应用。进入板书会自动退出缩放与穿透；缩放和穿透的工具栏按钮在板书期间置灰并给出提示。
- **缩放 ↔ 聚光灯互斥** —— 进入其中一个自动退出另一个，滚轮在任何时刻只有一个含义（聚光灯开启时调半径，缩放时调倍率）。
- **缩放 ↔ 穿透互斥** —— 进入其中一个自动退出另一个，避免冻结的放大画面挡住你正要穿透操作的应用。
- **聚光灯 + 穿透可共存** —— 聚光灯是纯视觉叠加（从不拦截鼠标），穿透时相当于"激光笔"高亮。
- **`Esc` 逐级退出** —— 先退缩放，再退板书，最后退出标注。
- **后端兜底** —— 板书期间穿透还会在后端被拒绝，全局热键与失焦自动穿透两条路径都无法绕过该规则。

---

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) ≥ 20
- [Rust](https://rustup.rs/)（稳定版，1.77+）
- [Tauri v2 CLI 前置条件](https://v2.tauri.app/start/prerequisites/)（Windows：WebView2）

### 开发运行

```bash
npm install
npm run dev
```

应用启动后驻留托盘并打开设置窗口，按 `Ctrl+Shift+R` 开始标注。

### 构建

```bash
npm run build        # 打包安装程序（NSIS）到 src-tauri/target/release/
npm run build:fe     # 仅构建前端（vue-tsc + vite）
```

### 重新生成图标

```bash
npm run icon         # 从 assets/icon-1024.png 生成
```

---

## 📦 项目结构

```
├── src/                  # Vue 3 前端
│   ├── components/       # DrawingOverlay、ToolToolbar
│   ├── composables/      # useDrawing（双画布引擎）
│   ├── constants/        # 工具、颜色
│   ├── i18n/             # en / zh-CN
│   ├── App.vue           # 覆盖层入口
│   ├── SettingsApp.vue   # 设置窗口入口
│   └── main.ts           # 基于窗口标签的路由
├── src-tauri/            # Rust 后端
│   ├── src/              # 配置、快捷键、覆盖层、win32、命令…
│   ├── icons/            # 生成的图标集
│   └── tauri.conf.json
├── assets/               # 字体、图标源
└── scripts/              # gen-icon.mjs
```

---

## ⚙️ 配置

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
    "lineWidths": { "stroke": 3, "highlighter": 10, "eraser": 12 },
    "defaultTool": "pen",
    "defaultColor": "#6C8CFF",
    "boardDefault": "white",
    "openSettingsOnStartup": true,
    "exportDir": null
  }
}
```

---

## 🧭 设计

**Ethereal Glass（空灵玻璃）** —— 延续自 Aki 设计体系的设计语言：毛玻璃表面配双重包边、弹簧缓动（`cubic-bezier(0.32,0.72,0,1)`）、层叠柔影，以及 Plus Jakarta Sans / Fraunces / IBM Plex Mono 字体组合。

---

## 📄 开源协议

[MIT](LICENSE) 许可 © AkiroMusic

---

## 🙏 致谢

- [Tauri](https://tauri.app/) — 让约 4MB 大小的标注工具成为可能的框架
- [markeron](https://github.com/) — 覆盖层架构的灵感来源（在 `reference-markeron-master/` 中保留作为参考）

---

*AkiroMusic 用 💙 打造 —— 内测版 v0.2.0*
