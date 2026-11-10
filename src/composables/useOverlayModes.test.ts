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
});
