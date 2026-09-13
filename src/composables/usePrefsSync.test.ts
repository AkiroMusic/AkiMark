// @vitest-environment happy-dom
// （usePrefsSync 的守卫定时器走 window.setTimeout，需 DOM 全局）
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ref } from "vue";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({})),
}));

import { invoke } from "@tauri-apps/api/core";
import { usePrefsSync } from "./usePrefsSync";
import type { AppConfig } from "../configTypes";
import type { useDrawing } from "./useDrawing";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

function makeConfig(stroke: number): AppConfig {
  return {
    shortcuts: {
      toggleDrawing: "Ctrl+Shift+R",
      clearDrawing: "Ctrl+Shift+C",
      togglePenetration: "Ctrl+Shift+X",
    },
    general: {
      locale: "zh-CN",
      preserveDrawings: false,
      lineWidths: { stroke, highlighter: 10, eraser: 12 },
      defaultTool: "pen",
      defaultColor: "#6C8CFF",
      boardDefault: "white",
      recentColors: [],
      openSettingsOnStartup: true,
      exportDir: null,
    },
  };
}

function makeDrawingMock() {
  return {
    currentTool: ref("pen"),
    currentColor: ref("#6C8CFF"),
    lineWidths: ref({ stroke: 3, highlighter: 10, eraser: 12 }),
  } as unknown as ReturnType<typeof useDrawing>;
}

function setup() {
  const drawing = makeDrawingMock();
  const boardDefault = ref<"white" | "black">("white");
  const setLocale = vi.fn();
  const prefs = usePrefsSync({ drawing, boardDefault, setLocale });
  return { drawing, boardDefault, setLocale, prefs };
}

describe("usePrefsSync 基线比对与按需落盘", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    vi.useFakeTimers();
  });

  it("启动 applyConfig 记录基线；相同预设的广播不触碰会话", () => {
    const { drawing, prefs } = setup();
    prefs.applyConfig(makeConfig(3));
    // 相同预设广播（如用户改了无关设置）
    prefs.applyConfigUpdate(makeConfig(3));
    expect(drawing.lineWidths.value.stroke).toBe(3);
  });

  it("I3: 设置侧改线宽（config-changed ≠ 基线）→ 实时采纳进会话", () => {
    const { drawing, prefs } = setup();
    prefs.applyConfig(makeConfig(3));
    // 用户在设置窗口把画笔调到 28 并保存 → 广播
    prefs.applyConfigUpdate(makeConfig(28));
    expect(drawing.lineWidths.value.stroke).toBe(28);
  });

  it("I3: 无用户改动时退出兜底不落盘（防陈旧会话覆盖设置侧保存）", async () => {
    const { prefs } = setup();
    prefs.applyConfig(makeConfig(3));
    prefs.flushPrefsSave();
    await vi.runAllTimersAsync();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("I3: 有用户改动时防抖落盘，且落盘后基线推进（同值广播不再触发）", async () => {
    const { drawing, prefs } = setup();
    prefs.applyConfig(makeConfig(3));
    drawing.lineWidths.value = { stroke: 7, highlighter: 10, eraser: 12 };
    prefs.schedulePrefsSave();
    await vi.runAllTimersAsync();
    expect(invokeMock).toHaveBeenCalledWith(
      "save_drawing_prefs",
      expect.objectContaining({
        tool: "pen",
        recentColors: [],
      }),
    );
    // 落盘成功后基线=7：相同值广播视为无关，不重复采纳/回写
    invokeMock.mockClear();
    prefs.applyConfigUpdate(makeConfig(7));
    prefs.flushPrefsSave();
    await vi.runAllTimersAsync();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(drawing.lineWidths.value.stroke).toBe(7);
  });
});
