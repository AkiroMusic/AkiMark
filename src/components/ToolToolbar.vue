<script setup lang="ts">
import { TOOL_DEFS } from "../constants/tools";
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
  magnifier: boolean;
  board: "none" | "white" | "black";
  zoom: boolean;
}>();

const emit = defineEmits<{
  selectTool: [tool: Tool];
  selectColor: [color: string];
  updateWidth: [
    width: { stroke?: number; highlighter?: number; eraser?: number },
  ];
  undo: [];
  redo: [];
  clear: [];
  penetrate: [];
  export: [];
  toggleSpotlight: [];
  toggleMagnifier: [];
  toggleBoard: [];
  toggleZoom: [];
  exit: [];
}>();

// 工具图标（Feather 风格内联 SVG，24 viewBox / 1.7 stroke）
function toolIcon(tool: Tool) {
  switch (tool) {
    case "pen":
    case "fading":
      return "M12 19 L19 5 L16 4 L4 15 Z M12 19 L5 19 Z";
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
  }
}

function isActiveTool(tool: Tool) {
  return tool === props.tool;
}

// 线宽调节：形状/文字工具共用 stroke 组
const WIDTH_GROUP: Record<Tool, "stroke" | "highlighter" | "eraser"> = {
  pen: "stroke",
  highlighter: "highlighter",
  eraser: "eraser",
  line: "stroke",
  rect: "stroke",
  circle: "stroke",
  arrow: "stroke",
  text: "stroke",
  fading: "stroke",
  blur: "stroke",
};

function widthOf(group: keyof typeof props.lineWidth) {
  return props.lineWidth[group];
}

function changeWidth(delta: number) {
  const key = WIDTH_GROUP[props.tool];
  const cur = props.lineWidth[key];
  const next = Math.min(40, Math.max(1, Math.round(cur) + delta));
  emit("updateWidth", { [key]: next } as Record<string, number>);
}
</script>

<template>
  <div class="toolbar double-bezel" data-toolbar>
    <!-- 工具组 -->
    <div class="toolbar-group" role="toolbar">
      <button
        v-for="def in TOOL_DEFS"
        :key="def.id"
        class="tool-btn"
        :class="{ active: isActiveTool(def.id) }"
        :title="`${t(def.label)} (${def.hotkey})`"
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
        </svg>
      </button>
    </div>

    <!-- 颜色组 -->
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
    </div>

    <!-- 线宽 -->
    <div class="toolbar-group width-group">
      <button class="mini-btn" @click="changeWidth(-1)">−</button>
      <span class="width-value">{{
        Math.round(widthOf(WIDTH_GROUP[tool]))
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
        :class="{ active: magnifier }"
        :title="t('action.magnifier')"
        @click="emit('toggleMagnifier')"
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
          <path d="M11 8 V14 M8 11 H14" />
        </svg>
      </button>
      <button
        class="mini-btn"
        :class="{ active: zoom }"
        :title="t('action.zoom')"
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
        :title="board === 'black' ? t('action.boardBlack') : t('action.boardWhite')"
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
        :title="t('action.penetrate')"
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
