<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, Shortcuts } from "./configTypes";
import { COLOR_PALETTE, DEFAULT_COLOR } from "./constants/colors";
import { TOOL_DEFS } from "./constants/tools";
import { useI18n } from "./i18n";
import type { Tool } from "./composables/drawingTypes";

const { t } = useI18n();

// ---- 表单状态 ----
const shortcuts = reactive<Shortcuts>({
  toggleDrawing: "Ctrl+Shift+R",
  clearDrawing: "Ctrl+Shift+C",
  togglePenetration: "Ctrl+Shift+X",
});

const defaultTool = ref<Tool>("pen");
const defaultColor = ref(DEFAULT_COLOR);
/** 默认画布：white = 白板，black = 黑板 */
const boardDefault = ref<"white" | "black">("white");
const lineWidths = reactive({ stroke: 3, highlighter: 10, eraser: 12 });
const autostart = ref(false);
const openSettingsOnStartup = ref(true);
/** 导出目录；null = 系统图片目录 */
const exportDir = ref<string | null>(null);

const loading = ref(true);
const saving = ref(false);
const savedToast = ref(false);
const errorMsg = ref("");
/** 注册失败的全局快捷键（被其他程序占用） */
const conflictKeys = ref<string[]>([]);

// 快捷键录制
const recordingKey = ref<
  "toggleDrawing" | "clearDrawing" | "togglePenetration" | null
>(null);
const shortcutDraft = ref("");

type ShortcutKey = keyof Shortcuts;

const SHORTCUT_KEYS: { key: ShortcutKey; label: string }[] = [
  { key: "toggleDrawing", label: t("settings.toggleDrawing") },
  { key: "clearDrawing", label: t("settings.clearDrawing") },
  { key: "togglePenetration", label: t("settings.togglePenetration") },
];

const ALL_SHORTCUTS: ShortcutKey[] = [
  "toggleDrawing",
  "clearDrawing",
  "togglePenetration",
];

/** 校验错误 key 白名单：errorMsg 属于这些 key 时按 i18n 翻译，否则视为原始错误文本 */
const ERROR_I18N_KEYS = ["shortcut-empty", "shortcut-duplicate"];
function isI18nErrorKey(msg: string): boolean {
  return ERROR_I18N_KEYS.includes(msg);
}

// ---- 加载 ----
onMounted(async () => {
  // 监听快捷键冲突广播（启动时注册失败 / 保存时被占用）
  const { listen } = await import("@tauri-apps/api/event");
  listen<string[]>("shortcut-conflict", (e) => {
    conflictKeys.value = e.payload;
  }).catch(() => {});

  try {
    const cfg = await invoke<AppConfig>("get_config");
    shortcuts.toggleDrawing = cfg.shortcuts.toggleDrawing;
    shortcuts.clearDrawing = cfg.shortcuts.clearDrawing;
    shortcuts.togglePenetration = cfg.shortcuts.togglePenetration;
    defaultTool.value = cfg.general.defaultTool;
    defaultColor.value = cfg.general.defaultColor;
    boardDefault.value = cfg.general.boardDefault ?? "white";
    lineWidths.stroke = cfg.general.lineWidths.stroke;
    lineWidths.highlighter = cfg.general.lineWidths.highlighter;
    lineWidths.eraser = cfg.general.lineWidths.eraser;
    openSettingsOnStartup.value = cfg.general.openSettingsOnStartup;
    exportDir.value = cfg.general.exportDir ?? null;

    try {
      autostart.value = await invoke<boolean>("get_autostart");
    } catch {
      autostart.value = false;
    }

    // 查询启动时已存在的快捷键冲突（可能早于本窗口打开）
    try {
      conflictKeys.value = await invoke<string[]>("get_shortcut_conflicts");
    } catch {
      /* 忽略 */
    }
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    loading.value = false;
  }
});

