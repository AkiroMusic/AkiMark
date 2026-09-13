import { computed, ref } from "vue";
import type { Ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  applyModeAction,
  type ModeAction,
  type ModeEffect,
  type ModeState,
} from "./modeMutex";
import { BOARD_COLORS, SPOTLIGHT, ZOOM_LEVELS } from "../constants/tools";
import type { Point } from "./drawingTypes";
import type { useDrawing } from "./useDrawing";

/**
 * 覆盖层模式状态机（板书/缩放/聚光灯/穿透/工具栏）：
 * 状态转移经 modeMutex 纯函数裁决，本模块只执行 effects（invoke/toast/截屏）。
 *
 * invoke 的两种执行风格（与既有行为一致）：
 * - togglePenetration（X 键）路径：await，失败回滚 isPenetrating 并 toast；
 * - 其他模式触发的穿透退出：fire-and-forget，失败仅 console.warn。
 */
export function useOverlayModes(deps: {
  drawing: ReturnType<typeof useDrawing>;
  showToast: (text: string, duration?: number) => void;
  t: (key: string) => string;
  /** 截屏导出期间锁定输入的读写口 */
  uiLocked: { get: () => boolean; set: (v: boolean) => void };
  /** 缩放开启前收起未提交的文字输入框 */
  textEditing: Ref<{
    x: number;
    y: number;
    value: string;
    anchor: Point | null;
  } | null>;
  boardDefault: Ref<"white" | "black">;
  /** 缩放视觉原点在笔画进行中锁定为冻结锚点（与逆映射同源） */
  strokeActive: Ref<boolean>;
  cursorPos: Ref<{ x: number; y: number }>;
}) {
  const showToolbar = ref(false);
  const isPenetrating = ref(false);
  const spotlight = ref(false);
  const spotlightRadius = ref(SPOTLIGHT.initial);
  const boardMode = ref<"none" | "white" | "black">("none");
  /** 缩放倍率：0 = 关闭 / 2 / 4 / 6 / 8 */
  const zoom = ref(0);
  const zoomBg = ref<string | null>(null);
  /** 本次笔画按下时刻的光标位置：捕获空间逆映射基准（笔画中途不随鼠标移动） */
  const zoomAnchor = ref<Point | null>(null);

  /** 替换缩放底图并释放旧 Blob URL（base64 data URL 会让数十 MB 字符串常驻内存） */
  function setZoomBg(next: string | null) {
    if (zoomBg.value) URL.revokeObjectURL(zoomBg.value);
    zoomBg.value = next;
  }

  /** 缩放视觉原点：与 mapToCapture 的逆映射锚点同源，否则笔画偏移 (1-z)×(光标-锚点) */
  const zoomOrigin = computed(() =>
    deps.strokeActive.value && zoomAnchor.value
      ? zoomAnchor.value
      : deps.cursorPos.value,
  );

  function snapshot(): ModeState {
    return {
      board: boardMode.value,
      zoom: zoom.value,
      spotlight: spotlight.value,
      penetrating: isPenetrating.value,
      toolbarVisible: showToolbar.value,
    };
  }

  function writeBack(s: ModeState) {
    boardMode.value = s.board;
    zoom.value = s.zoom;
    spotlight.value = s.spotlight;
    isPenetrating.value = s.penetrating;
    showToolbar.value = s.toolbarVisible;
  }

  /** 执行 effects。penetrationAwaited=true 时穿透 invoke 走 await+回滚路径 */
  async function runEffects(
    effects: ModeEffect[],
    penetrationAwaited: boolean,
  ) {
    for (const fx of effects) {
      switch (fx.type) {
        case "toast":
          deps.showToast(deps.t(`action.${fx.key}`));
          break;
        case "invokeEnterPenetration":
        case "invokeExitPenetration": {
          const cmd =
            fx.type === "invokeEnterPenetration"
              ? "enter_penetration_mode"
              : "exit_penetration_mode";
          if (penetrationAwaited) {
            try {
              await invoke(cmd);
              // 既有行为：穿透切换成功后隐藏工具栏（穿透中不可交互）
              showToolbar.value = false;
            } catch (err) {
              console.warn(`[akimark] ${cmd} failed`, err);
              // 回滚乐观翻转，避免 UI 与后端穿透状态不一致
              isPenetrating.value = !isPenetrating.value;
              deps.showToast(deps.t("action.penetrationFailed"));
            }
          } else {
            void invoke(cmd).catch((err) => {
              console.warn(`[akimark] ${cmd} failed`, err);
            });
          }
          break;
        }
        case "setBoardActive":
          void invoke("set_board_active", { active: fx.active }).catch(
            (err) => {
              console.warn("[akimark] set_board_active failed", err);
            },
          );
          break;
        case "setBoardColor":
          deps.drawing.setBlurBaseColor(
            fx.color === null ? null : BOARD_COLORS[fx.color],
          );
          break;
        case "exitZoom":
          zoomAnchor.value = null;
          if (fx.clearBackground) setZoomBg(null);
          break;
        case "zoomCapture":
          await captureZoomBackground();
          break;
        case "invokeExitAnnotation":
          try {
            await invoke("exit_drawing");
          } catch (err) {
            console.warn("[akimark] exit_drawing failed", err);
          }
          break;
      }
    }
  }

  async function dispatch(action: ModeAction) {
    const { state, effects } = applyModeAction(snapshot(), action, {
      boardDefault: deps.boardDefault.value,
    });
    writeBack(state);
    await runEffects(effects, action.type === "togglePenetration");
  }

  /** 开启缩放的截屏流程：隐藏 UI → capture → base64 转 Blob URL → 置倍率 */
  async function captureZoomBackground() {
    const prevToolbar = showToolbar.value;
    showToolbar.value = false;
    deps.textEditing.value = null;

    deps.uiLocked.set(true);
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    try {
      const base64 = await invoke<string>("capture_screen");
      // base64 → Blob URL：data URL 会把整屏 PNG 的 base64 字符串常驻内存
      //（4K/8K 下数十 MB），Blob URL 只持解码位图且可及时 revoke
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      setZoomBg(URL.createObjectURL(new Blob([bytes], { type: "image/png" })));
      zoom.value = ZOOM_LEVELS[0];
      deps.showToast(deps.t("action.zoom"));
    } catch (err) {
      console.warn("[akimark] toggle_zoom capture_screen failed", err);
      deps.showToast(deps.t("action.captureFailed"));
    } finally {
      deps.uiLocked.set(false);
      showToolbar.value = prevToolbar;
    }
  }

  /** 空格切换工具栏：焦点在工具栏按钮上时先释放（防按钮原生 Space 激活抢占） */
  function toggleToolbarWithSpace() {
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest("[data-toolbar]")) active.blur();
    void dispatch({ type: "toggleToolbar" });
  }

  /**
   * 滚轮：聚光灯开启时调半径；否则缩放开启时调倍率。
   * Vue 模板对 wheel 默认 passive，preventDefault 需非 passive 监听（组件层负责）。
   */
  function onWheel(e: WheelEvent) {
    if (spotlight.value) {
      e.preventDefault();
      spotlightRadius.value = Math.min(
        SPOTLIGHT.max,
        Math.max(
          SPOTLIGHT.min,
          spotlightRadius.value +
            (e.deltaY < 0 ? SPOTLIGHT.step : -SPOTLIGHT.step),
        ),
      );
      return;
    }
    if (zoom.value <= 0) return;
    e.preventDefault();
    const idx = ZOOM_LEVELS.indexOf(zoom.value);
    const next =
      e.deltaY < 0
        ? ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, idx + 1)]
        : ZOOM_LEVELS[Math.max(0, idx - 1)];
    if (next !== zoom.value) zoom.value = next;
  }

  /** 复位叠加态（随清屏与模式切换一起重置），板书/缩放/聚光灯全部退回 */
  function resetModes() {
    boardMode.value = "none";
    deps.drawing.setBlurBaseColor(null);
    zoom.value = 0;
    setZoomBg(null);
    zoomAnchor.value = null;
    spotlight.value = false;
    // 板书已退出：穿透恢复可用（后端同步）
    void invoke("set_board_active", { active: false }).catch((err) => {
      console.warn("[akimark] set_board_active failed", err);
    });
  }

  /** 后端 overlay-mode-changed 事件的穿透分支：UI 同步（含退出缩放的互斥） */
  function syncPenetrationFromBackend(penetrating: boolean) {
    isPenetrating.value = penetrating;
    showToolbar.value = !penetrating;
    if (penetrating) {
      // 穿透与缩放互斥：全局热键切入穿透时同步退出缩放（聚光灯可随穿透保留）
      zoom.value = 0;
      zoomAnchor.value = null;
    }
  }

  /** 卸载清理：释放缩放底图 Blob URL */
  function dispose() {
    setZoomBg(null);
  }

  return {
    // 状态
    showToolbar,
    isPenetrating,
    spotlight,
    spotlightRadius,
    boardMode,
    zoom,
    zoomBg,
    zoomAnchor,
    zoomOrigin,
    setZoomBg,
    // 动作（组件层快捷键/工具栏直接调用）
    toggleZoom: () => dispatch({ type: "toggleZoom" }),
    toggleSpotlight: () => void dispatch({ type: "toggleSpotlight" }),
    cycleBoard: () => void dispatch({ type: "toggleBoard" }),
    togglePenetration: () => dispatch({ type: "togglePenetration" }),
    stepBack: () => void dispatch({ type: "stepBack" }),
    /** 工具栏退出按钮：直接退出标注（不经 Esc 逐级） */
    exitAnnotation: () =>
      void runEffects([{ type: "invokeExitAnnotation" }], false),
    toggleToolbarWithSpace,
    onWheel,
    resetModes,
    syncPenetrationFromBackend,
    dispose,
  };
}
