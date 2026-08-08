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
  exit: [];
}>();

// 工具图标（Feather 风格内联 SVG，24 viewBox / 1.7 stroke）
function toolIcon(tool: Tool) {
  switch (tool) {
    case "pen":
      return "M12 19 L19 5 L16 4 L4 15 Z M12 19 L5 19 Z";
    case "highlighter":
      return "M9 11 L18 2 L22 6 L13 15 Z M5 19 L9 15 M7 17 L3 21 Z";
    case "eraser":
      return "M7 21 L20 8 L16 4 L3 17 Z M7 21 L10 18 M14 14 L18 18";
  }
}

function isActiveTool(tool: Tool) {
  return tool === props.tool;
}

// 线宽调节
function widthOf(group: keyof typeof props.lineWidth) {
  return props.lineWidth[group];
}

function changeWidth(delta: number) {
  const group: Record<Tool, "stroke" | "highlighter" | "eraser"> = {
    pen: "stroke",
    highlighter: "highlighter",
    eraser: "eraser",
  };
  const key = group[props.tool];
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
        Math.round(
          widthOf(
            (tool === "pen" ? "stroke" : tool) as
              "stroke" | "highlighter" | "eraser",
          ),
        )
      }}</span>
      <button class="mini-btn" @click="changeWidth(1)">+</button>
    </div>

    <!-- 动作组 -->
    <div class="toolbar-group action-group">
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

    <div class="toolbar-hint">{{ t("toolbar.space") }}</div>
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

/* 提示 */
.toolbar-hint {
  font-size: 10px;
  letter-spacing: 0.02em;
  color: var(--text-tertiary);
  padding-right: var(--space-1);
  white-space: nowrap;
}
</style>