// ---- 快捷键录制 ----
function startRecording(key: ShortcutKey) {
  if (recordingKey.value === key) {
    recordingKey.value = null;
    return;
  }
  recordingKey.value = key;
  shortcutDraft.value = shortcuts[key];
}

function onKeyDownCapture(e: KeyboardEvent) {
  if (!recordingKey.value) return;
  e.preventDefault();
  e.stopPropagation();

  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

  const k = e.key;
  // 只接受修饰键 + 一个功能键/字母/数字
  const isPlainKey =
    /^[a-zA-Z0-9]$/.test(k) ||
    [
      "F1",
      "F2",
      "F3",
      "F4",
      "F5",
      "F6",
      "F7",
      "F8",
      "F9",
      "F10",
      "F11",
      "F12",
      "Space",
      "Tab",
      "Enter",
      "Escape",
    ].includes(k);
  if (!isPlainKey) return;

  // 去掉修饰键本身作为主键的情况
  if (["Control", "Alt", "Shift", "Meta"].includes(k)) return;

  const keyPart = k.length === 1 ? k.toUpperCase() : k;
  if (parts.length === 0) return; // 必须带至少一个修饰键
  parts.push(keyPart);
  shortcuts[recordingKey.value] = parts.join("+");
  recordingKey.value = null;
}

/** 校验：三个快捷键不可重复，且格式非空 */
function validateShortcuts(): string | null {
  const values = ALL_SHORTCUTS.map((k) => shortcuts[k].trim());
  if (values.some((v) => v === "")) return "shortcut-empty";
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) return "shortcut-duplicate";
    seen.add(v);
  }
  return null;
}

// ---- 导出目录 ----
/** 打开系统目录选择器（tauri-plugin-dialog），返回所选目录或 null */
async function chooseExportDir() {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("settings.exportDirChoose"),
    });
    if (typeof selected === "string" && selected) {
      exportDir.value = selected;
    }
  } catch (e) {
    console.warn("[akimark] 选择导出目录失败:", e);
  }
}

