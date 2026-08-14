<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  nextTick,
} from "vue";
import { invoke } from "@tauri-apps/api/core";
import ToolToolbar from "./ToolToolbar.vue";
import { useDrawing } from "../composables/useDrawing";
import { COLOR_PALETTE } from "../constants/colors";
import { useI18n } from "../i18n";
import type { AppConfig } from "../configTypes";
import type { Point, Tool } from "../composables/drawingTypes";

const { t } = useI18n();

// 画布引用
const historyCanvas = ref<HTMLCanvasElement | null>(null);
const previewCanvas = ref<HTMLCanvasElement | null>(null);

// 工具栏/状态
const showToolbar = ref(false);
const isPenetrating = ref(false);
const toast = ref<{ text: string; ts: number } | null>(null);

// 文字工具：待提交的输入框（x/y 为屏幕 client 坐标；anchor 为打开时的缩放锚点）
const textEditing = ref<{
  x: number;
  y: number;
  value: string;
  anchor: Point | null;
} | null>(null);
const textInputRef = ref<HTMLInputElement | null>(null);

// 聚光灯模式
const spotlight = ref(false);

// 放大镜模式（ZoomIt 式）：0 = 关闭 / 2 / 4（缩放倍率）
const magnifier = ref(0);
const magnifierBg = ref("");
const viewport = reactive({ w: window.innerWidth, h: window.innerHeight });

// 黑白板模式：无 / 白板 / 黑板（纯色底，导出时免截屏）
const boardMode = ref<"none" | "white" | "black">("none");

// 屏幕缩放（冻结缩放，ZoomIt Ctrl+1 式）：0 = 关闭 / 2 / 4 / 6 / 8
const zoom = ref(0);
const zoomBg = ref("");
/** 本次笔画按下时刻的光标位置：捕获空间逆映射基准（笔画中途不随鼠标移动） */
const zoomAnchor = ref<Point | null>(null);

// 光标位置（SVG 光标）
const cursorPos = ref({ x: 0, y: 0 });
const cursorVisible = ref(false);

/**
 * 光标渲染偏移：让 SVG 中"起作用的位置"对准鼠标。
 * - pen：笔尖在 viewBox 左下角 (约 3.5, 20.5) → 左移 3.5px、上移 20.5px
 * - highlighter / line / rect / circle / arrow / text：图形居中 → 左移/上移 12px
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
};
/** 橡皮实际擦除直径（CSS px）= 基础线宽 × WIDTH_SCALE.eraser */
const eraserGuideSize = computed(() => drawing.lineWidth.value);
function cursorTransform(): string {
  const tool = drawing.currentTool.value;
  if (tool === "eraser" || tool === "blur") {
    // 橡皮/马赛克：以鼠标为圆心的圆形引导，直径 = 实际作用宽度
    const s = eraserGuideSize.value;
    return `translate(${cursorPos.value.x}px, ${cursorPos.value.y}px) translate(${-s / 2}px, ${-s / 2}px)`;
  }
  const [dx, dy] = CURSOR_OFFSET[tool] ?? [-12, -12];
  return `translate(${cursorPos.value.x}px, ${cursorPos.value.y}px) translate(${dx}px, ${dy}px)`;
}

/** 缩放逆映射：把屏幕坐标（client）映射回捕获空间坐标；未缩放/无锚点时恒等 */
function mapToCapture(p: Point, anchor: Point | null): Point {
  const z = zoom.value;
  if (z <= 0 || !anchor) return p;
  return {
    x: anchor.x + (p.x - anchor.x) / z,
    y: anchor.y + (p.y - anchor.y) / z,
    pressure: p.pressure,
  };
}
const coordMapper = (p: Point): Point => mapToCapture(p, zoomAnchor.value);

const drawing = useDrawing(
  {
    history: historyCanvas,
    preview: previewCanvas,
  },
  () => window.devicePixelRatio,
  {},
  { coordMapper },
);

/** 应用 config 中的默认工具/颜色/线宽（启动时与 config 变更时） */
let applyingConfig = false;
let prefsSaveTimer: number | null = null;
let prefsSaveInFlight = false;

function applyConfig(cfg: AppConfig) {
  applyingConfig = true;
  drawing.currentTool.value = cfg.general.defaultTool;
  drawing.currentColor.value = cfg.general.defaultColor;
  drawing.lineWidths.value = {
    stroke: cfg.general.lineWidths.stroke,
    highlighter: cfg.general.lineWidths.highlighter,
    eraser: cfg.general.lineWidths.eraser,
  };
  // watcher 是微任务，等它跑完再复位，避免把"应用配置"误判为用户改动触发回存
  setTimeout(() => {
    applyingConfig = false;
  }, 0);
}

