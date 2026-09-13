<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { invoke } from "@tauri-apps/api/core";
import ToolToolbar from "./ToolToolbar.vue";
import { useDrawing } from "../composables/useDrawing";
import { mapToCapture } from "../composables/zoomMapping";
import { useToast } from "../composables/useToast";
import { useTextEditor } from "../composables/useTextEditor";
import { usePrefsSync } from "../composables/usePrefsSync";
import { useOverlayModes } from "../composables/useOverlayModes";
import { COLOR_PALETTE } from "../constants/colors";
import {
  BOARD_COLORS,
  SPOTLIGHT,
  TOAST_EXPORT_MS,
  TOOL_DEFS,
} from "../constants/tools";
import { useI18n } from "../i18n";
import type { AppConfig } from "../configTypes";
import type { Point, Tool } from "../composables/drawingTypes";

const { t, setLocale } = useI18n();

/** 快捷键数字键 → 工具（由 TOOL_DEFS 派生，避免两处维护映射） */
const TOOL_HOTKEY_MAP: Record<string, Tool> = Object.fromEntries(
  TOOL_DEFS.map((def) => [def.hotkey, def.id]),
);

// ---- 画布与视口 ----
const historyCanvas = ref<HTMLCanvasElement | null>(null);
const fadingCanvas = ref<HTMLCanvasElement | null>(null);
const previewCanvas = ref<HTMLCanvasElement | null>(null);
const viewport = reactive({ w: window.innerWidth, h: window.innerHeight });

// ---- Toast / 横幅 ----
const { toast, showToast, dispose: disposeToast } = useToast();
/** 初始化失败横幅：listeners/config 加载失败时显示（否则用户看到"窗口弹出但画不了"却无解释） */
const initError = ref(false);

// ---- 工具栏位置（localStorage 记忆；不放 config 避免污染用户配置文件） ----
const TOOLBAR_POS_KEY = "akimark.toolbarPos";
const toolbarPos = ref<{ x: number; y: number } | null>(
  (() => {
    try {
      const raw = localStorage.getItem(TOOLBAR_POS_KEY);
      return raw ? (JSON.parse(raw) as { x: number; y: number }) : null;
    } catch {
      return null;
    }
  })(),
);
function onToolbarMoved(pos: { x: number; y: number }) {
  toolbarPos.value = pos;
  try {
    localStorage.setItem(TOOLBAR_POS_KEY, JSON.stringify(pos));
  } catch {
    // localStorage 不可用时静默降级为不记忆
  }
}

// ---- 光标 / 手势标志 ----
const cursorPos = ref({ x: 0, y: 0 });
const cursorVisible = ref(false);
/** 绘制手势进行中（pointerDown/rmbErasing 的响应式镜像）：缩放视觉原点据此锁定锚点 */
const strokeActive = ref(false);

// ---- 默认板书底色（配置项，prefsSync 写入 / modes 读取） ----
const boardDefault = ref<"white" | "black">("white");

/**
 * 缩放逆映射：把屏幕坐标（client）映射回捕获空间坐标（纯函数见 zoomMapping.ts）。
 * 闭包引用下方 modes 的 zoom/zoomAnchor —— 仅在指针事件时调用，届时已初始化。
 */
const coordMapper = (p: Point): Point =>
  mapToCapture(p, modes.zoomAnchor.value, modes.zoom.value);

const drawing = useDrawing(
  {
    history: historyCanvas,
    fading: fadingCanvas,
    preview: previewCanvas,
  },
  {},
  { coordMapper },
);

// ---- 文字工具输入框 ----
const {
  textEditing,
  setTextInputRef,
  openTextEditor,
  commitText,
  onTextBlur,
  dispose: disposeTextEditor,
} = useTextEditor({
  startText: (p, text) => drawing.startText(p, text),
  zoom: () => modes.zoom.value,
});

// ---- 绘制预设同步（config ⇄ 会话） ----
const {
  preserveDrawings,
  recentColors,
  applyConfig,
  applyConfigUpdate,
  schedulePrefsSave,
  flushPrefsSave,
  addRecentColor,
  isApplyingConfig,
  dispose: disposePrefs,
} = usePrefsSync({ drawing, boardDefault, setLocale });

// ---- 模式状态机（板书/缩放/聚光灯/穿透/工具栏，互斥规则见 modeMutex.ts） ----
// 导出/放大镜截屏期间锁定输入：防止键盘/指针事件篡改 history，导致导出图与所见不一致
let uiLocked = false;
const modes = useOverlayModes({
  drawing,
  showToast,
  t,
  uiLocked: {
    get: () => uiLocked,
    set: (v) => {
      uiLocked = v;
    },
  },
  textEditing,
  boardDefault,
  strokeActive,
  cursorPos,
});
const {
  showToolbar,
  isPenetrating,
  spotlight,
  spotlightRadius,
  boardMode,
  zoom,
  zoomBg,
  zoomAnchor,
  zoomOrigin,
  toggleZoom,
  toggleSpotlight,
  cycleBoard,
  togglePenetration,
  stepBack,
  exitAnnotation,
  toggleToolbarWithSpace,
  onWheel,
  resetModes,
  syncPenetrationFromBackend,
  dispose: disposeModes,
} = modes;

