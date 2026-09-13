<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { TOOL_DEFS, TOOL_WIDTH_GROUP, WIDTH_MAX } from "../constants/tools";
import { COLOR_PALETTE } from "../constants/colors";
import { useI18n } from "../i18n";
import type { Tool } from "../composables/drawingTypes";

const { t } = useI18n();

const props = defineProps<{
  tool: Tool;
  color: string;
  lineWidth: { stroke: number; highlighter: number; eraser: number };
  canUndo: boolean;
  canRedo: boolean;
  canClear: boolean;
  penetrating: boolean;
  spotlight: boolean;
  board: "none" | "white" | "black";
  zoom: boolean;
  /** 最近使用的自定义颜色（取色器加入） */
  recentColors: string[];
  /** 上次记住的工具栏位置（localStorage）；null = 默认顶部居中 */
  initialPosition: { x: number; y: number } | null;
}>();

const emit = defineEmits<{
  selectTool: [tool: Tool];
  selectColor: [color: string];
  customColor: [color: string];
  updateWidth: [
    width: { stroke?: number; highlighter?: number; eraser?: number },
  ];
  toolbarMoved: [pos: { x: number; y: number }];
  undo: [];
  redo: [];
  clear: [];
  penetrate: [];
  export: [];
  copy: [];
  toggleSpotlight: [];
  toggleBoard: [];
  toggleZoom: [];
  exit: [];
}>();

// 工具图标（Feather 风格内联 SVG，24 viewBox / 1.7 stroke）
function toolIcon(tool: Tool) {
  switch (tool) {
    case "pen":
      return "M12 19 L19 5 L16 4 L4 15 Z M12 19 L5 19 Z";
    case "fading":
      // 渐隐笔：笔尖与钢笔一致，但尾部改为渐变小点（笔迹随时间溶解的意象）
      return "M12 19 L19 5 L16 4 L4 15 Z M12 19 L9 17 M8 14.5 L6.5 13.5 M5.5 11 L4.5 10.3";
    case "highlighter":
      return "M9 11 L18 2 L22 6 L13 15 Z M5 19 L9 15 M7 17 L3 21 Z";
    case "eraser":
      return "M7 21 L20 8 L16 4 L3 17 Z M7 21 L10 18 M14 14 L18 18";
    case "rect":
      return "M4 5 H20 V19 H4 Z";
    case "line":
      return "M5 19 L19 5";
    case "circle":
      return "M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3";
    case "arrow":
      return "M4 20 L18 6 M11 6 H18 V13";
    case "text":
      return "M4 6 V3 H20 V6 M12 3 V21 M9 21 H15";
    case "blur":
      // 马赛克：四宫格小方块
      return "M4 4 H8 V8 H4 Z M12 4 H16 V8 H12 Z M4 12 H8 V16 H4 Z M12 12 H16 V16 H12 Z";
    case "counter":
      // 序号：圆徽章（模板内叠加数字 1）
      return "M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3";
  }
}

function isActiveTool(tool: Tool) {
  return tool === props.tool;
}

// 线宽调节：形状/文字工具共用 stroke 组（映射来自 tools.ts 单一来源）

function widthOf(group: keyof typeof props.lineWidth) {
  return props.lineWidth[group];
}

function changeWidth(delta: number) {
  const key = TOOL_WIDTH_GROUP[props.tool];
  const cur = props.lineWidth[key];
  // 上限按分组取（荧光笔 80 / 橡皮 120），与设置窗口滑块一致
  const next = Math.min(WIDTH_MAX[key], Math.max(1, Math.round(cur) + delta));
  emit("updateWidth", { [key]: next });
}

// ---- 自定义颜色 ----
const colorPicker = ref<HTMLInputElement | null>(null);
function openPicker() {
  colorPicker.value?.click();
}
function onPickColor(e: Event) {
  const value = (e.target as HTMLInputElement).value;
  emit("selectColor", value);
  emit("customColor", value);
}

// ---- 工具栏拖动（位置记忆由父组件经 localStorage 持久化）----
const rootEl = ref<HTMLElement | null>(null);
const pos = ref<{ x: number; y: number } | null>(
  props.initialPosition ? { ...props.initialPosition } : null,
);
let dragOrigin: { x: number; y: number; px: number; py: number } | null = null;