/** 绘制预设防抖保存：用户改工具/颜色/线宽后 500ms 内无新改动才落盘 */
function schedulePrefsSave() {
  if (prefsSaveTimer) window.clearTimeout(prefsSaveTimer);
  prefsSaveTimer = window.setTimeout(() => {
    prefsSaveTimer = null;
    void persistDrawingPrefs();
  }, 500);
}

/** 立即保存当前绘制预设（退出标注时兜底） */
function flushPrefsSave() {
  if (prefsSaveTimer) {
    window.clearTimeout(prefsSaveTimer);
    prefsSaveTimer = null;
  }
  void persistDrawingPrefs();
}

async function persistDrawingPrefs() {
  if (prefsSaveInFlight) return;
  prefsSaveInFlight = true;
  try {
    await invoke("save_drawing_prefs", {
      tool: drawing.currentTool.value,
      color: drawing.currentColor.value,
      lineWidths: {
        stroke: drawing.lineWidths.value.stroke,
        highlighter: drawing.lineWidths.value.highlighter,
        eraser: drawing.lineWidths.value.eraser,
      },
    });
  } catch {
    /* 非 Tauri 环境忽略 */
  } finally {
    prefsSaveInFlight = false;
  }
}

let pointerDown = false;
let rmbErasing = false;
let toastTimer: number | null = null;
let exportInFlight = false;
// 导出/放大镜截屏期间锁定输入：防止键盘/指针事件篡改 history，导致导出图与所见不一致
let uiLocked = false;
let clearListener: (() => void) | null = null;
let modeListener: (() => void) | null = null;
let configListener: (() => void) | null = null;

// ---- 画布尺寸（全屏铺满 overlay）----
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
  cursorVisible.value = true;

  // 放大镜模式下：只跟随光标缩放（不绘制、不平移）
  if (magnifier.value > 0) {
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

  // 右键 = 按住擦除
  if (e.button === 2) {
    rmbErasing = true;
    drawing.currentTool.value = "eraser";
    drawing.startDraw(e);
    return;
  }
  pointerDown = true;
  drawing.startDraw(e);
}

function onPointerMove(e: PointerEvent) {
  cursorPos.value = { x: e.clientX, y: e.clientY };
  if (pointerDown || rmbErasing) {
    drawing.drawTo(e);
  }
}

function onPointerUp(_e: PointerEvent) {
  if (pointerDown || rmbErasing) {
    drawing.endDraw();
  }
  pointerDown = false;
  rmbErasing = false;
}

function onPointerLeave() {
  cursorVisible.value = false;
}

// ---- 文字工具输入框 ----
/** 打开时间戳：用于区分"焦点竞态 blur"与"用户离开 blur" */
let textOpenedAt = 0;

function openTextEditor(e: PointerEvent) {
  const x = e.clientX;
  const y = e.clientY;
  textOpenedAt = Date.now();
  // 记录屏幕坐标（输入框固定定位直接用）+ 缩放锚点（落笔时逆变换回捕获空间）
  textEditing.value = { x, y, value: "", anchor: { x, y } };
  focusTextInput();
}

/** 聚焦输入框：nextTick 优先，失败则 setTimeout 兜底（WebView2 焦点竞态） */
function focusTextInput() {
  nextTick(() => {
    const el = textInputRef.value;
    if (!el) return;
    el.focus();
    // 首次聚焦可能被 pointerdown 的默认行为抢走，200ms 内重试
    setTimeout(() => {
      if (textEditing.value && document.activeElement !== textInputRef.value) {
        textInputRef.value?.focus();
      }
    }, 200);
  });
}

/** 输入框失焦：打开后 200ms 内的 blur 视为焦点竞态，不自动提交 */
function onTextBlur() {
  if (Date.now() - textOpenedAt < 200) {
    focusTextInput();
    return;
  }
  commitText();
}