/**
 * 光标渲染偏移：让 SVG 中"起作用的位置"对准鼠标。
 * - pen/fading：笔尖在 viewBox 左下角（约 3.5, 20.5）→ 左移 3.5px、上移 20.5px
 * - 其余工具：图形居中 → 左移/上移 12px
 */
const CURSOR_OFFSET: Record<string, [number, number]> = {
  pen: [-3.5, -20.5],
  highlighter: [-12, -12],
  line: [-12, -12],
  rect: [-12, -12],
  circle: [-12, -12],
  arrow: [-12, -12],
  text: [-12, -12],
  fading: [-3.5, -20.5],
  blur: [-12, -12],
  counter: [-12, -12],
};
/** 模式切换类快捷键（见 onKeyDown 的 e.repeat 守卫）：板书/工具栏/穿透/聚光灯/缩放 */
const MODE_TOGGLE_KEYS = [
  "b",
  "B",
  " ",
  "x",
  "X",
  "f",
  "F",
  "m",
  "M",
  "z",
  "Z",
];
/** 橡皮实际擦除直径（CSS px）= 基础线宽 × WIDTH_SCALE.eraser */
const eraserGuideSize = computed(() => drawing.lineWidth.value);
/** 马赛克实际格子直径（CSS px）= 合成底图采样粒度，随线宽增长 */
const blurGuideSize = computed(() => drawing.blurCell.value);
function cursorTransform(): string {
  const tool = drawing.currentTool.value;
  if (tool === "eraser" || tool === "blur") {
    // 橡皮/马赛克：以鼠标为圆心的圆形引导，直径 = 实际作用宽度
    const s = tool === "blur" ? blurGuideSize.value : eraserGuideSize.value;
    return `translate(${cursorPos.value.x}px, ${cursorPos.value.y}px) translate(${-s / 2}px, ${-s / 2}px)`;
  }
  const [dx, dy] = CURSOR_OFFSET[tool] ?? [-12, -12];
  return `translate(${cursorPos.value.x}px, ${cursorPos.value.y}px) translate(${dx}px, ${dy}px)`;
}

// ---- 进行中标志 ----
let pointerDown = false;
let rmbErasing = false;
/** 右键按住擦除前的工具：松开右键后恢复 */
let prevToolBeforeRmb: Tool | null = null;
let exportInFlight = false;
let clearListener: (() => void) | null = null;
let modeListener: (() => void) | null = null;
let configListener: (() => void) | null = null;
let blockedListener: (() => void) | null = null;

// ---- 画布尺寸（全屏铺满 overlay） ----
function resizeCanvases() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  viewport.w = w;
  viewport.h = h;
  drawing.setupCanvases(w, h, window.devicePixelRatio);
}

// ---- 指针事件 ----
function onPointerDown(e: PointerEvent) {
  // 截屏导出期间锁定交互
  if (uiLocked) return;
  // 点击工具栏区域不画
  if (isOverToolbar(e)) return;
  // 已有手势进行中（左键绘制/右键擦除）时忽略新按键：startDraw 会覆盖
  // 唯一的 currentAction 槽位，进行中的笔画被静默丢弃（数位板手掌误触可触发）
  if (pointerDown || rmbErasing) return;
  cursorVisible.value = true;

  // 右键 = 按住擦除：优先于文字/马赛克分支处理（右键不应触发文字输入或底图截屏）
  if (e.button === 2) {
    rmbErasing = true;
    strokeActive.value = true;
    // 右键橡皮同样冻结缩放锚点（与逆映射同源），否则放大态下擦除位置偏移
    zoomAnchor.value = { x: e.clientX, y: e.clientY };
    prevToolBeforeRmb = drawing.currentTool.value;
    drawing.currentTool.value = "eraser";
    drawing.startDraw(e);
    capturePointer(e);
    return;
  }

  // 文字工具：点击位置弹出输入框（已有输入框则先提交上一处）
  if (drawing.currentTool.value === "text") {
    if (textEditing.value) commitText();
    openTextEditor(e);
    return;
  }

  // 其他工具点击画布：提交未完成的文字输入
  if (textEditing.value) commitText();

  // 马赛克笔：底图未就绪时先截屏，本次点击不画
  if (drawing.currentTool.value === "blur" && !drawing.hasBlurBase()) {
    void ensureBlurBase();
    return;
  }

  // 缩放模式下记录本次笔画的映射锚点（按下时刻光标位置，笔画中途固定）
  zoomAnchor.value = { x: e.clientX, y: e.clientY };

  pointerDown = true;
  strokeActive.value = true;
  drawing.startDraw(e);
  capturePointer(e);
}

