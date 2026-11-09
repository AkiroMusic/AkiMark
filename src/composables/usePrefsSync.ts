import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, GeneralConfig } from "../configTypes";
import type { useDrawing } from "./useDrawing";

/**
 * 绘制预设的会话同步：config ⇄ 会话。
 *
 * 三条核心约定（防止"设置里改了线宽，保存后不生效"类回写覆盖 bug）：
 *
 * 1. applyConfig（仅启动 get_config 后调用）：完整应用绘制预设并记录基线；
 * 2. applyConfigUpdate（config-changed 事件路径）：先与基线比对——
 *    工具/颜色/线宽在设置里被改动（≠基线）时**采纳进会话**并更新基线；
 *    与基线相同（只是无关设置触发广播）则不动会话。
 *    早期版本无条件不动会话，导致设置侧的预设改动永远只在下次启动生效；
 * 3. persistDrawingPrefs 仅在有用户改动（prefsDirty）时落盘——
 *    否则退出标注时的兜底落盘会把陈旧会话值写回 config，覆盖用户刚在
 *    设置里保存的值（曾在 overlay 会话与设置窗口之间来回踢皮球）。
 */
export function usePrefsSync(deps: {
  drawing: ReturnType<typeof useDrawing>;
  boardDefault: ReturnType<typeof ref<"white" | "black">>;
  setLocale: (locale: "en" | "zh-CN") => void;
}) {
  /** 配置项 preserveDrawings：为 true 时退出/重进标注保留已有笔迹 */
  const preserveDrawings = ref(false);
  /** 最近使用的自定义颜色（取色器加入，随绘制预设持久化） */
  const recentColors = ref<string[]>([]);

  /** 上次已应用的绘制预设基线（config 侧快照，用于区分"设置侧改动"与"无关广播"） */
  let baseline: Pick<
    GeneralConfig,
    "defaultTool" | "defaultColor" | "lineWidths"
  > | null = null;

  /** 应用配置守卫：批量赋值期间抑制"用户改动"回存 */
  let applyingConfig = false;
  let applyingConfigTimer: number | null = null;
  let prefsSaveTimer: number | null = null;
  let prefsSaveInFlight = false;
  let prefsSaveQueued = false;
  /** 会话是否有未被落盘的用户改动（工具/颜色/线宽/最近色） */
  let prefsDirty = false;

  function guardBegin() {
    applyingConfig = true;
    if (applyingConfigTimer) window.clearTimeout(applyingConfigTimer);
    // watcher 是微任务，等它跑完再复位；定时器句柄 + 覆盖式复位，
    // 防止同一 tick 内两次 config 事件提前清掉守卫
    applyingConfigTimer = window.setTimeout(() => {
      applyingConfig = false;
      applyingConfigTimer = null;
    }, 0);
  }

  /** 启动时完整应用 config：绘制预设 + 通用设置，并记录基线 */
  function applyConfig(cfg: AppConfig) {
    guardBegin();
    const g = cfg.general;
    deps.drawing.currentTool.value = g.defaultTool;
    deps.drawing.currentColor.value = g.defaultColor;
    recentColors.value = g.recentColors ?? [];
    deps.drawing.lineWidths.value = {
      stroke: g.lineWidths.stroke,
      highlighter: g.lineWidths.highlighter,
      eraser: g.lineWidths.eraser,
    };
    baseline = {
      defaultTool: g.defaultTool,
      defaultColor: g.defaultColor,
      lineWidths: { ...g.lineWidths },
    };
    applyConfigUpdate(cfg);
  }

  /** 应用 config 更新中的"非会话状态"字段 + 按基线比对采纳设置侧的预设改动 */
  function applyConfigUpdate(cfg: AppConfig) {
    const g = cfg.general;
    deps.boardDefault.value = g.boardDefault ?? "white";
    preserveDrawings.value = g.preserveDrawings;
    // 应用配置的语言（config.json 优先于 navigator.language 默认值）
    if (g.locale === "en" || g.locale === "zh-CN") {
      deps.setLocale(g.locale);
    }

    // 设置侧改了绘制预设（≠基线）→ 采纳进会话并推进基线；
    // 与基线一致 → 无关广播，不碰会话（避免打断用户手头的选择）
    const toolChanged =
      baseline === null || g.defaultTool !== baseline.defaultTool;
    const colorChanged =
      baseline === null || g.defaultColor !== baseline.defaultColor;
    const widthsChanged =
      baseline === null ||
      g.lineWidths.stroke !== baseline.lineWidths.stroke ||
      g.lineWidths.highlighter !== baseline.lineWidths.highlighter ||
      g.lineWidths.eraser !== baseline.lineWidths.eraser;
    if (toolChanged || colorChanged || widthsChanged) {
      guardBegin();
      if (toolChanged) deps.drawing.currentTool.value = g.defaultTool;
      if (colorChanged) deps.drawing.currentColor.value = g.defaultColor;
      if (widthsChanged) {
        deps.drawing.lineWidths.value = {
          stroke: g.lineWidths.stroke,
          highlighter: g.lineWidths.highlighter,
          eraser: g.lineWidths.eraser,
        };
      }
      baseline = {
        defaultTool: g.defaultTool,
        defaultColor: g.defaultColor,
        lineWidths: { ...g.lineWidths },
      };
      prefsDirty = false; // 采纳的是 config 的值，无需回写
    }
  }

  /** 绘制预设防抖保存：用户改工具/颜色/线宽后 500ms 内无新改动才落盘 */
  function schedulePrefsSave() {
    prefsDirty = true;
    if (prefsSaveTimer) window.clearTimeout(prefsSaveTimer);
    prefsSaveTimer = window.setTimeout(() => {
      prefsSaveTimer = null;
      void persistDrawingPrefs();
    }, 500);
  }

  /** 立即保存当前绘制预设（退出标注时兜底）；无用户改动则跳过（防陈旧回写） */
  function flushPrefsSave() {
    if (prefsSaveTimer) {
      window.clearTimeout(prefsSaveTimer);
      prefsSaveTimer = null;
    }
    if (prefsDirty) void persistDrawingPrefs();
  }

  /** 当前会话绘制预设快照（保存请求与基线推进都以快照为准） */
  function readCurrentPrefs() {
    return {
      tool: deps.drawing.currentTool.value,
      color: deps.drawing.currentColor.value,
      lineWidths: { ...deps.drawing.lineWidths.value },
      recentColors: [...recentColors.value],
    };
  }

  type PrefsSnapshot = ReturnType<typeof readCurrentPrefs>;

  function samePrefs(a: PrefsSnapshot, b: PrefsSnapshot): boolean {
    return (
      a.tool === b.tool &&
      a.color === b.color &&
      a.lineWidths.stroke === b.lineWidths.stroke &&
      a.lineWidths.highlighter === b.lineWidths.highlighter &&
      a.lineWidths.eraser === b.lineWidths.eraser &&
      a.recentColors.length === b.recentColors.length &&
      a.recentColors.every((c, i) => c === b.recentColors[i])
    );
  }

  async function persistDrawingPrefs() {
    if (!prefsDirty && !prefsSaveQueued) return;
    if (prefsSaveInFlight) {
      // 保存进行中又有新改动：记脏，本次保存结束后补一次（避免改动被静默丢弃）
      prefsSaveQueued = true;
      return;
    }
    prefsSaveInFlight = true;
    // 快照本次请求实际携带的值。此前成功后把"当前值"推进为基线——保存
    // 在途时的新改动会被错误地标记为已落盘（磁盘=旧值、基线=新值），且
    // 下次广播会把磁盘旧值反向采纳回会话，用户选择双重丢失。
    const snapshot = readCurrentPrefs();
    try {
      await invoke("save_drawing_prefs", {
        tool: snapshot.tool,
        color: snapshot.color,
        lineWidths: snapshot.lineWidths,
        recentColors: snapshot.recentColors,
      });
      // 基线只推进到已落盘的快照；当前值 ≠ 快照说明在途期间又有改动，
      // 保持 dirty 由 queued 机制补存最新值
      baseline = {
        defaultTool: snapshot.tool,
        defaultColor: snapshot.color,
        lineWidths: { ...snapshot.lineWidths },
      };
      prefsDirty = !samePrefs(readCurrentPrefs(), snapshot);
    } catch (err) {
      // 保存失败：保持 dirty，下次改动/退出兜底时重试
      console.warn("[akimark] save_drawing_prefs failed", err);
    } finally {
      prefsSaveInFlight = false;
      if (prefsSaveQueued) {
        prefsSaveQueued = false;
        void persistDrawingPrefs();
      }
    }
  }

  /** 取色器选定自定义色：去重后置顶，最多保留 4 个，并随预设落盘 */
  function addRecentColor(color: string) {
    const next = [
      color,
      ...recentColors.value.filter((c) => c !== color),
    ].slice(0, 4);
    recentColors.value = next;
    schedulePrefsSave();
  }

  /** watcher 守卫读取口：应用/采纳配置期间抑制回存（右键临时橡皮的抑制在组件层） */
  function isApplyingConfig() {
    return applyingConfig;
  }

  /** 卸载清理：定时器复位 + 有脏才兜底落盘 */
  function dispose() {
    if (prefsSaveTimer) {
      window.clearTimeout(prefsSaveTimer);
      prefsSaveTimer = null;
    }
    if (applyingConfigTimer) {
      window.clearTimeout(applyingConfigTimer);
      applyingConfigTimer = null;
    }
    if (prefsDirty) void persistDrawingPrefs();
  }

  return {
    preserveDrawings,
    recentColors,
    applyConfig,
    applyConfigUpdate,
    schedulePrefsSave,
    flushPrefsSave,
    addRecentColor,
    isApplyingConfig,
    dispose,
  };
}