/** 提交文字：落笔并关闭输入框（Esc/失焦取消） */
function commitText(cancel = false) {
  const ed = textEditing.value;
  if (!ed) return;
  textEditing.value = null;
  if (!cancel && ed.value.trim()) {
    // 缩放模式下把屏幕坐标逆变换回捕获空间再落笔
    drawing.startText(mapToCapture({ x: ed.x, y: ed.y }, ed.anchor), ed.value);
  }
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

// ---- 快捷键 ----
function onKeyDown(e: KeyboardEvent) {
  // 截屏导出期间锁定快捷键
  if (uiLocked) return;
  const k = e.key;
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

  switch (k) {
    case "1":
      selectTool("pen");
      break;
    case "2":
      selectTool("highlighter");
      break;
    case "3":
      selectTool("eraser");
      break;
    case "4":
      selectTool("line");
      break;
    case "5":
      selectTool("rect");
      break;
    case "6":
      selectTool("circle");
      break;
    case "7":
      selectTool("arrow");
      break;
    case "8":
      selectTool("text");
      break;
    case "9":
      selectTool("fading");
      break;
    case "0":
      selectTool("blur");
      break;
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
      e.preventDefault();
      showToolbar.value = !showToolbar.value;
      break;
    case "x":
    case "X":
      togglePenetration();
      break;
    case "f":
    case "F":
      toggleSpotlight();
      break;
    case "m":
    case "M":
      void toggleMagnifier();
      break;
    case "z":
    case "Z":
      if (meta) {
        drawing.undo();
        showToast(t("action.undo"));
      } else {
        void toggleZoom();
      }
      break;
    case "s":
    case "S":
      if (!meta) void exportScreenshot();
      break;
    case "c":
    case "C":
      if (meta) {
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
      // 放大镜/缩放优先退出各自的模式，其次退出标注
      if (magnifier.value > 0) {
        toggleMagnifier();
      } else if (zoom.value > 0) {
        void toggleZoom();
      } else {
        exitDrawing();
      }
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
  updateCursorIcon();
}

function cycleColor(dir: 1 | -1) {
  const i = COLOR_PALETTE.indexOf(drawing.currentColor.value);
  const next = (i + dir + COLOR_PALETTE.length) % COLOR_PALETTE.length;
  drawing.currentColor.value = COLOR_PALETTE[next];
}

function showToast(text: string) {
  toast.value = { text, ts: Date.now() };
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.value = null;
  }, 1600);
}

// ---- 穿透 / 退出 ----
async function togglePenetration() {
  isPenetrating.value = !isPenetrating.value;
  if (isPenetrating.value) {
    await invoke("enter_penetration_mode");
  } else {
    await invoke("exit_penetration_mode");
  }
  showToolbar.value = false;
}

// ---- 聚光灯 ----
function toggleSpotlight() {
  spotlight.value = !spotlight.value;
  if (spotlight.value) {
    showToast(t("action.spotlight"));
  }
}

// ---- 放大镜（ZoomIt 式：截屏底图 + CSS 缩放跟随光标）----
async function toggleMagnifier() {
  if (magnifier.value === 0) {
    // 与屏幕缩放互斥：开启放大镜时先退出缩放
    if (zoom.value > 0) zoom.value = 0;
    // 开启：临时隐藏 UI 并截取屏幕底图
    const prevToolbar = showToolbar.value;
    const prevSpotlight = spotlight.value;
    showToolbar.value = false;
    spotlight.value = false;
    textEditing.value = null;

    uiLocked = true;
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    try {
      const base64 = await invoke<string>("capture_screen");
      magnifierBg.value = `data:image/png;base64,${base64}`;
      magnifier.value = 2;
    } catch (err) {
      console.error("magnifier capture failed", err);
      showToast(t("action.exportFailed"));
    } finally {
      uiLocked = false;
      showToolbar.value = prevToolbar;
      spotlight.value = prevSpotlight;
    }
  } else {
    magnifier.value = magnifier.value === 2 ? 4 : 0;
  }
}

// ---- 屏幕缩放（冻结缩放：截屏底图 + CSS scale 跟随光标，可绘制）----
async function toggleZoom() {
  if (zoom.value === 0) {
    // 与放大镜互斥：开启缩放时先退出放大镜
    if (magnifier.value > 0) magnifier.value = 0;
    const prevToolbar = showToolbar.value;
    const prevSpotlight = spotlight.value;
    showToolbar.value = false;
    spotlight.value = false;
    textEditing.value = null;

    uiLocked = true;
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    try {
      const base64 = await invoke<string>("capture_screen");
      zoomBg.value = `data:image/png;base64,${base64}`;
      zoom.value = 2;
      showToast(t("action.zoom"));
    } catch (err) {
      console.error("zoom capture failed", err);
      showToast(t("action.exportFailed"));
    } finally {
      uiLocked = false;
      showToolbar.value = prevToolbar;
      spotlight.value = prevSpotlight;
    }
  } else {
    zoom.value = 0;
  }
}

/** 滚轮调节缩放倍率（2 / 4 / 6 / 8，带 transition 顺滑切换） */
function onWheel(e: WheelEvent) {
  if (zoom.value <= 0) return;
  e.preventDefault();
  const levels = [2, 4, 6, 8];
  const idx = levels.indexOf(zoom.value);
  const next =
    e.deltaY < 0
      ? levels[Math.min(levels.length - 1, idx + 1)]
      : levels[Math.max(0, idx - 1)];
  if (next !== zoom.value) zoom.value = next;
}

// ---- 马赛克笔底图 ----
let blurCaptureInFlight = false;

/** 确保马赛克底图就绪：复用放大镜截屏流程（临时隐藏 UI → capture_screen → decode） */
async function ensureBlurBase() {
  if (drawing.hasBlurBase() || blurCaptureInFlight) return;
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
  } catch (err) {
    console.error("blur base capture failed", err);
    showToast(t("action.exportFailed"));
  } finally {
    uiLocked = false;
    showToolbar.value = prevToolbar;
    spotlight.value = prevSpotlight;
    textEditing.value = prevText;
    blurCaptureInFlight = false;
  }
}