// ---- 保存 ----
async function save() {
  const err = validateShortcuts();
  if (err) {
    errorMsg.value = err;
    return;
  }
  errorMsg.value = "";
  saving.value = true;
  try {
    // 快捷键：返回被占用的快捷键列表
    const conflicts = await invoke<string[]>("save_shortcuts", {
      shortcuts: { ...shortcuts },
    });
    if (conflicts.length > 0) {
      const detail = conflicts.join(" / ");
      errorMsg.value = `${t("settings.shortcutConflict")}: ${detail}`;
    }
    // 常规设置
    await invoke("save_general", {
      general: {
        locale: "zh-CN",
        theme: "dark",
        preserveDrawings: false,
        lineWidths: { ...lineWidths },
        defaultTool: defaultTool.value,
        defaultColor: defaultColor.value,
        boardDefault: boardDefault.value,
        openSettingsOnStartup: openSettingsOnStartup.value,
        exportDir: exportDir.value,
      },
    });
    // 自启动
    await invoke("set_autostart", { enabled: autostart.value });
    savedToast.value = true;
    setTimeout(() => (savedToast.value = false), 1600);
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="settings-root" @keydown.capture="onKeyDownCapture">
    <!-- 头部 -->
    <header class="settings-header">
      <div class="brand-mark" aria-hidden="true"></div>
      <h1 class="settings-title">{{ t("settings.title") }}</h1>
    </header>

    <main v-if="!loading" class="settings-body">
      <!-- 全局快捷键 -->
      <section class="section double-bezel">
        <h2 class="section-title">{{ t("settings.shortcuts") }}</h2>
        <div
          v-for="item in SHORTCUT_KEYS"
          :key="item.key"
          class="shortcut-row"
          :class="{ recording: recordingKey === item.key }"
          @click="startRecording(item.key)"
        >
          <span class="shortcut-label">{{ item.label }}</span>
          <span class="shortcut-value font-mono">
            {{ recordingKey === item.key ? "…" : shortcuts[item.key] }}
          </span>
          <span v-if="recordingKey === item.key" class="recording-dot"></span>
        </div>
        <p class="section-hint">{{ t("settings.recordHint") }}</p>
      </section>

      <!-- 自启动 -->
      <section class="section double-bezel">
        <div class="switch-row">
          <div>
            <h2 class="section-title mb0">{{ t("settings.autostart") }}</h2>
            <p class="section-hint mb0">{{ t("settings.autostartDesc") }}</p>
          </div>
          <button
            class="switch"
            :class="{ on: autostart }"
            role="switch"
            :aria-checked="autostart"
            @click="autostart = !autostart"
          >
            <span class="switch-knob"></span>
          </button>
        </div>
        <div class="switch-row">
          <div>
            <h2 class="section-title mb0">
              {{ t("settings.openSettingsOnStartup") }}
            </h2>
          </div>
          <button
            class="switch"
            :class="{ on: openSettingsOnStartup }"
            role="switch"
            :aria-checked="openSettingsOnStartup"
            @click="openSettingsOnStartup = !openSettingsOnStartup"
          >
            <span class="switch-knob"></span>
          </button>
        </div>
      </section>

      <!-- 画笔工具 -->
      <section class="section double-bezel">
        <h2 class="section-title">{{ t("settings.defaultTool") }}</h2>
        <div class="tool-row">
          <button
            v-for="def in TOOL_DEFS"
            :key="def.id"
            class="tool-chip"
            :class="{ active: defaultTool === def.id }"
            @click="defaultTool = def.id"
          >
            {{ t(def.label) }}
          </button>
        </div>

        <h2 class="section-title">{{ t("settings.defaultColor") }}</h2>
        <div class="color-row">
          <button
            v-for="c in COLOR_PALETTE"
            :key="c"
            class="swatch"
            :class="{ active: defaultColor === c }"
            :style="{ background: c }"
            :title="c"
            @click="defaultColor = c"
          />
        </div>

        <h2 class="section-title">{{ t("settings.boardDefault") }}</h2>
        <div class="tool-row">
          <button
            class="tool-chip"
            :class="{ active: boardDefault === 'white' }"
            @click="boardDefault = 'white'"
          >
            {{ t("settings.boardWhite") }}
          </button>
          <button
            class="tool-chip"
            :class="{ active: boardDefault === 'black' }"
            @click="boardDefault = 'black'"
          >
            {{ t("settings.boardBlack") }}
          </button>
        </div>

        <h2 class="section-title">{{ t("settings.lineWidths") }}</h2>
        <div class="width-row">
          <label class="width-field">
            <span class="width-label">{{ t("tool.pen") }}</span>
            <input
              v-model.number="lineWidths.stroke"
              type="number"
              min="1"
              max="40"
              class="width-input"
            />
          </label>
          <label class="width-field">
            <span class="width-label">{{ t("tool.highlighter") }}</span>
            <input
              v-model.number="lineWidths.highlighter"
              type="number"
              min="1"
              max="80"
              class="width-input"
            />
          </label>
          <label class="width-field">
            <span class="width-label">{{ t("tool.eraser") }}</span>
            <input
              v-model.number="lineWidths.eraser"
              type="number"
              min="1"
              max="120"
              class="width-input"
            />
          </label>
        </div>
      </section>

      <!-- 导出目录 -->
      <section class="section double-bezel">
        <h2 class="section-title">{{ t("settings.exportDir") }}</h2>
        <div class="export-row">
          <span class="export-path font-mono" :title="exportDir ?? undefined">
            {{ exportDir || t("settings.exportDirDefault") }}
          </span>
          <button class="update-btn" @click="chooseExportDir">
            {{ t("settings.exportDirChoose") }}
          </button>
          <button
            v-if="exportDir"
            class="update-btn ghost"
            @click="exportDir = null"
          >
            ✕
          </button>
        </div>
        <p class="section-hint">{{ t("settings.exportDirDesc") }}</p>
      </section>

      <!-- 快捷键冲突横幅：被其他程序占用的全局快捷键 -->
      <div v-if="conflictKeys.length > 0" class="conflict-banner" role="alert">
        <span class="conflict-icon" aria-hidden="true">⚠</span>
        <div class="conflict-body">
          <p class="conflict-title">
            {{ t("settings.shortcutConflictBanner") }}
          </p>
          <p class="conflict-keys font-mono">{{ conflictKeys.join(" / ") }}</p>
        </div>
      </div>

      <!-- 错误提示：errorMsg 为 i18n key 时翻译，为原始错误文本时原样显示 -->
      <p v-if="errorMsg" class="error-text">
        {{ isI18nErrorKey(errorMsg) ? t(`settings.${errorMsg}`) : errorMsg }}
      </p>

      <!-- 快捷键 / 功能一览 -->
      <section class="section double-bezel">
        <h2 class="section-title">{{ t("settings.helpTitle") }}</h2>

        <h3 class="help-sub">{{ t("settings.helpGlobal") }}</h3>
        <div class="help-row">
          <kbd class="help-kbd font-mono">Ctrl+Shift+R</kbd>
          <span class="help-desc">{{ t("settings.helpGlobalToggle") }}</span>
        </div>
        <div class="help-row">
          <kbd class="help-kbd font-mono">Ctrl+Shift+C</kbd>
          <span class="help-desc">{{ t("settings.helpGlobalClear") }}</span>
        </div>
        <div class="help-row">
          <kbd class="help-kbd font-mono">Ctrl+Shift+X</kbd>
          <span class="help-desc">{{ t("settings.helpGlobalPenetrate") }}</span>
        </div>

        <h3 class="help-sub">{{ t("settings.helpInApp") }}</h3>
        <div class="help-row">
          <kbd class="help-kbd font-mono">1–0</kbd>
          <span class="help-desc">{{ t("settings.helpIn1") }}</span>
        </div>
        <div class="help-row">
          <kbd class="help-kbd font-mono">Q / E</kbd>
          <span class="help-desc">{{ t("settings.helpInQE") }}</span>
        </div>
        <div class="help-row">
          <kbd class="help-kbd font-mono">Space</kbd>
          <span class="help-desc">{{ t("settings.helpInSpace") }}</span>
        </div>
        <div class="help-row">
          <kbd class="help-kbd font-mono">X</kbd>
          <span class="help-desc">{{ t("settings.helpInX") }}</span>
        </div>
        <div class="help-row">
          <kbd class="help-kbd font-mono">F</kbd>
          <span class="help-desc">{{ t("settings.helpInF") }}</span>
        </div>
        <div class="help-row">
          <kbd class="help-kbd font-mono">M / Z</kbd>
          <span class="help-desc">{{ t("settings.helpInM") }}</span>
        </div>
        <div class="help-row">
          <kbd class="help-kbd font-mono">B</kbd>
          <span class="help-desc">{{ t("settings.helpInB") }}</span>
        </div>
        <div class="help-row">
          <kbd class="help-kbd font-mono">S</kbd>
          <span class="help-desc">{{ t("settings.helpInS") }}</span>
        </div>
        <div class="help-row">
          <kbd class="help-kbd font-mono">Ctrl+C</kbd>
          <span class="help-desc">{{ t("settings.helpInCtrlC") }}</span>
        </div>
        <div class="help-row">
          <kbd class="help-kbd font-mono">Ctrl+Z / Ctrl+Y</kbd>
          <span class="help-desc">{{ t("settings.helpInCtrlZY") }}</span>
        </div>
        <div class="help-row">
          <kbd class="help-kbd font-mono">Esc</kbd>
          <span class="help-desc">{{ t("settings.helpInEsc") }}</span>
        </div>

        <h3 class="help-sub">{{ t("settings.helpMouse") }}</h3>
        <div class="help-row">
          <span class="help-mouse">{{ t("settings.helpMouseDraw") }}</span>
        </div>
        <div class="help-row">
          <span class="help-mouse">{{ t("settings.helpMouseErase") }}</span>
        </div>

        <h3 class="help-sub">{{ t("settings.helpMore") }}</h3>
        <div class="help-row">
          <span class="help-mouse">{{ t("settings.helpTray") }}</span>
        </div>
        <div class="help-row">
          <span class="help-mouse">{{ t("settings.helpAutoPenetrate") }}</span>
        </div>
        <div class="help-row">
          <span class="help-mouse">{{ t("settings.helpPressure") }}</span>
        </div>
        <div class="help-row">
          <span class="help-mouse">{{ t("settings.helpConflict") }}</span>
        </div>

        <p class="section-hint">{{ t("settings.helpTip") }}</p>
      </section>
    </main>

    <div v-else class="settings-body loading-box">…</div>

    <!-- 底部 -->
    <footer class="settings-footer">
      <Transition name="fade">
        <span v-if="savedToast" class="saved-tag">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4 12 L10 18 L20 6" />
          </svg>
          {{ t("settings.saved") }}
        </span>
      </Transition>
      <button class="primary-btn" :disabled="saving || loading" @click="save">
        {{ saving ? "…" : t("settings.save") }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.settings-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background:
    radial-gradient(
      120% 80% at 50% -20%,
      rgba(108, 140, 255, 0.1),
      transparent 60%
    ),
    var(--bg-base);
  overflow: hidden;
}

/* ---- 头部 ---- */
.settings-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-4) var(--space-2);
  -webkit-app-region: drag;
}
.brand-mark {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  background: linear-gradient(135deg, var(--accent), var(--accent-secondary));
  box-shadow: var(--shadow-accent);
}
.settings-title {
  font-family: var(--font-sans);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.02em;
  margin: 0;
  flex: 1;
}
.icon-btn {
  -webkit-app-region: no-drag;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition:
    color var(--duration-hover) var(--ease-default),
    background var(--duration-hover) var(--ease-default);
}
.icon-btn:hover {
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
}
.icon-btn svg {
  width: 15px;
  height: 15px;
}

