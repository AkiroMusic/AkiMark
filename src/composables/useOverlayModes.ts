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
   * 取代的旧 dispatch 完成已在途的 effect 后，不再提交后续副作用、成功收尾
   * （如工具栏恢复）与回滚——await 之后的每一次状态提交都要先确认自己仍
   * 是最新操作（六轮审查 P2-01）。resetModes / exitAnnotation 走
   * invalidatePendingDispatches 使在途 dispatch 全部过期（会话级重置）。
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
      if (isCurrent && !isCurrent()) {
        console.info("[mode] dispatch superseded");
        return;
      }
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
            // await 后提交也受 revision 约束（六轮审查 P2-01）：过期 dispatch
            // 的成功收尾不得覆盖新操作的 UI 状态（穿透态 Space×2：第一次的
            // 迟到返回会把第二次切好的工具栏重新显示）。
            // 进入穿透：工具栏隐藏（穿透中不可交互）；退出穿透：工具栏恢复。
            // 此前共用分支无条件隐藏、退出依赖后端 drawing-return 事件恢复，
            // 事件与 IPC resolve 的顺序竞争会把工具栏留在隐藏态。
            if (!isCurrent || isCurrent()) {
              showToolbar.value = fx.type === "invokeExitPenetration";
              exitPenetrationOk = fx.type === "invokeExitPenetration";
            }
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
          await captureZoomBackground(isCurrent);
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
    // 输入锁自检（八轮审查）：uiLocked 期间拒绝新 dispatch。组件 onKeyDown
    // 的检查是第一道门（真实按键路径），这里是第二道——绕过组件直调
    // （测试/未来入口）也无法穿透锁。transitionLock 场景（下方 set(true)
    // 之后）任何并发 dispatch 同样被拒，与组件拦截语义一致。
    if (deps.uiLocked.get()) return;
    // revision 守卫（五轮审查 P2-01）：并发 dispatch 在 await 点交错时，
    // 被更新的 dispatch 取代的旧操作不得继续提交副作用或回滚——否则
    // "穿透态连按 B×2"会让旧 dispatch 在恢复执行后把板书标志重新打开
    const revision = ++dispatchRevision;
    console.info(`[mode] dispatch ${action.type} rev=${revision}`);
    const prev = snapshot();
    // Zoom 过渡锁（八轮审查）：穿透态开启缩放时，退出穿透 IPC 在途期间
    // uiLocked 仍为 false（captureZoomBackground 要等 IPC 完成才设锁）——
    // 此窗口内的 Esc 经 stepBack 看到 zoom=0/spotlight=false/board=none，
    // 会误走 invokeExitAnnotation 退出整个标注（QA Hidden 现象根因）。
    // 在第一个 effect 之前锁输入，整个转换结束后释放。
    const transitionLock = action.type === "toggleZoom" && prev.penetrating;
    const { state, effects } = applyModeAction(prev, action, {
      boardDefault: deps.boardDefault.value,
    });
    if (transitionLock) deps.uiLocked.set(true);
    try {
      writeBack(state);
      await runEffects(
        effects,
        action.type === "togglePenetration",
        prev,
        () => revision === dispatchRevision,
      );
    } finally {
      // 复位不依赖 captureZoomBackground 的 finally：revision 失效提前
      // return、capture 被拒等任何早退路径都经过本 finally，锁必然复位
      if (transitionLock) deps.uiLocked.set(false);
    }
  }

  /**
   * 开启缩放的截屏流程：提交在途笔画 → 隐藏 UI → capture → Blob URL → 置倍率。
   * isCurrent（六轮审查 P2-02）：capture 在途期间本 dispatch 可能已过期或
   * 延迟的穿透事件已把 isPenetrating 置 true——两种情况都不再提交 zoom/底图
   *（否则穿透 ∧ 缩放并存）；uiLocked 仍必须在 finally 复位。
   */
  async function captureZoomBackground(isCurrent?: () => boolean) {
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
      // 过期 dispatch 或截屏期间已进入穿透（延迟事件已把 isPenetrating
      // 置 true）：不提交 zoom 与底图（底图 Blob 在 setZoomBg 前未创建，
      // 此处直接放弃，无资源泄漏）
      const stale = (isCurrent && !isCurrent()) || isPenetrating.value;
      if (stale) return;
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
      // 失败提示仅当前 dispatch 有效且未处于穿透时弹：后端在穿透态拒绝
      // 截屏（InvalidState）是模式切换的正常结果，不是故障（七轮审查 P2-01）
      if ((!isCurrent || isCurrent()) && !isPenetrating.value) {
        deps.showToast(deps.t("action.captureFailed"));
      }
    } finally {
      deps.uiLocked.set(false);
      // 工具栏恢复仅当前 dispatch 有效：过期时恢复 prevToolbar 会覆盖
      // 新操作已写入的工具栏状态。恢复值还须尊重穿透状态——穿透事件
      // 不改变 revision，截屏在途期间的穿透切换（rAF 等待在模式锁外，
      // 租约未建立）已把工具栏同步为隐藏，迟到的恢复不得重新显示
      //（七轮审查 P2-01）
      if (!isCurrent || isCurrent()) {
        showToolbar.value = isPenetrating.value ? false : prevToolbar;
      }
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

  /** 使所有在途 dispatch 失效（六轮审查 P2-01）：resetModes 与退出标注是
   * 会话级重置，之后恢复执行的旧 dispatch 不得再提交任何副作用——
   * Hidden 守卫是状态条件保护而非代际保护，clear-drawing 不改模式，
   * 管不住"模式仍是 Drawing 时迟到的 set_board_active(true)" */
  function invalidatePendingDispatches() {
    dispatchRevision += 1;
  }

  /** 复位叠加态（随清屏与模式切换一起重置），板书/缩放/聚光灯全部退回 */
  function resetModes() {
    // 先失效在途 dispatch 再复位状态（clear-drawing / drawing / hidden
    // 事件三个入口共享本函数）
    invalidatePendingDispatches();
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

  /** 卸载清理：先失效在途 dispatch（卸载后恢复执行的截屏流程不得再创建
   * Blob URL——组件已销毁，无人再做第二次释放；HMR/WebView 重载场景），
   * 再释放缩放底图 Blob URL（七轮审查 P3） */
  function dispose() {
    invalidatePendingDispatches();
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
    // 工具栏退出按钮：先使在途 dispatch 失效（终态操作不得被迟到 effect
    // 干扰），再走退出流程。输入锁自检（九轮审查 P2）：过渡锁窗口内
    // 工具栏仍渲染（乐观 showToolbar=true），Exit 点击不得绕过锁触发
    // exit_drawing——该路径与 QA Hidden 同根，仅触发设备不同
    exitAnnotation: () => {
      if (deps.uiLocked.get()) return;
      invalidatePendingDispatches();
      return runEffects([{ type: "invokeExitAnnotation" }], false);
    },
    toggleToolbarWithSpace,
    onWheel,
    resetModes,
    syncPenetrationFromBackend,
    dispose,
  };
}