/** 捕获指针：保证拖出窗口/松开在窗口外时仍能收到 pointerup 结束笔画 */
function capturePointer(e: PointerEvent) {
  const target = e.target as Element | null;
  if (!target || typeof target.setPointerCapture !== "function") return;
  try {
    target.setPointerCapture(e.pointerId);
  } catch {
    // 指针已释放等场景下 setPointerCapture 会抛错，忽略即可
  }
}

/** 结束一次指针交互的公共清理：结束笔画 + 恢复右键临时橡皮前的工具 + 复位标志 */
function endPointerInteraction() {
  if (pointerDown || rmbErasing) {
    drawing.endDraw();
  }
  // 右键临时橡皮：松开后恢复之前的工具（仅当当前仍是临时橡皮时，避免覆盖用户新选工具）
  if (
    rmbErasing &&
    prevToolBeforeRmb &&
    drawing.currentTool.value === "eraser"
  ) {
    drawing.currentTool.value = prevToolBeforeRmb;
  }
  prevToolBeforeRmb = null;
  pointerDown = false;
  rmbErasing = false;
  strokeActive.value = false;
}

function onPointerMove(e: PointerEvent) {
  cursorPos.value = { x: e.clientX, y: e.clientY };
  if (pointerDown || rmbErasing) {
    drawing.drawTo(e);
  }
}

function onPointerUp(_e: PointerEvent) {
  endPointerInteraction();
}

/** 指针被系统取消（触控中断、窗口失焦等）：与 pointerup 同等结束笔画 */
function onPointerCancel(_e: PointerEvent) {
  endPointerInteraction();
}

/** 窗口级兜底：指针捕获丢失时（如 WebView2 偶发丢捕获）确保笔画不悬挂 */
function onWindowPointerUp() {
  endPointerInteraction();
}

function onPointerLeave() {
  cursorVisible.value = false;
}

function isOverToolbar(e: PointerEvent): boolean {
  const el = document.querySelector("[data-toolbar]");
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return (
    e.clientX >= r.left &&
    e.clientX <= r.right &&
    e.clientY >= r.top &&
    e.clientY <= r.bottom
  );
}

// ---- 快捷键（模式类动作转发给 useOverlayModes，互斥规则集中在 modeMutex.ts） ----
function onKeyDown(e: KeyboardEvent) {
  // 截屏导出期间锁定快捷键
  if (uiLocked) return;
  // 空格键兼容：标准环境 key 为 " "，个别环境为 "Space"（IME 组合期间为 "Process"，由 isComposing 拦截）
  const k = e.key === " " || e.code === "Space" ? " " : e.key;
  const meta = e.ctrlKey || e.metaKey;

  // 文字输入框激活时：Enter 提交、Esc 取消，其余键不拦截
  if (textEditing.value) {
    if (k === "Enter") {
      commitText();
    } else if (k === "Escape") {
      commitText(true);
    }
    return;
  }

  // 模式切换类快捷键（板书/工具栏/穿透/聚光灯/缩放）带副作用（invoke/截屏/状态翻转），
  // 按住不放的 OS 自动重复会反复触发，统一忽略 repeat 事件。
  // meta 组合（Ctrl+Z/Y/C/D）除外：按住连续撤销/重做是合法操作。
  if (e.repeat && !meta && MODE_TOGGLE_KEYS.includes(k)) {
    return;
  }
  switch (k) {
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
    case "6":
    case "7":
    case "8":
    case "9":
    case "0": {
      // 数字键 → 工具：由 TOOL_DEFS 派生，避免硬编码映射漂移
      const tool = TOOL_HOTKEY_MAP[k];
      if (tool) selectTool(tool);
      break;
    }
    case "q":
      cycleColor(-1);
      break;
    case "e":
      cycleColor(1);
      break;
    case "b":
    case "B":
      cycleBoard();
      break;
    case " ":
      // 组合输入（IME）期间不拦截空格
      if (e.isComposing) break;
      e.preventDefault();
      toggleToolbarWithSpace();
      break;
    case "x":
    case "X":
      void togglePenetration();
      break;
    case "f":
    case "F":
      toggleSpotlight();
      break;
    case "m":
    case "M":
      // 放大镜已并入屏幕缩放：M/Z 同键开关
      toggleZoom();
      break;
    case "z":
    case "Z":
      if (meta) {
        drawing.undo();
        showToast(t("action.undo"));
      } else {
        toggleZoom();
      }
      break;
    case "s":
    case "S":
      if (!meta) void exportScreenshot();
      break;
    case "c":
    case "C":
      // Ctrl+C = 复制标注（与全系统"复制"心智一致；清屏改 Ctrl+D）。
      // 忽略 repeat：按住会反复触发"隐藏 UI → 截屏 → 写剪贴板"
      if (meta && !e.repeat) void copyAnnotation();
      break;
    case "d":
    case "D":
      // Ctrl+D = 清屏（原 Ctrl+C，让位给复制）
      if (meta && !e.repeat) {
        drawing.clearAll();
        showToast(t("action.clear"));
      }
      break;
    case "y":
    case "Y":
      if (meta) {
        drawing.redo();
        showToast(t("action.redo"));
      }
      break;
    case "Escape":
      // 逐级退出：缩放 → 聚光灯 → 板书 → 标注模式（由最"浅"的叠加态开始）
      stepBack();
      break;
  }
}

