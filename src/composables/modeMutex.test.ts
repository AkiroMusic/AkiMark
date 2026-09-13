import { describe, expect, it } from "vitest";
import { applyModeAction, type ModeState } from "./modeMutex";

const base: ModeState = {
  board: "none",
  zoom: 0,
  spotlight: false,
  penetrating: false,
  toolbarVisible: true,
};

const opts = { boardDefault: "white" as const };

function act(
  overrides: Partial<ModeState>,
  action: Parameters<typeof applyModeAction>[1],
) {
  return applyModeAction({ ...base, ...overrides }, action, opts);
}

describe("modeMutex 模式互斥规则", () => {
  it("板书拦截缩放：toast 提示，状态不变", () => {
    const { state, effects } = act({ board: "black" }, { type: "toggleZoom" });
    expect(state).toEqual({ ...base, board: "black" });
    expect(effects).toEqual([{ type: "toast", key: "zoomInBoard" }]);
  });

  it("板书拦截穿透：toast 提示，状态不变", () => {
    const { state, effects } = act(
      { board: "white" },
      { type: "togglePenetration" },
    );
    expect(state.board).toBe("white");
    expect(state.penetrating).toBe(false);
    expect(effects).toEqual([{ type: "toast", key: "penetrateInBoard" }]);
  });

  it("开启缩放：退出聚光灯；穿透中则退穿透并显示工具栏", () => {
    const { state, effects } = act(
      { spotlight: true, penetrating: true },
      { type: "toggleZoom" },
    );
    expect(state.spotlight).toBe(false);
    expect(state.penetrating).toBe(false);
    expect(state.toolbarVisible).toBe(true);
    expect(effects).toEqual([
      { type: "invokeExitPenetration" },
      { type: "zoomCapture" },
    ]);
  });

  it("关闭缩放：zoom 归零并释放底图", () => {
    const { state, effects } = act({ zoom: 4 }, { type: "toggleZoom" });
    expect(state.zoom).toBe(0);
    expect(effects).toEqual([{ type: "exitZoom", clearBackground: true }]);
  });

  it("开启聚光灯：退出缩放但不释放底图（既有行为）", () => {
    const { state, effects } = act({ zoom: 8 }, { type: "toggleSpotlight" });
    expect(state.spotlight).toBe(true);
    expect(state.zoom).toBe(0);
    expect(effects).toEqual([
      { type: "exitZoom", clearBackground: false },
      { type: "toast", key: "spotlight" },
    ]);
  });

  it("关闭聚光灯：仅翻转，无其他效果", () => {
    const { state, effects } = act(
      { spotlight: true },
      { type: "toggleSpotlight" },
    );
    expect(state.spotlight).toBe(false);
    expect(effects).toEqual([]);
  });

  it("进入板书（默认白板）：退缩放、退穿透、置板书底色、同步后端", () => {
    const { state, effects } = act(
      { zoom: 4, penetrating: true },
      { type: "toggleBoard" },
    );
    expect(state.board).toBe("white");
    expect(state.zoom).toBe(0);
    expect(state.penetrating).toBe(false);
    expect(state.toolbarVisible).toBe(true);
    expect(effects).toEqual([
      { type: "exitZoom", clearBackground: false },
      { type: "invokeExitPenetration" },
      { type: "setBoardColor", color: "white" },
      { type: "toast", key: "boardWhite" },
      { type: "setBoardActive", active: true },
    ]);
  });

  it("黑板配置时进入板书用黑色", () => {
    const { state, effects } = applyModeAction(
      base,
      { type: "toggleBoard" },
      { boardDefault: "black" },
    );
    expect(state.board).toBe("black");
    expect(effects).toContainEqual({ type: "setBoardColor", color: "black" });
    expect(effects).toContainEqual({ type: "toast", key: "boardBlack" });
  });

  it("退出板书：清板书底色、后端标志复位", () => {
    const { state, effects } = act({ board: "white" }, { type: "toggleBoard" });
    expect(state.board).toBe("none");
    expect(effects).toEqual([
      { type: "setBoardColor", color: null },
      { type: "setBoardActive", active: false },
    ]);
  });

  it("进入穿透：退缩放、发 enter invoke（乐观翻转，回滚在执行端）", () => {
    const { state, effects } = act({ zoom: 2 }, { type: "togglePenetration" });
    expect(state.penetrating).toBe(true);
    expect(state.zoom).toBe(0);
    expect(effects).toEqual([
      { type: "exitZoom", clearBackground: false },
      { type: "invokeEnterPenetration" },
    ]);
  });

  it("空格：穿透中退出穿透并显示工具栏；否则仅翻转工具栏", () => {
    const a = act({ penetrating: true }, { type: "toggleToolbar" });
    expect(a.state.penetrating).toBe(false);
    expect(a.state.toolbarVisible).toBe(true);
    expect(a.effects).toEqual([{ type: "invokeExitPenetration" }]);

    const b = act({ toolbarVisible: false }, { type: "toggleToolbar" });
    expect(b.state.toolbarVisible).toBe(true);
    expect(b.effects).toEqual([]);
  });

  it("Esc 逐级退出次序：缩放 → 聚光灯 → 板书 → 退出标注", () => {
    // 缩放+聚光灯同开（可达态：开聚光灯后开缩放会退聚光灯，但缩放中可再开聚光灯外的层级；
    // 这里构造缩开+聚光灯残留）：先退缩放，聚光灯保留
    const all = act({ zoom: 4, spotlight: true }, { type: "stepBack" });
    expect(all.state.zoom).toBe(0);
    expect(all.state.spotlight).toBe(true);
    expect(all.effects).toEqual([{ type: "exitZoom", clearBackground: true }]);

    // 无缩放：退聚光灯
    const spot = act({ spotlight: true, board: "white" }, { type: "stepBack" });
    expect(spot.state.spotlight).toBe(false);
    expect(spot.state.board).toBe("white");

    // 无缩放/聚光灯：退板书
    const board = act({ board: "black" }, { type: "stepBack" });
    expect(board.state.board).toBe("none");

    // 全关：退出标注
    const none = act({}, { type: "stepBack" });
    expect(none.effects).toEqual([{ type: "invokeExitAnnotation" }]);
  });
});
