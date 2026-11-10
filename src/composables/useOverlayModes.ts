import { ref } from "vue";
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
 * invoke 统一 await（runEffects 顺序执行全部 effects，模式转换的副作用串行
 * 完成后切换才算完成）；失败语义分野：togglePenetration（X 键）路径回滚
 * isPenetrating 并 toast，其余路径仅 console.warn（以后端为准，前端不盲目回滚），
 * 板书标志 IPC 失败时回滚 boardMode（见 runEffects 的 setBoardActive 分支）。
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
  /** 截屏入口统一前置钩子（提交在途笔画）：工具栏/键盘/未来任何缩放入口共享 */
  beforeCapture?: () => void;
}) {
  const showToolbar = ref(false);
  /** dispatch 单调递增版本号：runEffects 据此丢弃过期 dispatch 的后续副作用 */
  let dispatchRevision = 0;
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

  /**
   * 执行 effects。全部 await：模式转换的副作用串行完成后切换才算完成——
   * 退出穿透的 IPC 未完成就开始截屏、板书标志未确认就允许下一模式操作，
   * 这类交错是二轮审查指出的竞态源。
   *
   * 串行保证的边界（不引入事务队列是设计取舍）：单次 dispatch 内的 effects
   * 严格按序 await；并发 dispatch（如热键与指针入口同时触发）在 await 点
   * 仍可交错——同步裁决段（snapshot → writeBack）每次 dispatch 原子执行。
   * 跨 dispatch 的过期提交由 revision 守卫阻止（见 dispatch）：被更新操作
   * 取代的旧 dispatch 完成已在途的 effect 后，不再提交后续副作用、也不再
   * 执行回滚（回滚新操作已接管的状态是二次破坏）。
   *
   * 失败语义分野：togglePenetration 路径回滚乐观状态并 toast；
   * 其余路径仅 console.warn（以后端为准，前端不盲目回滚），
   * 唯 setBoardActive 失败回滚 boardMode（板书 UI 必须与后端标志一致）。
   */
  async function runEffects(
    effects: ModeEffect[],
    penetrationAwaited: boolean,
    prev?: ModeState,
    isCurrent?: () => boolean,
  ) {
    // 本批 effects 中退出穿透的结果：null = 未涉及；true/false = invoke 成败。
    // 供 setBoardActive 失败回滚判定后端真实模式（四轮审查 P2-01）。
    let exitPenetrationOk: boolean | null = null;
    for (const fx of effects) {
      // 过期 dispatch：让已在途的 effect 完成后就此打住——新操作已接管状态
      if (isCurrent && !isCurrent()) return;
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
          try {
            await invoke(cmd);
            // 进入穿透：工具栏隐藏（穿透中不可交互）；退出穿透：工具栏恢复。
            // 此前共用分支无条件隐藏、退出依赖后端 drawing-return 事件恢复，
            // 事件与 IPC resolve 的顺序竞争会把工具栏留在隐藏态。
            showToolbar.value = fx.type === "invokeExitPenetration";
            exitPenetrationOk = fx.type === "invokeExitPenetration";
          } catch (err) {
            exitPenetrationOk = false;
            console.warn(`[akimark] ${cmd} failed`, err);
            // 过期 dispatch 不回滚：新操作已接管状态，回滚是二次破坏
            if (penetrationAwaited && (!isCurrent || isCurrent())) {
              // 回滚乐观翻转，避免 UI 与后端穿透状态不一致
              isPenetrating.value = !isPenetrating.value;
              deps.showToast(deps.t("action.penetrationFailed"));
            }
          }
          break;
        }
        case "setBoardActive":
          // await：板书标志经后端确认后板书才算切换完成（否则紧随其后的
          // 全局穿透热键可能读到未更新的标志而绕过板书保护）
          try {
            await invoke("set_board_active", { active: fx.active });
          } catch (err) {
            console.warn("[akimark] set_board_active failed", err);
            // 过期 dispatch 不回滚（同上）；IPC 失败：回滚 boardMode 与
            // 马赛克底色，板书 UI 与后端标志一致。同批的退出穿透也失败时
            //（后端 set_board_active 在退出失败时拒绝置位，二者同败），
            // 后端仍是穿透态——连穿透 UI 一起恢复；退出成功仅板书传输
            // 失败时后端已是 Drawing，恢复穿透反而错误。
            if (prev && (!isCurrent || isCurrent())) {
              boardMode.value = prev.board;
              deps.drawing.setBlurBaseColor(
                prev.board === "none" ? null : BOARD_COLORS[prev.board],
              );
              if (exitPenetrationOk === false) {
                isPenetrating.value = prev.penetrating;
                showToolbar.value = prev.toolbarVisible;
              }
            }
          }
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
    // revision 守卫（五轮审查 P2-01）：并发 dispatch 在 await 点交错时，
    // 被更新的 dispatch 取代的旧操作不得继续提交副作用或回滚——否则
    // "穿透态连按 B×2"会让旧 dispatch 在恢复执行后把板书标志重新打开
    const revision = ++dispatchRevision;
    const prev = snapshot();
    const { state, effects } = applyModeAction(prev, action, {
      boardDefault: deps.boardDefault.value,
    });
    writeBack(state);
    await runEffects(
      effects,
      action.type === "togglePenetration",
      prev,
      () => revision === dispatchRevision,
    );
  }

  /** 开启缩放的截屏流程：提交在途笔画 → 隐藏 UI → capture → Blob URL → 置倍率 */
  async function captureZoomBackground() {
    // 统一入口提交在途笔画：renderTo 只渲染已提交 history，未提交笔画
    // 会缺席缩放底图；此前只有键盘 M/Z 路径做了提交，工具栏按钮没有
    deps.beforeCapture?.();

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
    // 动作（组件层快捷键/工具栏直接调用）。统一返回 Promise：副作用
    // 全 await 后，调用方（需要时）可等待模式切换真正完成；不需要时
    // 忽略返回值即可
    toggleZoom: () => dispatch({ type: "toggleZoom" }),
    toggleSpotlight: () => dispatch({ type: "toggleSpotlight" }),
    cycleBoard: () => dispatch({ type: "toggleBoard" }),
    togglePenetration: () => dispatch({ type: "togglePenetration" }),
    stepBack: () => dispatch({ type: "stepBack" }),
    /** 工具栏退出按钮：直接退出标注（不经 Esc 逐级） */
    exitAnnotation: () => runEffects([{ type: "invokeExitAnnotation" }], false),
    toggleToolbarWithSpace,
    onWheel,
    resetModes,
    syncPenetrationFromBackend,
    dispose,
  };
}