function selectTool(tool: Tool) {
  drawing.currentTool.value = tool;
  // 切到文字工具时收起未提交的输入框
  if (tool !== "text" && textEditing.value) {
    commitText(true);
  }
  // 马赛克笔：确保底图已就绪（未就绪则截屏一次）
  if (tool === "blur") {
    void ensureBlurBase();
  }
}

function cycleColor(dir: 1 | -1) {
  const i = COLOR_PALETTE.indexOf(drawing.currentColor.value);
  const next = (i + dir + COLOR_PALETTE.length) % COLOR_PALETTE.length;
  drawing.currentColor.value = COLOR_PALETTE[next];
}

// ---- 马赛克笔底图 ----
let blurCaptureInFlight = false;

/** 确保马赛克底图就绪：临时隐藏 UI → capture_screen → decode；黑板模式用板书纯色底 */
async function ensureBlurBase() {
  if (drawing.hasBlurBase() || blurCaptureInFlight) return;
  // 黑板模式：不截屏，直接以板书纯色做马赛克底，避免马赛克暴露屏幕内容
  if (boardMode.value !== "none") {
    drawing.setBlurBaseColor(
      boardMode.value === "white" ? BOARD_COLORS.white : BOARD_COLORS.black,
    );
    return;
  }
  blurCaptureInFlight = true;
  const prevToolbar = showToolbar.value;
  const prevSpotlight = spotlight.value;
  const prevText = textEditing.value;
  showToolbar.value = false;
  spotlight.value = false;
  textEditing.value = null;

  uiLocked = true;
  await new Promise((r) => requestAnimationFrame(() => r(null)));

  try {
    const base64 = await invoke<string>("capture_screen");
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await img.decode();
    drawing.setBlurBase(img);
    // 成功提示：首次点击只截屏不落笔，若无提示用户会以为"点了没反应"
    showToast(t("action.blurReady"));
  } catch (err) {
    console.warn("[akimark] ensure_blur_base capture_screen failed", err);
    showToast(t("action.captureFailed"));
  } finally {
    uiLocked = false;
    showToolbar.value = prevToolbar;
    spotlight.value = prevSpotlight;
    textEditing.value = prevText;
    blurCaptureInFlight = false;
  }
}

// ---- 导出截图 / 复制到剪贴板 ----
async function exportScreenshot() {
  if (exportInFlight) return;
  exportInFlight = true;
  uiLocked = true;
  showToast(t("action.exporting"));
  try {
    const composite = await composeExportCanvas();
    // 交给后端保存到图片目录；提示完整保存路径（完整路径需更久展示）
    const png = composite.toDataURL("image/png").split(",")[1];
    const savedPath = await invoke<string>("save_export", { pngBase64: png });
    showToast(`${t("action.exported")} ${savedPath}`, TOAST_EXPORT_MS);
  } catch (err) {
    console.warn("[akimark] export_screenshot failed", err);
    showToast(t("action.exportFailed"));
  } finally {
    uiLocked = false;
    exportInFlight = false;
  }
}

/** 复制标注到剪贴板（PNG）：Ctrl+C 或工具栏复制按钮，复用导出合成管线 */
async function copyAnnotation() {
  if (exportInFlight) return;
  exportInFlight = true;
  uiLocked = true;
  try {
    const composite = await composeExportCanvas();
    const png = composite.toDataURL("image/png").split(",")[1];
    await invoke("copy_png_to_clipboard", { pngBase64: png });
    showToast(t("action.copied"));
  } catch (err) {
    console.warn("[akimark] copy_annotation failed", err);
    showToast(t("action.copyFailed"));
  } finally {
    uiLocked = false;
    exportInFlight = false;
  }
}

/**
 * 合成"底图 + 已提交标注"为导出画布（导出保存与剪贴板复制共用）。
 * 内部临时隐藏 UI（工具栏/聚光灯/文字框）再请求后端截屏，结束必恢复。
 */