function onDragStart(e: PointerEvent) {
  // 只允许从工具栏空白区拖动；按钮/色块/输入框照常工作
  const target = e.target as HTMLElement | null;
  if (target?.closest("button, input")) return;
  const rect = rootEl.value?.getBoundingClientRect();
  if (!rect) return;
  dragOrigin = { x: e.clientX, y: e.clientY, px: rect.left, py: rect.top };
  rootEl.value?.setPointerCapture(e.pointerId);
}
function onDragMove(e: PointerEvent) {
  if (!dragOrigin || !rootEl.value) return;
  const rect = rootEl.value.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width;
  const maxY = window.innerHeight - rect.height;
  const x = Math.min(
    maxX,
    Math.max(0, dragOrigin.px + e.clientX - dragOrigin.x),
  );
  const y = Math.min(
    maxY,
    Math.max(0, dragOrigin.py + e.clientY - dragOrigin.y),
  );
  pos.value = { x, y };
}
function onDragEnd() {
  if (!dragOrigin) return;
  dragOrigin = null;
  if (pos.value) emit("toolbarMoved", { ...pos.value });
}
onBeforeUnmount(() => {
  dragOrigin = null;
});
</script>

<template>
  <div
    ref="rootEl"
    class="toolbar double-bezel"
    data-toolbar
    :style="
      pos
        ? { left: `${pos.x}px`, top: `${pos.y}px`, transform: 'none' }
        : undefined
    "
    @pointerdown="onDragStart"
    @pointermove="onDragMove"
    @pointerup="onDragEnd"
    @pointercancel="onDragEnd"
  >
    <!-- 工具组 -->
    <div class="toolbar-group" role="toolbar">
      <button
        v-for="def in TOOL_DEFS"
        :key="def.id"
        class="tool-btn"
        :class="{ active: isActiveTool(def.id) }"
        :title="def.hotkey ? `${t(def.label)} (${def.hotkey})` : t(def.label)"
        @click="emit('selectTool', def.id)"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path :d="toolIcon(def.id)" />
          <text
            v-if="def.id === 'counter'"
            x="12"
            y="16.2"
            text-anchor="middle"
            font-size="11"
            font-weight="700"
            fill="currentColor"
            stroke="none"
          >
            1
          </text>
        </svg>
      </button>
    </div>

    <!-- 颜色组：固定色盘 + 最近自定义色 + 取色器入口 -->
    <div class="toolbar-group color-group">
      <button
        v-for="c in COLOR_PALETTE"
        :key="c"
        class="swatch"
        :class="{ active: c === color }"
        :style="{ background: c }"
        :title="c"
        @click="emit('selectColor', c)"
      />
      <button
        v-for="c in recentColors"
        :key="`r-${c}`"
        class="swatch recent"
        :class="{ active: c === color }"
        :style="{ background: c }"
        :title="`${t('action.recentColor')} ${c}`"
        @click="emit('selectColor', c)"
      />
      <button
        class="swatch add-swatch"
        :title="t('action.customColor')"
        @click="openPicker"
      >
        +
      </button>
      <input
        ref="colorPicker"
        type="color"
        class="color-picker"
        @input="onPickColor"
      />
    </div>

    <!-- 线宽 -->
    <div class="toolbar-group width-group">
      <button class="mini-btn" @click="changeWidth(-1)">−</button>
      <span class="width-value">{{
        Math.round(widthOf(TOOL_WIDTH_GROUP[tool]))
      }}</span>
      <button class="mini-btn" @click="changeWidth(1)">+</button>
    </div>

    <!-- 动作组 -->
    <div class="toolbar-group action-group">
      <button
        class="mini-btn"
        :class="{ active: spotlight }"
        :title="t('action.spotlight')"
        @click="emit('toggleSpotlight')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="5" />
          <path
            d="M12 2 V7 M12 17 V22 M2 12 H7 M17 12 H22 M5 5 L8 8 M16 16 L19 19 M19 5 L16 8 M8 16 L5 19"
          />
        </svg>
      </button>
      <button
        class="mini-btn"
        :class="{ active: zoom }"
        :disabled="board !== 'none'"
        :title="board !== 'none' ? t('action.zoomInBoard') : t('action.zoom')"
        @click="emit('toggleZoom')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21 L16.65 16.65" />
          <rect x="8" y="8" width="6" height="6" />
        </svg>
      </button>
      <button
        class="mini-btn"
        :class="{ active: board !== 'none' }"
        :title="
          board === 'black' ? t('action.boardBlack') : t('action.boardWhite')
        "
        @click="emit('toggleBoard')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="4" y="4" width="16" height="13" rx="1" />
          <path d="M9 21 L12 17 L15 21" />
        </svg>
      </button>
      <button
        class="mini-btn"
        :title="t('action.export')"
        @click="emit('export')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 15 V19 A2 2 0 0 1 19 21 H5 A2 2 0 0 1 3 19 V15" />
          <path d="M7 8 L12 3 L17 8 M12 3 V15" />
        </svg>
      </button>
      <button class="mini-btn" :title="t('action.copy')" @click="emit('copy')">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path
            d="M5 15 H4 A2 2 0 0 1 2 13 V4 A2 2 0 0 1 4 2 H13 A2 2 0 0 1 15 4 V5"
          />
        </svg>
      </button>
      <button
        class="mini-btn"
        :disabled="!canUndo"
        :title="t('action.undo')"
        @click="emit('undo')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M3 7 L9 13 L3 13 Z M9 7 H15 A5 5 0 0 1 15 17 H7" />
        </svg>
      </button>
      <button
        class="mini-btn"
        :disabled="!canRedo"
        :title="t('action.redo')"
        @click="emit('redo')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 7 L15 13 L21 13 Z M15 7 H9 A5 5 0 0 0 9 17 H17" />
        </svg>
      </button>
      <button
        class="mini-btn"
        :disabled="!canClear"
        :title="t('action.clear')"
        @click="emit('clear')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M3 6 H21 M8 6 V4 H16 V6 M6 6 L7 20 H17 L18 6" />
        </svg>
      </button>
      <button
        class="mini-btn"
        :disabled="board !== 'none'"
        :title="
          board !== 'none'
            ? t('action.penetrateInBoard')
            : t('action.penetrate')
        "
        @click="emit('penetrate')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path
            d="M12 2 V7 M12 17 V22 M2 12 H7 M17 12 H22 M5 5 L8 8 M16 16 L19 19 M19 5 L16 8 M8 16 L5 19"
          />
        </svg>
      </button>
      <button
        class="mini-btn danger"
        :title="t('action.exit')"
        @click="emit('exit')"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M9 21 H5 A2 2 0 0 1 3 19 V5 A2 2 0 0 1 5 3 H9 M16 17 L21 12 L16 7 M21 12 H9"
          />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  position: fixed;
  top: var(--space-4);
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--toolbar-z);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  /* 窄屏/竖屏兜底：允许换行且不溢出视口 */
  flex-wrap: wrap;
  justify-content: center;
  max-width: calc(100vw - 16px);
  cursor: grab;
}
.toolbar:active {
  cursor: grabbing;
}
/* 交互元素上恢复常规光标 */
.toolbar button,
.toolbar input {
  cursor: pointer;
}