/* ---- 主体 ---- */
.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-2) var(--space-4) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.loading-box {
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 13px;
}

.section {
  padding: var(--space-4);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-tertiary);
  margin: 0 0 var(--space-1);
}
.section-title.mb0 {
  margin-bottom: 0;
}
.section-hint {
  font-size: 11px;
  color: var(--text-tertiary);
  margin: var(--space-1) 0 0;
  line-height: 1.5;
}
.section-hint.mb0 {
  margin: 2px 0 0;
}

/* ---- 快捷键行 ---- */
.shortcut-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 9px var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: color-mix(in srgb, var(--text-primary) 3%, transparent);
  cursor: pointer;
  transition:
    border-color var(--duration-hover) var(--ease-default),
    background var(--duration-hover) var(--ease-default);
}
.shortcut-row:hover {
  border-color: var(--border);
}
.shortcut-row.recording {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  box-shadow: var(--shadow-accent);
}
.shortcut-label {
  flex: 1;
  font-size: 13px;
  color: var(--text-secondary);
}
.shortcut-value {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--text-primary) 5%, transparent);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 10px;
}
.recording-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--accent);
  animation: pulse 1s var(--ease-default) infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}
.font-mono {
  font-family: var(--font-mono);
}

/* ---- 开关 ---- */
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.switch {
  position: relative;
  width: 40px;
  height: 22px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  background: var(--surface-2);
  cursor: pointer;
  padding: 0;
  transition:
    background var(--duration-hover) var(--ease-default),
    border-color var(--duration-hover) var(--ease-default);
  flex-shrink: 0;
}
.switch.on {
  background: color-mix(in srgb, var(--accent) 70%, transparent);
  border-color: transparent;
}
.switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-full);
  background: #fff;
  box-shadow: var(--shadow-1);
  transition: transform var(--duration-spring) var(--ease-spring);
}
.switch.on .switch-knob {
  transform: translateX(18px);
}

