<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import ToolToolbar from "./ToolToolbar.vue";
import { useDrawing } from "../composables/useDrawing";
import { COLOR_PALETTE } from "../constants/colors";
import { useI18n } from "../i18n";
import type { AppConfig } from "../configTypes";

const { t } = useI18n();

// 画布引用
const historyCanvas = ref<HTMLCanvasElement | null>(null);
const previewCanvas = ref<HTMLCanvasElement | null>(null);

// 工具栏/状态
const showToolbar = ref(false);
const isPenetrating = ref(false);
const toast = ref<{ text: string; ts: number } | null>(null);

// 光标位置（SVG 光标）
const cursorPos = ref({ x: 0, y: 0 });
const cursorVisible = ref(false);

/**
 * 光标渲染偏移：让 SVG 中"起作用的位置"对准鼠标。
 * - pen：笔尖在 viewBox 左下角 (约 3.5, 20.5) → 左移 3.5px、上移 20.5px
 * - highlighter / eraser：图形居中 → 左移/上移 12px
 */
const CURSOR_OFFSET: Record<string, [number, number]> = {
  pen: [-3.5, -20.5],
  highlighter: [-12, -12],
  eraser: [-12, -12],
};
function cursorTransform(): string {
  const [dx, dy] = CURSOR_OFFSET[drawing.currentTool.value] ?? [-12, -12];
  return `translate(${cursorPos.value.x}px, ${cursorPos.value.y}px) translate(${dx}px, ${dy}px)`;
}

const drawing = useDrawing(
  {
    history: historyCanvas,
    preview: previewCanvas,
  },
  () => window.devicePixelRatio,
);

/** 应用 config 中的默认工具/颜色/线宽（启动时与 config 变更时） */
function applyConfig(cfg: AppConfig) {
  drawing.currentTool.value = cfg.general.defaultTool;
  drawing.currentColor.value = cfg.general.defaultColor;
  drawing.lineWidths.value = {
    stroke: cfg.general.lineWidths.stroke,
    highlighter: cfg.general.lineWidths.highlighter,
    eraser: cfg.general.lineWidths.eraser,
  };
}

let pointerDown = false;
let rmbErasing = false;
let toastTimer: number | null = null;
let clearListener: (() => void) | null = null;
let modeListener: (() => void) | null = null;
let configListener: (() => void) | null = null;

// ---- 画布尺寸（全屏铺满 overlay）----
function resizeCanvases() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  drawing.setupCanvases(w, h, window.devicePixelRatio);
}

// ---- 指针事件 ----
function onPointerDown(e: PointerEvent) {
  // 点击工具栏区域不画
  if (isOverToolbar(e)) return;
  cursorVisible.value = true;

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
  const k = e.key;
  const meta = e.ctrlKey || e.metaKey;

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
    case "q":
      cycleColor(-1);
      break;
    case "e":
      cycleColor(1);
      break;
    case " ":
      e.preventDefault();
      showToolbar.value = !showToolbar.value;
      break;
    case "x":
    case "X":
      togglePenetration();
      break;
    case "c":
    case "C":
      if (meta) {
        drawing.clearAll();
        showToast(t("action.clear"));
      }
      break;
    case "z":
    case "Z":
      if (meta) {
        drawing.undo();
        showToast(t("action.undo"));
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
      exitDrawing();
      break;
  }
}

function selectTool(tool: "pen" | "highlighter" | "eraser") {
  drawing.currentTool.value = tool;
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

async function exitDrawing() {
  await invoke("exit_drawing");
}

// ---- 事件监听（Rust → 前端）----
async function setupListeners() {
  const { listen } = await import("@tauri-apps/api/event");

  clearListener = await listen<boolean>("clear-drawing", () => {
    drawing.hardReset();
  });

  configListener = await listen<AppConfig>("config-changed", (e) => {
    applyConfig(e.payload);
  });

  modeListener = await listen<string>("overlay-mode-changed", (e) => {
    const mode = e.payload;
    if (mode === "drawing") {
      // 窗口刚显示，重置画布尺寸 & 清空（MVP：每次进入默认清空）
      requestAnimationFrame(() => {
        resizeCanvases();
        drawing.hardReset();
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
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("resize", resizeCanvases);
  clearListener?.();
  modeListener?.();
  configListener?.();
  drawing.destroy();
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
    <!-- 历史层：已提交笔画 -->
    <canvas ref="historyCanvas" class="layer-canvas" />
    <!-- 预览层：进行中笔画 -->
    <canvas ref="previewCanvas" class="layer-canvas" />

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
      @exit="exitDrawing"
    />

    <!-- 提示 Toast -->
    <Transition name="fade">
      <div v-if="toast" class="toast double-bezel" :key="toast.ts">
        <span class="toast-text">{{ toast.text }}</span>
      </div>
    </Transition>

    <!-- 自定义光标（隐藏系统光标） -->
    <div
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
        <!-- 笔尖 -->
        <template v-if="drawing.currentTool.value === 'pen'">
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
        <!-- 橡皮 -->
        <template v-else>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
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
