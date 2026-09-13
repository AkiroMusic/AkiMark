/**
 * 模式互斥规则（板书 / 缩放 / 聚光灯 / 穿透 / 工具栏）的纯函数编码。
 *
 * 此前这些规则散落在 toggleZoom / toggleSpotlight / cycleBoard /
 * togglePenetration / toggleToolbarWithSpace / onKeyDown(Esc) 六处，靠人工保持
 * 一致。收敛为纯函数后由单测锁定，组件层只负责执行 effects（invoke/toast/截屏）。
 *
 * 铁律：完全编码既有行为（含怪癖），不做语义"顺手优化"。
 * 异步副作用（截屏、invoke 成功后的 UI 收尾）不在此层——见各 effect 注释。
 */

export type BoardMode = "none" | "white" | "black";

/** 模式层的同步状态（DrawingOverlay 各 ref 的快照） */
export interface ModeState {
  board: BoardMode;
  /** 缩放倍率；0 = 关闭 */
  zoom: number;
  spotlight: boolean;
  penetrating: boolean;
  toolbarVisible: boolean;
}

/** toast 的 i18n key 后缀（执行端拼 `action.${key}`） */
export type ToastKey =
  | "zoomInBoard"
  | "penetrateInBoard"
  | "spotlight"
  | "boardWhite"
  | "boardBlack";

export type ModeEffect =
  | { type: "toast"; key: ToastKey }
  /** 进/出穿透的 invoke。togglePenetration 路径须 await 并处理回滚；其余路径 fire-and-forget */
  | { type: "invokeEnterPenetration" }
  | { type: "invokeExitPenetration" }
  /** 同步后端板书标志（板书期间拒绝穿透的全局兜底） */
  | { type: "setBoardActive"; active: boolean }
  /** 马赛克底色切换（板书纯色底 / 退板书回截屏底） */
  | { type: "setBoardColor"; color: "white" | "black" | null }
  /** 退出缩放：清锚点；clearBackground 时一并释放底图（与既有行为逐路径一致） */
  | { type: "exitZoom"; clearBackground: boolean }
  /** 开启缩放的异步截屏流程（隐藏 UI → capture_screen → 置 zoom/底图，失败 toast） */
  | { type: "zoomCapture" }
  /** Esc 最终级：退出标注模式 */
  | { type: "invokeExitAnnotation" };

export type ModeAction =
  | { type: "toggleZoom" }
  | { type: "toggleSpotlight" }
  | { type: "toggleBoard" }
  | { type: "togglePenetration" }
  | { type: "toggleToolbar" }
  /** Esc 逐级退出：缩放 → 聚光灯 → 板书 → 退出标注 */
  | { type: "stepBack" };

export interface ModeOptions {
  /** 配置的默认板书底色（none ⇄ boardDefault 一步直达） */
  boardDefault: "white" | "black";
}

export function applyModeAction(
  state: ModeState,
  action: ModeAction,
  opts: ModeOptions,
): { state: ModeState; effects: ModeEffect[] } {
  switch (action.type) {
    case "toggleZoom": {
      // 板书与缩放互斥：缩放底图是真实屏幕，会穿透板书纯色底
      if (state.board !== "none") {
        return { state, effects: [{ type: "toast", key: "zoomInBoard" }] };
      }
      if (state.zoom > 0) {
        return {
          state: { ...state, zoom: 0 },
          effects: [{ type: "exitZoom", clearBackground: true }],
        };
      }
      // 开启：退出聚光灯与穿透（滚轮回归"切换倍率"职责）；
      // 穿透退出后工具栏可见（既有行为），截屏流程由执行端收尾
      const next: ModeState = { ...state, spotlight: false };
      const effects: ModeEffect[] = [];
      if (next.penetrating) {
        next.penetrating = false;
        next.toolbarVisible = true;
        effects.push({ type: "invokeExitPenetration" });
      }
      effects.push({ type: "zoomCapture" });
      return { state: next, effects };
    }

    case "toggleSpotlight": {
      const next: ModeState = { ...state, spotlight: !state.spotlight };
      if (next.spotlight) {
        // 聚光灯与缩放互斥：滚轮回归"调节半径"职责。
        // 既有行为只清锚点不释放底图（zoom=0 时底图本就不显示）
        next.zoom = 0;
        return {
          state: next,
          effects: [
            { type: "exitZoom", clearBackground: false },
            { type: "toast", key: "spotlight" },
          ],
        };
      }
      return { state: next, effects: [] };
    }

    case "toggleBoard": {
      // none ⇄ boardDefault 一步直达（不循环两色）
      const board: BoardMode =
        state.board === "none" ? opts.boardDefault : "none";
      const next: ModeState = { ...state, board };
      const effects: ModeEffect[] = [];
      if (board !== "none") {
        // 板书是"专注书写"场景：与缩放/穿透互斥
        next.zoom = 0;
        effects.push({ type: "exitZoom", clearBackground: false });
        if (next.penetrating) {
          next.penetrating = false;
          next.toolbarVisible = true;
          effects.push({ type: "invokeExitPenetration" });
        }
        effects.push({ type: "setBoardColor", color: board });
        effects.push({
          type: "toast",
          key: board === "white" ? "boardWhite" : "boardBlack",
        });
      } else {
        // 退板书：清除纯色底，马赛克笔下次使用时重新截屏
        effects.push({ type: "setBoardColor", color: null });
      }
      effects.push({ type: "setBoardActive", active: board !== "none" });
      return { state: next, effects };
    }

    case "togglePenetration": {
      // 板书期间穿透不可用（后端 set_board_active 兜底全局热键/自动穿透）
      if (state.board !== "none") {
        return { state, effects: [{ type: "toast", key: "penetrateInBoard" }] };
      }
      const next: ModeState = { ...state, penetrating: !state.penetrating };
      const effects: ModeEffect[] = [];
      if (next.penetrating) {
        // 穿透与缩放互斥（冻结放大画面会挡住下方应用）；
        // 聚光灯是纯视觉叠加，可随穿透保留做"激光笔"
        next.zoom = 0;
        effects.push({ type: "exitZoom", clearBackground: false });
        effects.push({ type: "invokeEnterPenetration" });
      } else {
        effects.push({ type: "invokeExitPenetration" });
      }
      return { state: next, effects };
    }

    case "toggleToolbar": {
      // 穿透中工具栏无法交互：显式退出穿透并显示工具栏，保证可见可点
      if (state.penetrating) {
        return {
          state: { ...state, penetrating: false, toolbarVisible: true },
          effects: [{ type: "invokeExitPenetration" }],
        };
      }
      return {
        state: { ...state, toolbarVisible: !state.toolbarVisible },
        effects: [],
      };
    }

    case "stepBack": {
      if (state.zoom > 0)
        return applyModeAction(state, { type: "toggleZoom" }, opts);
      if (state.spotlight)
        return applyModeAction(state, { type: "toggleSpotlight" }, opts);
      if (state.board !== "none")
        return applyModeAction(state, { type: "toggleBoard" }, opts);
      return { state, effects: [{ type: "invokeExitAnnotation" }] };
    }
  }
}