/* ---- 工具 / 颜色 ---- */
.tool-row {
  display: flex;
  gap: var(--space-2);
}
.tool-chip {
  flex: 1;
  padding: 8px 0;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--text-primary) 3%, transparent);
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 13px;
  cursor: pointer;
  transition: all var(--duration-hover) var(--ease-default);
}
.tool-chip:hover {
  color: var(--text-primary);
  border-color: var(--text-tertiary);
}
.tool-chip.active {
  color: var(--accent);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: var(--shadow-accent);
}

.color-row {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.swatch {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-full);
  border: 2px solid rgba(255, 255, 255, 0.12);
  cursor: pointer;
  padding: 0;
  transition:
    transform var(--duration-spring) var(--ease-spring),
    border-color var(--duration-hover) var(--ease-default);
}
.swatch:hover {
  transform: scale(1.15);
}
.swatch.active {
  border-color: var(--text-primary);
  box-shadow: 0 0 0 2px var(--accent);
  transform: scale(1.1);
}

/* ---- 线宽 ---- */
.width-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: var(--space-2);
}
.width-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.width-label {
  font-size: 11px;
  color: var(--text-tertiary);
}
.width-input {
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
  text-align: center;
  -webkit-app-region: no-drag;
}
.width-input:focus {
  outline: none;
  border-color: var(--accent);
}