async function composeExportCanvas(): Promise<HTMLCanvasElement> {
  // 临时隐藏的 UI 状态：无论成功失败都要恢复（finally 兜底，避免截屏失败后工具栏/聚光灯/文字框永久消失）
  const prevToolbar = showToolbar.value;
  const prevSpotlight = spotlight.value;
  const prevText = textEditing.value;
  try {
    const isBoard = boardMode.value !== "none";
    // 导出位图同样受 MAX_CANVAS_PIXELS 约束：8K 屏按 devicePixelRatio 直乘
    // 会同时创建 3 份全屏 canvas + base64，内存峰值无界
    const maxExportScale = Math.sqrt(
      9_000_000 / Math.max(1, window.innerWidth * window.innerHeight),
    );
    const scale = Math.min(window.devicePixelRatio, maxExportScale);
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const composite = document.createElement("canvas");
    composite.width = Math.floor(cssW * scale);
    composite.height = Math.floor(cssH * scale);
    const ctx = composite.getContext("2d");
    if (!ctx) throw new Error("no 2d context");

    let baseImg: HTMLImageElement | null = null;
    if (isBoard) {
      // 黑白板模式：底图直接用纯色填充，跳过截屏（省去窗口隐藏/恢复的闪烁）
      ctx.fillStyle =
        boardMode.value === "white" ? BOARD_COLORS.white : BOARD_COLORS.black;
      ctx.fillRect(0, 0, composite.width, composite.height);
    } else {
      // 1. 临时隐藏 UI（工具栏/光标/聚光灯/文字框）并请后端截取屏幕底图
      showToolbar.value = false;
      spotlight.value = false;
      textEditing.value = null;

      // 等一帧让 DOM 隐藏生效
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      const base64 = await invoke<string>("capture_screen");

      // 2. 合成：底图 + 已提交笔画
      const img = new Image();
      img.src = `data:image/png;base64,${base64}`;
      await img.decode();
      baseImg = img;
      ctx.drawImage(img, 0, 0, composite.width, composite.height);
    }

    // 笔画先画到独立透明层：橡皮用 destination-out 擦透明层只会擦掉笔画，
    // 直接画到底图上会打穿底图像素（导出 PNG 出现透明洞）。
    const drawLayer = document.createElement("canvas");
    drawLayer.width = composite.width;
    drawLayer.height = composite.height;
    // base 传入导出用新截屏，保证马赛克导出时用最新画面
    drawing.renderTo(drawLayer, cssW, cssH, scale, baseImg);
    ctx.drawImage(drawLayer, 0, 0);
    return composite;
  } finally {
    // 恢复 UI（无论成功失败）
    showToolbar.value = prevToolbar;
    spotlight.value = prevSpotlight;
    textEditing.value = prevText;
  }
}

// ---- 事件监听（Rust → 前端） ----
async function setupListeners() {
  const { listen } = await import("@tauri-apps/api/event");

  clearListener = await listen<boolean>("clear-drawing", () => {
    drawing.hardReset();
    resetModes();
  });

  // 板书期间穿透被后端拒绝（全局热键/失焦自动穿透路径）→ 弹提示
  blockedListener = await listen("penetration-blocked", () => {
    showToast(t("action.penetrateInBoard"));
  });

  configListener = await listen<AppConfig>("config-changed", (e) => {
    // 只应用非会话状态字段：工具/颜色/线宽是本窗口的会话状态，
    // 被广播回滚会覆盖用户在防抖保存窗口内的最新选择（见 usePrefsSync）
    applyConfigUpdate(e.payload);
  });

  modeListener = await listen<string>("overlay-mode-changed", (e) => {
    const mode = e.payload;
    if (mode === "drawing-return") {
      // 从穿透切回绘制：保留已有笔迹，只恢复交互（画布尺寸可能已变，同步重设）
      cursorVisible.value = true;
      showToolbar.value = true;
      isPenetrating.value = false;
      resizeCanvases();
    } else if (mode === "drawing") {
      // 正常激活：重置画布尺寸；preserveDrawings 开启时保留已有笔迹
      requestAnimationFrame(() => {
        resizeCanvases();
        if (!preserveDrawings.value) {
          drawing.hardReset();
        }
        resetModes();
        // 新会话从干净状态开始：缩放/板书/聚光灯全部复位
        cursorVisible.value = true;
        showToolbar.value = true;
        isPenetrating.value = false;
      });
    } else if (mode === "penetration") {
      syncPenetrationFromBackend(true);
    } else if (mode === "hidden") {
      cursorVisible.value = false;
      showToolbar.value = false;
      isPenetrating.value = false;
      if (!preserveDrawings.value) {
        drawing.hardReset();
      }
      resetModes();
      // 退出标注时兜底落盘绘制预设
      flushPrefsSave();
    }
  });
}

