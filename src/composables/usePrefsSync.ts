import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "../configTypes";
import type { useDrawing } from "./useDrawing";

/**
 * 绘制预设的会话同步：config → 会话（启动 / config-changed）与会话 → config
 * （用户改动 500ms 防抖落盘）。
 *
 * 两套应用路径的区分是本模块的核心约定：
 * - applyConfig（仅启动 get_config 后调用）：完整应用绘制预设；
 * - applyConfigUpdate（config-changed 事件路径）：只应用非会话字段——
 *   工具/颜色/线宽是 overlay 的会话状态（用户随手改 + 防抖回存），被广播
 *   无条件覆盖会把防抖窗口内的最新选择回滚成陈旧快照。
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

  /** 应用配置守卫：applyConfig 批量赋值期间抑制"用户改动"回存 */
  let applyingConfig = false;
  let applyingConfigTimer: number | null = null;
  let prefsSaveTimer: number | null = null;
  let prefsSaveInFlight = false;
  let prefsSaveQueued = false;

  /** 启动时完整应用 config：绘制预设 + 通用设置 */
  function applyConfig(cfg: AppConfig) {
    applyingConfig = true;
    deps.drawing.currentTool.value = cfg.general.defaultTool;
    deps.drawing.currentColor.value = cfg.general.defaultColor;
    recentColors.value = cfg.general.recentColors ?? [];
    deps.drawing.lineWidths.value = {
      stroke: cfg.general.lineWidths.stroke,
      highlighter: cfg.general.lineWidths.highlighter,
      eraser: cfg.general.lineWidths.eraser,
    };
    applyConfigUpdate(cfg);
    // watcher 是微任务，等它跑完再复位，避免把"应用配置"误判为用户改动触发回存；
    // 用定时器句柄 + 覆盖式复位，防止同一 tick 内两次 config-changed 提前清掉守卫
    if (applyingConfigTimer) window.clearTimeout(applyingConfigTimer);
    applyingConfigTimer = window.setTimeout(() => {
      applyingConfig = false;
      applyingConfigTimer = null;
    }, 0);
  }

  /** 应用 config 更新中的"非会话状态"字段（config-changed 事件路径） */
  function applyConfigUpdate(cfg: AppConfig) {
    deps.boardDefault.value = cfg.general.boardDefault ?? "white";
    preserveDrawings.value = cfg.general.preserveDrawings;
    // 应用配置的语言（config.json 优先于 navigator.language 默认值）
    if (cfg.general.locale === "en" || cfg.general.locale === "zh-CN") {
      deps.setLocale(cfg.general.locale);
    }
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
    if (prefsSaveInFlight) {
      // 保存进行中又有新改动：记脏，本次保存结束后补一次（避免改动被静默丢弃）
      prefsSaveQueued = true;
      return;
    }
    prefsSaveInFlight = true;
    try {
      await invoke("save_drawing_prefs", {
        tool: deps.drawing.currentTool.value,
        color: deps.drawing.currentColor.value,
        lineWidths: {
          stroke: deps.drawing.lineWidths.value.stroke,
          highlighter: deps.drawing.lineWidths.value.highlighter,
          eraser: deps.drawing.lineWidths.value.eraser,
        },
        recentColors: recentColors.value,
      });
    } catch (err) {
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

  /** watcher 守卫读取口：应用配置期间抑制回存（右键临时橡皮的抑制在组件层） */
  function isApplyingConfig() {
    return applyingConfig;
  }

  /** 卸载清理：定时器复位 + 兜底落盘 */
  function dispose() {
    if (prefsSaveTimer) {
      window.clearTimeout(prefsSaveTimer);
      prefsSaveTimer = null;
    }
    if (applyingConfigTimer) {
      window.clearTimeout(applyingConfigTimer);
      applyingConfigTimer = null;
    }
    void persistDrawingPrefs();
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