/* ---- 导出目录 ---- */
.export-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.export-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
}

/* ---- 错误 ---- */
.error-text {
  font-size: 12px;
  color: var(--error);
  margin: 0;
  padding: 0 var(--space-1);
}

.update-btn {
  flex-shrink: 0;
  padding: 6px 14px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--duration-hover) var(--ease-default);
}
.update-btn:hover:not(:disabled) {
  filter: brightness(1.1);
  border-color: var(--accent);
}
.update-btn.ghost {
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
  color: var(--text-secondary);
}
.update-btn.ghost:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--text-tertiary);
}
.update-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ---- 快捷键冲突横幅 ---- */
.conflict-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid color-mix(in srgb, var(--error) 45%, transparent);
  background: color-mix(in srgb, var(--error) 9%, transparent);
}
.conflict-icon {
  font-size: 14px;
  line-height: 1.4;
  color: var(--error);
  flex-shrink: 0;
}
.conflict-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.conflict-title {
  font-size: 12px;
  color: var(--error);
  margin: 0;
  line-height: 1.5;
}
.conflict-keys {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

/* ---- 快捷键 / 功能一览 ---- */
.help-sub {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  margin: var(--space-2) 0 var(--space-1);
}
.help-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 5px 0;
}
.help-kbd {
  min-width: 92px;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 6px;
  padding: 2px 8px;
  flex-shrink: 0;
}
.help-desc {
  font-size: 12px;
  color: var(--text-secondary);
}
.help-mouse {
  font-size: 12px;
  color: var(--text-secondary);
}

/* ---- 底部 ---- */
.settings-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4) var(--space-4);
}
.saved-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--success);
}
.saved-tag svg {
  width: 13px;
  height: 13px;
}
.primary-btn {
  min-width: 96px;
  padding: 9px 22px;
  border-radius: var(--radius-full);
  border: none;
  background: linear-gradient(135deg, var(--accent), var(--accent-secondary));
  color: #fff;
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  box-shadow: var(--shadow-accent);
  transition:
    transform var(--duration-spring) var(--ease-spring),
    filter var(--duration-hover) var(--ease-default),
    opacity var(--duration-hover) var(--ease-default);
}
.primary-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  filter: brightness(1.08);
}
.primary-btn:active:not(:disabled) {
  transform: translateY(0) scale(0.98);
}
.primary-btn:disabled {
  opacity: 0.5;
  cursor: default;
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