// ---- 生命周期 ----
/** resize 防抖：DPI/显示器切换时 resize 连发，每次都会清空并全量重绘画布 */
let resizeTimer: number | null = null;
function onResizeDebounced() {
  if (resizeTimer) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    resizeCanvases();
  }, 80);
}

onMounted(async () => {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResizeDebounced);
  // 滚轮调缩放倍率/聚光灯半径：Vue 模板对 wheel 默认 passive，preventDefault 需手动非 passive 监听
  window.addEventListener("wheel", onWheel, { passive: false });
  // 指针捕获丢失兜底：窗口级 pointerup 确保笔画不悬挂
  window.addEventListener("pointerup", onWindowPointerUp);

  // 工具/颜色/线宽变化 → 防抖保存绘制预设（下次启动沿用）。
  // 必须在首个 await 之前注册：await 之后的代码运行在微任务续体里，
  // Vue 当前实例已复位，watcher 不会随组件卸载自动停止（HMR/重挂载时泄漏）。
  // 先注册 watcher 再加载 config：applyConfig 期间由守卫跳过回存
  watch([drawing.currentTool, drawing.currentColor, drawing.lineWidths], () => {
    if (isApplyingConfig()) return;
    // 右键临时橡皮：不把临时切换的工具写入预设（松开右键已自动恢复）
    if (rmbErasing) return;
    schedulePrefsSave();
  });

  try {
    await setupListeners();
  } catch (err) {
    console.warn("[akimark] setup_listeners failed", err);
    initError.value = true;
  }

  // 加载 config 应用默认工具/颜色/线宽
  try {
    const cfg = await invoke<AppConfig>("get_config");
    applyConfig(cfg);
  } catch (err) {
    console.warn("[akimark] get_config failed", err);
    initError.value = true;
  }

  // 若窗口已可见（例如启动即进入标注），立即初始化
  requestAnimationFrame(() => {
    resizeCanvases();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("resize", onResizeDebounced);
  window.removeEventListener("wheel", onWheel);
  window.removeEventListener("pointerup", onWindowPointerUp);
  clearListener?.();
  modeListener?.();
  configListener?.();
  blockedListener?.();
  drawing.destroy();
  // 各 composable 定时器/资源清理（toast/文字聚焦/防抖保存兜底落盘/缩放底图 Blob）
  disposeToast();
  disposeTextEditor();
  disposePrefs();
  disposeModes();
  if (resizeTimer) {
    window.clearTimeout(resizeTimer);
    resizeTimer = null;
  }
  blurCaptureInFlight = false;
  exportInFlight = false;
  uiLocked = false;
});
</script>

<template>
  <div
    class="overlay-root"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @pointerleave="onPointerLeave"
    @contextmenu.prevent
  >
    <!-- 初始化失败横幅：listeners/config 加载失败时显示（热键仍能弹窗但功能不可用，必须有可见解释） -->
    <div v-if="initError" class="init-error-banner">
      {{ t("error.initFailed") }}
    </div>

    <!-- 黑白板模式：纯色全屏底（z 轴最底，位于画布之下） -->
    <div v-if="boardMode !== 'none'" class="board-layer" :class="boardMode" />

    <!-- 缩放 / 普通布局：wrapper 恒存在，zoom>0 时整体放大（截图底图 + 双画布同一变换，笔画与画面视觉对齐）；
         视觉原点用 zoomOrigin：笔画进行中锁定为冻结锚点（与 mapToCapture 同源），空闲时跟随光标 -->
    <div
      class="zoom-layer"
      :style="
        zoom > 0
          ? {
              transform: `scale(${zoom})`,
              transformOrigin: `${zoomOrigin.x}px ${zoomOrigin.y}px`,
            }
          : undefined
      "
    >
      <!-- 缩放底图：冻结的屏幕截图（1:1 铺满，随 wrapper 放大） -->
      <div
        v-if="zoom > 0 && zoomBg"
        class="zoom-bg"
        :style="{
          backgroundImage: `url(${zoomBg})`,
          backgroundSize: `${viewport.w}px ${viewport.h}px`,
        }"
      />
      <!-- 历史层：已提交笔画 -->
      <canvas ref="historyCanvas" class="layer-canvas" />
      <!-- 渐隐层：渐隐笔画 + 橡皮擦除（独立层，渐隐动画只重绘本层） -->
      <canvas ref="fadingCanvas" class="layer-canvas" />
      <!-- 预览层：进行中笔画 -->
      <canvas ref="previewCanvas" class="layer-canvas" />
    </div>

    <!-- 浮动工具栏 -->
    <ToolToolbar
      v-if="showToolbar && !isPenetrating"
      :tool="drawing.currentTool.value"
      :color="drawing.currentColor.value"
      :line-width="drawing.lineWidths.value"
      :can-undo="drawing.canUndo.value"
      :can-redo="drawing.canRedo.value"
      :can-clear="drawing.canClear.value"
      :penetrating="isPenetrating"
      :spotlight="spotlight"
      :board="boardMode"
      :zoom="zoom > 0"
      :recent-colors="recentColors"
      :initial-position="toolbarPos"
      @select-tool="selectTool"
      @select-color="(c: string) => (drawing.currentColor.value = c)"
      @custom-color="addRecentColor"
      @toolbar-moved="onToolbarMoved"
      @update-width="
        (w: Record<string, number>) =>
          (drawing.lineWidths.value = { ...drawing.lineWidths.value, ...w })
      "
      @undo="drawing.undo()"
      @redo="drawing.redo()"
      @clear="drawing.clearAll()"
      @penetrate="togglePenetration"
      @export="exportScreenshot"
      @copy="copyAnnotation"
      @toggle-spotlight="toggleSpotlight"
      @toggle-board="cycleBoard"
      @toggle-zoom="toggleZoom"
      @exit="exitAnnotation"
    />

    <!-- 文字工具输入框 -->
    <input
      v-if="textEditing"
      :ref="setTextInputRef"
      v-model="textEditing.value"
      class="text-input"
      :style="{ left: textEditing.x + 'px', top: textEditing.y + 'px' }"
      :placeholder="t('action.textPlaceholder')"
      @pointerdown.stop
      @keydown.stop
      @keydown.enter.prevent="commitText()"
      @keydown.esc="commitText(true)"
      @blur="onTextBlur"
    />

    <!-- 聚光灯遮罩：光标处圆孔（半径可滚轮调节） -->
    <div
      v-if="spotlight"
      class="spotlight-mask"
      :style="{
        background: `radial-gradient(circle ${spotlightRadius}px at ${cursorPos.x}px ${cursorPos.y}px, transparent 0, transparent ${spotlightRadius - SPOTLIGHT.gradientInner}px, rgba(3, 5, 10, 0.72) ${spotlightRadius + SPOTLIGHT.gradientOuter}px)`,
      }"
    />

    <!-- 缩放聚焦环：提示当前放大中心 -->
    <div
      v-if="zoom > 0"
      class="zoom-ring"
      :style="{ left: cursorPos.x + 'px', top: cursorPos.y + 'px' }"
    />

    <!-- 提示 Toast -->
    <Transition name="fade">
      <div v-if="toast" class="toast double-bezel" :key="toast.ts">
        <span class="toast-text">{{ toast.text }}</span>
      </div>
    </Transition>

    <!-- 自定义光标（隐藏系统光标） -->
    <!-- 橡皮：虚线圆 = 实际擦除范围（直径随线宽变化），半透明填充便于定位 -->
    <div
      v-if="drawing.currentTool.value === 'eraser'"
      v-show="cursorVisible"
      class="custom-cursor eraser-cursor"
      :style="{ transform: cursorTransform() }"
    >
      <div
        class="eraser-guide"
        :style="{
          width: eraserGuideSize + 'px',
          height: eraserGuideSize + 'px',
        }"
      />
    </div>
    <!-- 马赛克笔：实线白圆 + 外黑描边 = 实际格子大小（与橡皮虚线区分） -->
    <div
      v-else-if="drawing.currentTool.value === 'blur'"
      v-show="cursorVisible"
      class="custom-cursor blur-cursor"
      :style="{ transform: cursorTransform() }"
    >
      <div
        class="blur-guide"
        :style="{
          width: blurGuideSize + 'px',
          height: blurGuideSize + 'px',
        }"
      />
    </div>
    <!-- 其他工具：SVG 图标光标 -->
    <div
      v-else
      v-show="cursorVisible"
      class="custom-cursor"
      :class="`cursor-${drawing.currentTool.value}`"
      :style="{
        transform: cursorTransform(),
        color: drawing.currentColor.value,
      }"
    >
      <svg
        viewBox="0 0 24 24"
        class="cursor-svg"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <!-- 笔尖（钢笔 / 渐隐笔共用） -->
        <template
          v-if="
            drawing.currentTool.value === 'pen' ||
            drawing.currentTool.value === 'fading'
          "
        >
          <!-- 斜 45° 的钢笔：笔尖朝左下，更像写字 -->
          <path d="M18.5 2.5 L21.5 5.5 L7.5 19.5 L3.5 20.5 L4.5 16.5 Z" />
          <path
            d="M15.5 5.5 L18.5 8.5 L7.5 19.5 L4.5 20.5 L5.5 17.5 Z"
            fill="currentColor"
            stroke="none"
            opacity="0.35"
          />
        </template>
        <!-- 荧光笔 -->
        <template v-else-if="drawing.currentTool.value === 'highlighter'">
          <path d="M4 14 L10 4 L18 12 L8 20 Z" />
        </template>
        <!-- 直线 -->
        <template v-else-if="drawing.currentTool.value === 'line'">
          <path d="M5 19 L19 5" />
        </template>
        <!-- 矩形 -->
        <template v-else-if="drawing.currentTool.value === 'rect'">
          <rect x="5" y="5" width="14" height="14" />
        </template>
        <!-- 圆形 -->
        <template v-else-if="drawing.currentTool.value === 'circle'">
          <circle cx="12" cy="12" r="8" />
        </template>
        <!-- 箭头：用圆点光标（避免与绘制出的箭头混淆） -->
        <template v-else-if="drawing.currentTool.value === 'arrow'">
          <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="6" opacity="0.4" />
        </template>
        <!-- 文字 -->
        <template v-else>
          <path d="M4 6 V3 H20 V6" />
          <path d="M12 3 V21 M9 21 H15" />
        </template>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.overlay-root {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  cursor: none;
  overflow: hidden;
  touch-action: none;
  z-index: var(--overlay-z);
}