// ---- 黑白板模式 ----
function cycleBoard() {
  const next =
    boardMode.value === "none"
      ? "white"
      : boardMode.value === "white"
        ? "black"
        : "none";
  boardMode.value = next;
  if (next !== "none") {
    showToast(t(next === "white" ? "action.boardWhite" : "action.boardBlack"));
  }
}

// ---- 导出截图 ----
async function exportScreenshot() {
  if (exportInFlight) return;
  exportInFlight = true;
  uiLocked = true;
  showToast(t("action.exporting"));
  try {
    const isBoard = boardMode.value !== "none";
    const scale = window.devicePixelRatio;
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
      ctx.fillStyle = boardMode.value === "white" ? "#ffffff" : "#000000";
      ctx.fillRect(0, 0, composite.width, composite.height);
    } else {
      // 1. 临时隐藏 UI（工具栏/光标/聚光灯/放大镜/文字框）并请后端截取屏幕底图
      const prevToolbar = showToolbar.value;
      const prevSpotlight = spotlight.value;
      const prevMagnifier = magnifier.value;
      showToolbar.value = false;
      spotlight.value = false;
      magnifier.value = 0;
      textEditing.value = null;

      // 等一帧让 DOM 隐藏生效
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      const base64 = await invoke<string>("capture_screen");

      // 2. 恢复 UI
      showToolbar.value = prevToolbar;
      spotlight.value = prevSpotlight;
      magnifier.value = prevMagnifier;

      // 3. 合成：底图 + 已提交笔画
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

    // 4. 交给后端保存到图片目录
    const png = composite.toDataURL("image/png").split(",")[1];
    const savedPath = await invoke<string>("save_export", { pngBase64: png });
    showToast(`${t("action.exported")} ${savedPath.split(/[\\/]/).pop()}`);
  } catch (err) {
    console.error("export failed", err);
    showToast(t("action.exportFailed"));
  } finally {
    uiLocked = false;
    exportInFlight = false;
  }
}

async function exitDrawing() {
  await invoke("exit_drawing");
}

/** 复位叠加态（黑白板 / 缩放），随清屏与模式切换一起重置 */
function resetOverlayState() {
  boardMode.value = "none";
  zoom.value = 0;
  zoomAnchor.value = null;
}

// ---- 事件监听（Rust → 前端）----
async function setupListeners() {
  const { listen } = await import("@tauri-apps/api/event");

  clearListener = await listen<boolean>("clear-drawing", () => {
    drawing.hardReset();
    resetOverlayState();
  });

  configListener = await listen<AppConfig>("config-changed", (e) => {
    applyConfig(e.payload);
  });

  modeListener = await listen<string>("overlay-mode-changed", (e) => {
    const mode = e.payload;
    if (mode === "drawing-return") {
      // 从穿透切回绘制：保留已有笔迹，只恢复交互
      cursorVisible.value = true;
      showToolbar.value = true;
      isPenetrating.value = false;
    } else if (mode === "drawing") {
      // 正常激活：重置画布尺寸 & 清空（MVP：每次进入默认清空）
      requestAnimationFrame(() => {
        resizeCanvases();
        drawing.hardReset();
        resetOverlayState();
        cursorVisible.value = true;
        showToolbar.value = true;
        isPenetrating.value = false;
      });
    } else if (mode === "penetration") {
      isPenetrating.value = true;
      showToolbar.value = false;
    } else if (mode === "hidden") {
      cursorVisible.value = false;
      showToolbar.value = false;
      isPenetrating.value = false;
      drawing.hardReset();
      resetOverlayState();
      // 退出标注时兜底落盘绘制预设
      flushPrefsSave();
    }
  });
}

// ---- SVG 光标（随工具变化）----
function updateCursorIcon() {
  // 样式由 CSS 处理，这里只保证重渲染
  cursorVisible.value = true;
}

