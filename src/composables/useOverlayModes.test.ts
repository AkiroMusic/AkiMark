// @vitest-environment happy-dom
// （toast 定时器走 window.setTimeout，需 DOM 全局）
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ref } from "vue";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({})),
}));

import { invoke } from "@tauri-apps/api/core";
import { useOverlayModes } from "./useOverlayModes";
import { BOARD_COLORS } from "../constants/tools";
import type { useDrawing } from "./useDrawing";
import type { Ref } from "vue";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

type TextEditing = Ref<{
  x: number;
  y: number;
  value: string;
  anchor: { x: number; y: number } | null;
} | null>;

function setup(overrides: { beforeCapture?: () => void } = {}) {
  const drawing = {
    setBlurBaseColor: vi.fn(),
  } as unknown as ReturnType<typeof useDrawing>;
  const showToast = vi.fn();
  const t = (key: string) => key;
  const uiLocked = { value: false };
  const textEditing: TextEditing = ref(null);
  const boardDefault = ref<"white" | "black">("white");
  const strokeActive = ref(false);
  const modes = useOverlayModes({
    drawing,
    showToast,
    t,
    uiLocked: {
      get: () => uiLocked.value,
      set: (v: boolean) => {
        uiLocked.value = v;
      },
    },
    textEditing,
    boardDefault,
    strokeActive,
    ...overrides,
  });
  return { modes, showToast, uiLocked, drawing };
}