.layer-canvas {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* ---- 黑白板模式：纯色全屏底（最底层） ---- */
.board-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}
.board-layer.white {
  background: #ffffff;
}
.board-layer.black {
  background: #000000;
}

/* ---- 缩放层：截屏底图 + 双画布同一 wrapper（zoom>0 时整体放大） ---- */
.zoom-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 1;
  will-change: transform, transform-origin;
  transition:
    transform var(--duration-hover) var(--ease-default),
    transform-origin 0.05s linear;
}
.zoom-bg {
  position: absolute;
  inset: 0;
  background-repeat: no-repeat;
  background-position: 0 0;
}

/* ---- 文字工具输入框 ---- */
.text-input {
  position: fixed;
  transform: translateY(-1px);
  min-width: 120px;
  padding: 2px 4px;
  border: 1.5px dashed var(--accent);
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--surface) 85%, transparent);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 28px;
  font-weight: 600;
  line-height: 1.25;
  outline: none;
  caret-color: var(--accent);
  z-index: var(--toolbar-z);
  box-shadow: var(--shadow-float);
}

/* ---- 聚光灯遮罩 ---- */
.spotlight-mask {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: calc(var(--toolbar-z) - 1);
}

/* ---- 缩放聚焦环 ---- */
.zoom-ring {
  position: fixed;
  width: 28px;
  height: 28px;
  margin: -14px 0 0 -14px;
  border: 1.5px solid rgba(255, 255, 255, 0.65);
  border-radius: var(--radius-full);
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.35),
    0 0 12px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  z-index: calc(var(--toolbar-z) - 1);
}