/* 毛玻璃 + 双镶边来自 .double-bezel，这里补内部布局 */
.toolbar > * {
  position: relative;
  z-index: 1;
}

.toolbar-group {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.tool-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition:
    background var(--duration-hover) var(--ease-default),
    color var(--duration-hover) var(--ease-default),
    border-color var(--duration-hover) var(--ease-default),
    transform var(--duration-spring) var(--ease-spring);
}
.tool-btn svg {
  width: 18px;
  height: 18px;
}
.tool-btn:hover {
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
}
.tool-btn.active {
  color: var(--accent);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: var(--shadow-accent);
}

/* 色板 */
.color-group {
  gap: 4px;
  padding: 4px 6px;
}
.swatch {
  width: 18px;
  height: 18px;
  border-radius: var(--radius-full);
  border: 1.5px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
  padding: 0;
  transition:
    transform var(--duration-spring) var(--ease-spring),
    box-shadow var(--duration-spring) var(--ease-spring),
    border-color var(--duration-hover) var(--ease-default);
}
.swatch:hover {
  transform: scale(1.2);
}
.swatch.active {
  border-color: var(--text-primary);
  box-shadow: 0 0 0 2px var(--accent);
  transform: scale(1.15);
}
/* 最近自定义色：小圆点标记区分 */
.swatch.recent {
  width: 16px;
  height: 16px;
  border-style: dashed;
}
/* 取色器入口：虚线空心圆 + 加号 */
.swatch.add-swatch {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1.5px dashed rgba(255, 255, 255, 0.35);
  color: var(--text-tertiary);
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}
.swatch.add-swatch:hover {
  color: var(--text-secondary);
  border-color: var(--text-secondary);
}
/* 隐藏的原生取色输入框（由 + 按钮触发） */
.color-picker {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

/* 线宽 */
.width-group {
  gap: 2px;
}
.mini-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-tertiary);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
  transition:
    color var(--duration-hover) var(--ease-default),
    background var(--duration-hover) var(--ease-default),
    border-color var(--duration-hover) var(--ease-default);
}
.mini-btn svg {
  width: 14px;
  height: 14px;
}
.mini-btn:hover:not(:disabled) {
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
}
.mini-btn.active {
  color: var(--accent);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.mini-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.mini-btn.danger:hover {
  color: #fff;
  background: #e81123;
}
.width-value {
  min-width: 28px;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
</style>