/** 把 invoke 变成可控延迟：cmd → 手动 resolve 的 Promise */
function holdInvoke(...cmds: string[]) {
  const resolvers: Array<(v: unknown) => void> = [];
  invokeMock.mockImplementation((cmd: string) => {
    if (cmds.includes(cmd)) {
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    }
    return Promise.resolve({});
  });
  return {
    resolvers,
    releaseAll() {
      while (resolvers.length) resolvers.shift()?.(undefined);
    },
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => ({}));
  vi.useFakeTimers();
  // captureZoomBackground 等一帧再截屏：fake timers 不含 rAF，
  // 同步执行让该 await 立即完成（生产语义不受影响）
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useOverlayModes 异步副作用串行化（二轮审查）", () => {
  it("toggleBoard 等待 set_board_active 完成才返回", async () => {
    const hold = holdInvoke("set_board_active");
    const { modes } = setup();
    let done = false;
    const p = modes.cycleBoard().then(() => {
      done = true;
    });
    // invoke 在途时 dispatch 尚未完成
    await Promise.resolve();
    expect(done).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("set_board_active", {
      active: true,
    });
    hold.releaseAll();
    await p;
    expect(done).toBe(true);
  });

  it("板书进行中触发穿透：互斥裁决拒绝，不发起 enter invoke", async () => {
    const { modes } = setup();
    await modes.cycleBoard(); // 进入板书（默认 white）
    invokeMock.mockClear();
    await modes.togglePenetration();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "enter_penetration_mode",
      expect.anything(),
    );
    expect(modes.isPenetrating.value).toBe(false);
    expect(modes.boardMode.value).toBe("white");
  });

  it("退出穿透成功后工具栏恢复可见（此前共用分支无条件隐藏）", async () => {
    const { modes } = setup();
    await modes.togglePenetration(); // 进入穿透 → 工具栏隐藏
    expect(modes.showToolbar.value).toBe(false);
    await modes.togglePenetration(); // 退出穿透 → 工具栏恢复
    expect(modes.showToolbar.value).toBe(true);
    expect(modes.isPenetrating.value).toBe(false);
  });

  it("穿透态开启缩放：先等退出穿透完成，再截屏，最后才置倍率", async () => {
    const { modes } = setup();
    await modes.togglePenetration();
    expect(modes.isPenetrating.value).toBe(true);

    let captureDone = false;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "exit_penetration_mode") {
        return new Promise((resolve) => {
          setTimeout(() => resolve({}), 100);
        });
      }
      if (cmd === "capture_screen") {
        return new Promise((resolve) => {
          setTimeout(() => {
            captureDone = true;
            resolve("c2NyZWVu");
          }, 50);
        });
      }
      return Promise.resolve({});
    });

    const zoomPromise = modes.toggleZoom();
    // 推进到 exit 完成、capture 在途：zoom 仍为 0
    await vi.advanceTimersByTimeAsync(100);
    expect(modes.zoom.value).toBe(0);
    expect(captureDone).toBe(false);
    // capture 完成 → 链式副作用收尾 → 置倍率
    await vi.advanceTimersByTimeAsync(50);
    await zoomPromise;
    expect(captureDone).toBe(true);
    expect(modes.zoom.value).toBe(2);
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    const exitIdx = cmds.indexOf("exit_penetration_mode");
    const captureIdx = cmds.indexOf("capture_screen");
    expect(exitIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeGreaterThan(exitIdx);
  });

  it("beforeCapture 在截屏前被调用（缩放入口统一提交在途笔画）", async () => {
    const beforeCapture = vi.fn();
    const { modes } = setup({ beforeCapture });
    await modes.toggleZoom();
    expect(beforeCapture).toHaveBeenCalledTimes(1);
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("capture_screen");
  });

  it("穿透 invoke 失败：回滚乐观翻转并 toast（togglePenetration 路径）", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "enter_penetration_mode"
        ? Promise.reject(new Error("os failed"))
        : Promise.resolve({}),
    );
    const { modes, showToast } = setup();
    await modes.togglePenetration();
    expect(modes.isPenetrating.value).toBe(false);
    expect(showToast).toHaveBeenCalled();
  });

  it("set_board_active 失败：回滚 boardMode 与马赛克底色（三轮审查 P2-01）", async () => {
    let failBoard = false;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "set_board_active" && failBoard
        ? Promise.reject(new Error("ipc failed"))
        : Promise.resolve({}),
    );
    const { modes, drawing } = setup();
    await modes.cycleBoard(); // IPC 成功：进入板书
    expect(modes.boardMode.value).toBe("white");
    failBoard = true;
    await modes.cycleBoard(); // 退出板书 IPC 失败 → 回滚为板书中
    expect(modes.boardMode.value).toBe("white");
    expect(drawing.setBlurBaseColor).toHaveBeenLastCalledWith(
      BOARD_COLORS.white,
    );
    failBoard = false;
    await modes.cycleBoard(); // 恢复后正常退出
    expect(modes.boardMode.value).toBe("none");
    expect(drawing.setBlurBaseColor).toHaveBeenLastCalledWith(null);
  });

  it("穿透中开板书且退出穿透+置位双失败：板书与穿透 UI 全部回滚（四轮审查 P2-01）", async () => {
    // 后端语义：退出穿透失败时 set_board_active 拒绝置位 → 二者同败，
    // 后端仍是穿透态 → 前端除板书外还要恢复 isPenetrating / showToolbar
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "exit_penetration_mode" || cmd === "set_board_active"
        ? Promise.reject(new Error("os failed"))
        : Promise.resolve({}),
    );
    const { modes, drawing } = setup();
    await modes.togglePenetration(); // 进入穿透成功
    expect(modes.isPenetrating.value).toBe(true);
    expect(modes.showToolbar.value).toBe(false);
    await modes.cycleBoard(); // 开板书：退出穿透失败 → 置位被拒
    expect(modes.boardMode.value).toBe("none");
    expect(drawing.setBlurBaseColor).toHaveBeenLastCalledWith(null);
    expect(modes.isPenetrating.value).toBe(true);
    expect(modes.showToolbar.value).toBe(false);
  });

  it("穿透中 B×2 在 await 点交错：过期 dispatch 不再提交板书（五轮审查 P2-01）", async () => {
    const { modes, drawing } = setup();
    await modes.togglePenetration(); // 进入穿透
    invokeMock.mockClear();
    // 第一次 B（开板书）：退出穿透 IPC 挂起，dispatch 在 await 点停住
    const hold = holdInvoke("exit_penetration_mode");
    const first = modes.cycleBoard();
    await Promise.resolve();
    await Promise.resolve(); // 让第一次 dispatch 推进到 await exit_penetration
    expect(invokeMock).toHaveBeenCalledWith("exit_penetration_mode");
    invokeMock.mockClear();
    // 第二次 B（关板书）：在第一次恢复前完整执行（set_board_active 正常返回）
    await modes.cycleBoard();
    expect(modes.boardMode.value).toBe("none");
    expect(invokeMock).toHaveBeenCalledWith("set_board_active", {
      active: false,
    });
    // 释放第一次的退出穿透：旧 dispatch 恢复后必须止步——
    // 不得再发 set_board_active(true)，也不得把底色刷回 white
    const callsBeforeRelease = invokeMock.mock.calls.length;
    hold.releaseAll();
    await first;
    const newBoardCalls = invokeMock.mock.calls
      .slice(callsBeforeRelease)
      .filter((c) => c[0] === "set_board_active");
    expect(newBoardCalls).toEqual([]);
    expect(drawing.setBlurBaseColor).toHaveBeenLastCalledWith(null);
    expect(modes.boardMode.value).toBe("none");
  });

  it("B 挂起时 resetModes（清屏/会话重置）：旧 dispatch 失效不再提交板书（六轮审查 P2-01）", async () => {
    const { modes, drawing } = setup();
    await modes.togglePenetration(); // 进入穿透
    invokeMock.mockClear();
    // 第一次 B（开板书）：退出穿透 IPC 挂起
    const hold = holdInvoke("exit_penetration_mode");
    const first = modes.cycleBoard();
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith("exit_penetration_mode");
    invokeMock.mockClear();
    // clear-drawing 路径触发 resetModes：直接复位状态并发 set_board_active(false)
    //（不经 dispatch revision——这正是需要 invalidatePendingDispatches 的原因）
    modes.resetModes();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledWith("set_board_active", {
      active: false,
    });
    invokeMock.mockClear();
    // 释放第一次的退出穿透：旧 dispatch 已被 resetModes 失效，必须止步
    hold.releaseAll();
    await first;
    const newBoardCalls = invokeMock.mock.calls.filter(
      (c) => c[0] === "set_board_active",
    );
    expect(newBoardCalls).toEqual([]); // 不得再发 set_board_active(true)
    expect(drawing.setBlurBaseColor).toHaveBeenLastCalledWith(null);
    expect(modes.boardMode.value).toBe("none");
  });

  it("穿透态 Space×2：旧 dispatch 的迟到成功不得重显工具栏（六轮审查 P2-01A）", async () => {
    const { modes } = setup();
    await modes.togglePenetration(); // 进入穿透：工具栏隐藏
    invokeMock.mockClear();
    // 第一次 Space：穿透态分支——乐观写 penetrating=false + 工具栏显示，
    // await exit_penetration_mode（挂起）
    const hold = holdInvoke("exit_penetration_mode");
    const first = modes.toggleToolbarWithSpace();
    await Promise.resolve();
    await Promise.resolve();
    expect(modes.showToolbar.value).toBe(true); // 乐观翻转
    expect(modes.isPenetrating.value).toBe(false); // 第一次已乐观写非穿透
    invokeMock.mockClear();
    // 第二次 Space：snapshot 已非穿透 → 普通切换 toolbarVisible→false，
    // 无 IPC 立即完成（GPT 时序：第二次操作把工具栏切隐藏）
    await modes.toggleToolbarWithSpace();
    expect(modes.showToolbar.value).toBe(false);
    // 释放第一次 IPC：过期 dispatch 的成功收尾（showToolbar=true）
    // 不得覆盖第二次写入的 false
    hold.releaseAll();
    await first;
    expect(modes.showToolbar.value).toBe(false);
    expect(modes.isPenetrating.value).toBe(false);
  });

  it("截屏在途时穿透事件先到：截图返回后不得重开缩放（六轮审查 P2-02）", async () => {
    const { modes } = setup();
    // 截图 IPC 挂起（返回有效 base64）
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "capture_screen"
        ? new Promise((resolve) => setTimeout(() => resolve("c2NyZWVu"), 50))
        : Promise.resolve({}),
    );
    void modes.toggleZoom(); // 开启缩放：进入截屏流程
    await vi.advanceTimersByTimeAsync(0); // rAF 同步桩：截屏 IPC 已在途
    expect(invokeMock).toHaveBeenCalledWith("capture_screen");
    // 截屏在途：延迟送达的穿透事件把穿透置 true、缩放清零
    modes.syncPenetrationFromBackend(true);
    expect(modes.zoom.value).toBe(0);
    expect(modes.isPenetrating.value).toBe(true);
    // 截图返回：旧流程不得重开 zoom（否则穿透 ∧ 缩放并存）
    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();
    expect(modes.zoom.value).toBe(0);
    expect(modes.isPenetrating.value).toBe(true);
  });

  it("rAF 期间穿透事件先到、截图被后端拒：finally 不得重显工具栏、不弹失败提示（七轮审查 P2-01）", async () => {
    const { modes, showToast } = setup();
    await modes.toggleToolbarWithSpace(); // 工具栏初始可见（prevToolbar=true）
    expect(modes.showToolbar.value).toBe(true);
    // 截图延迟 50ms 后被拒（模拟后端 ensure_capture_allowed 的 InvalidState）：
    // rAF 等待在模式锁外，穿透可在租约建立前进入
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "capture_screen"
        ? new Promise((_, reject) =>
            setTimeout(() => reject(new Error("InvalidState")), 50),
          )
        : Promise.resolve({}),
    );
    void modes.toggleZoom(); // 进入截屏流程：工具栏隐藏、uiLocked
    await vi.advanceTimersByTimeAsync(0); // rAF 同步桩：capture 在途
    // 截屏在途：穿透事件先到（后端 X 已进入穿透）
    modes.syncPenetrationFromBackend(true);
    expect(modes.showToolbar.value).toBe(false);
    expect(modes.zoom.value).toBe(0);
    // 截图返回失败：finally 不得把工具栏恢复为 prevToolbar=true 覆盖穿透
    // 同步；穿透态的拒绝是模式切换正常结果，不得弹"截图失败"
    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();
    expect(modes.showToolbar.value).toBe(false);
    expect(modes.isPenetrating.value).toBe(true);
    expect(modes.zoom.value).toBe(0);
    expect(showToast).not.toHaveBeenCalledWith("action.captureFailed");
  });

  it("dispose 使在途截屏流程失效：不再创建 Blob URL（七轮审查 P3）", async () => {
    const { modes } = setup();
    const hold = holdInvoke("capture_screen");
    void modes.toggleZoom();
    await Promise.resolve();
    await Promise.resolve(); // capture 在途
    modes.dispose(); // 组件卸载：失效在途 dispatch + 释放底图
    hold.releaseAll();
    await Promise.resolve();
    await Promise.resolve();
    // 卸载后恢复执行的截屏流程已 stale：不得写入 zoomBg / zoom
    expect(modes.zoomBg.value).toBeNull();
    expect(modes.zoom.value).toBe(0);
  });

  it("穿透态 M 过渡锁：退出穿透 IPC 在途期间 Esc 不得退出标注（八轮审查）", async () => {
    const { modes, uiLocked } = setup();
    await modes.togglePenetration(); // 进入穿透
    invokeMock.mockClear();
    // M：exit IPC 手动挂起；capture 返回有效 base64（延迟 50ms）
    let releaseExit: () => void = () => {};
    invokeMock.mockImplementation(
      (cmd: string) =>
        new Promise((resolve, reject) => {
          if (cmd === "exit_penetration_mode") {
            releaseExit = () => resolve({});
          } else if (cmd === "capture_screen") {
            setTimeout(() => resolve("c2NyZWVu"), 50);
          } else {
            resolve({});
          }
        }),
    );
    const zoom = modes.toggleZoom();
    await Promise.resolve();
    await Promise.resolve();
    // 过渡锁已在第一个 effect 之前生效：组件 onKeyDown 的 uiLocked 检查
    // 会拦截此窗口内的 Esc/X/B（QA Hidden 现象的根因窗口）
    expect(uiLocked.value).toBe(true);
    // 锁缺失时此窗口的 stepBack 会走 invokeExitAnnotation 退出整个标注：
    // dispatch 输入锁自检拒绝（GPT 指定断言：exit_drawing 零调用）
    await modes.stepBack();
    expect(invokeMock).not.toHaveBeenCalledWith("exit_drawing");
    // 释放退出穿透：缩放流程继续 → capture（fake timer 推进 50ms）→ zoom=2
    releaseExit();
    await vi.advanceTimersByTimeAsync(60);
    await zoom;
    expect(modes.zoom.value).toBe(2);
    expect(uiLocked.value).toBe(false);
  });

  it("非穿透态 M 不设过渡锁（capture 内部锁覆盖，行为不变）", async () => {
    const { modes, uiLocked } = setup();
    invokeMock.mockImplementation(
      (cmd: string) =>
        cmd === "capture_screen"
          ? new Promise((resolve) => setTimeout(() => resolve("c2NyZWVu"), 20))
          : Promise.resolve({}),
    );
    const zoom = modes.toggleZoom();
    await Promise.resolve();
    await Promise.resolve(); // rAF 后 capture 在途
    // captureZoomBackground 自己的锁生效（非 dispatch 过渡锁），
    // 但对外语义相同：uiLocked=true
    expect(uiLocked.value).toBe(true);
    await vi.advanceTimersByTimeAsync(30);
    await zoom;
    expect(uiLocked.value).toBe(false);
    expect(modes.zoom.value).toBe(2);
  });
});