/* ---- 自定义光标 ---- */
.custom-cursor {
  position: fixed;
  top: 0;
  left: 0;
  width: 24px;
  height: 24px;
  pointer-events: none;
  z-index: var(--toolbar-z);
  filter: drop-shadow(0 1px 2px rgba(4, 6, 12, 0.6));
  will-change: transform;
}
.cursor-svg {
  width: 100%;
  height: 100%;
}

/* 橡皮光标：虚线圆 = 实际擦除范围 */
.eraser-cursor {
  width: 0;
  height: 0;
  filter: none;
}
.eraser-guide {
  position: absolute;
  top: 0;
  left: 0;
  border-radius: 50%;
  border: 2px dashed rgba(255, 255, 255, 0.92);
  background: rgba(255, 255, 255, 0.14);
  box-shadow:
    0 0 0 1px rgba(4, 6, 12, 0.45),
    inset 0 0 0 1px rgba(4, 6, 12, 0.25),
    0 0 10px rgba(4, 6, 12, 0.35);
  transition:
    width var(--duration-spring) var(--ease-spring),
    height var(--duration-spring) var(--ease-spring);
}

/* 马赛克笔光标：实线白圆 + 外黑描边（与橡皮虚线区分） */
.blur-cursor {
  width: 0;
  height: 0;
  filter: none;
}
.blur-guide {
  position: absolute;
  top: 0;
  left: 0;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.95);
  box-shadow:
    0 0 0 1.5px rgba(4, 6, 12, 0.85),
    0 0 10px rgba(4, 6, 12, 0.4);
}

/* ---- Toast ---- */
.toast {
  position: fixed;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--toast-z);
  padding: 8px 20px;
  border-radius: var(--radius-full);
  font-size: 12px;
  color: var(--text-secondary);
  pointer-events: none;
}

/* ---- 初始化失败横幅 ---- */
.init-error-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: var(--toast-z);
  padding: 10px 16px;
  text-align: center;
  font-size: 13px;
  color: #ffd9d9;
  background: rgba(140, 30, 30, 0.88);
  backdrop-filter: blur(8px);
  pointer-events: none;
}
.toast-text {
  position: relative;
  z-index: 1;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--duration-hover) var(--ease-default);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