// ---- 生命周期 ----
onMounted(async () => {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", resizeCanvases);
  // 滚轮调缩放倍率：Vue 模板对 wheel 默认 passive，preventDefault 需手动非 passive 监听
  window.addEventListener("wheel", onWheel, { passive: false });
  await setupListeners();

  // 加载 config 应用默认工具/颜色/线宽
  try {
    const cfg = await invoke<AppConfig>("get_config");
    applyConfig(cfg);
  } catch {
    /* 非 Tauri 环境忽略 */
  }

  // 若窗口已可见（例如启动即进入标注），立即初始化
  requestAnimationFrame(() => {
    resizeCanvases();
  });

  // 当前工具颜色变化 → 更新光标颜色
  watch(
    () => [drawing.currentTool.value, drawing.currentColor.value],
    () => {
      updateCursorIcon();
    },
  );

  // 工具/颜色/线宽变化 → 防抖保存绘制预设（下次启动沿用）
  watch([drawing.currentTool, drawing.currentColor, drawing.lineWidths], () => {
    if (applyingConfig) return;
    schedulePrefsSave();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("resize", resizeCanvases);
  window.removeEventListener("wheel", onWheel);
  clearListener?.();
  modeListener?.();
  configListener?.();
  drawing.destroy();
  // 清理防抖保存定时器并兜底落盘
  if (prefsSaveTimer) {
    window.clearTimeout(prefsSaveTimer);
    prefsSaveTimer = null;
  }
  void persistDrawingPrefs();
});
</script>

<template>
  <div
    ref="overlayRoot"
    class="overlay-root"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointerleave="onPointerLeave"
    @contextmenu.prevent
  >
    <!-- 黑白板模式：纯色全屏底（z 轴最底，位于画布之下） -->
    <div v-if="boardMode !== 'none'" class="board-layer" :class="boardMode" />

    <!-- 缩放 / 普通布局：wrapper 恒存在，zoom>0 时整体放大（截图底图 + 双画布同一变换，笔画与画面视觉对齐） -->
    <div
      class="zoom-layer"
      :style="
        zoom > 0
          ? {
              transform: `scale(${zoom})`,
              transformOrigin: `${cursorPos.x}px ${cursorPos.y}px`,
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
      :magnifier="magnifier > 0"
      :board="boardMode"
      :zoom="zoom > 0"
      @select-tool="selectTool"
      @select-color="(c: string) => (drawing.currentColor.value = c)"
      @update-width="
        (w: Record<string, number>) =>
          (drawing.lineWidths.value = { ...drawing.lineWidths.value, ...w })
      "
      @undo="drawing.undo()"
      @redo="drawing.redo()"
      @clear="drawing.clearAll()"
      @penetrate="togglePenetration"
      @export="exportScreenshot"
      @toggle-spotlight="toggleSpotlight"
      @toggle-magnifier="toggleMagnifier"
      @toggle-board="cycleBoard"
      @toggle-zoom="toggleZoom"
      @exit="exitDrawing"
    />

    <!-- 文字工具输入框 -->
    <input
      v-if="textEditing"
      ref="textInputRef"
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

    <!-- 聚光灯遮罩：光标处圆孔 -->
    <div
      v-if="spotlight"
      class="spotlight-mask"
      :style="{
        background: `radial-gradient(circle 160px at ${cursorPos.x}px ${cursorPos.y}px, transparent 0, transparent 130px, rgba(3, 5, 10, 0.72) 165px)`,
      }"
    />

    <!-- 放大镜：截屏底图 + CSS 缩放跟随光标 -->
    <div
      v-if="magnifier > 0 && magnifierBg"
      class="magnifier-layer"
      :style="{
        backgroundImage: `url(${magnifierBg})`,
        backgroundSize: `${viewport.w}px ${viewport.h}px`,
        transform: `scale(${magnifier})`,
        transformOrigin: `${cursorPos.x}px ${cursorPos.y}px`,
      }"
    />
    <!-- 放大镜/缩放聚焦环：提示当前放大中心 -->
    <div
      v-if="magnifier > 0 || zoom > 0"
      class="magnifier-ring"
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
          width: drawing.lineWidth.value + 'px',
          height: drawing.lineWidth.value + 'px',
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

/* ---- 放大镜 ---- */
.magnifier-layer {
  position: fixed;
  inset: 0;
  background-repeat: no-repeat;
  background-position: 0 0;
  pointer-events: none;
  z-index: 1;
  will-change: transform, transform-origin;
  transition:
    transform var(--duration-hover) var(--ease-default),
    transform-origin 0.05s linear;
}
.magnifier-ring {
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
