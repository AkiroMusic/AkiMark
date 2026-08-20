import { describe, it, expect } from "vitest";
import { TOOL_DEFS, WIDTH_MAX } from "./tools";

describe("TOOL_DEFS 工具顺序契约", () => {
  it("渐隐笔紧随画笔之后（index 1）", () => {
    expect(TOOL_DEFS[0].id).toBe("pen");
    expect(TOOL_DEFS[1].id).toBe("fading");
  });

  it("包含全部 10 个工具 id", () => {
    const ids = TOOL_DEFS.map((def) => def.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids)).toEqual(
      new Set([
        "pen",
        "fading",
        "highlighter",
        "eraser",
        "line",
        "rect",
        "circle",
        "arrow",
        "text",
        "blur",
      ]),
    );
  });

  it("快捷键唯一，且恰为 1-9、0", () => {
    const hotkeys = TOOL_DEFS.map((def) => def.hotkey);
    expect(new Set(hotkeys).size).toBe(hotkeys.length);
    expect(new Set(hotkeys)).toEqual(
      new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]),
    );
  });
});

describe("WIDTH_MAX 线宽上限契约", () => {
  it("I1: 各线宽分组上限与设置窗口滑块一致（40/80/120）", () => {
    expect(WIDTH_MAX.stroke).toBe(40);
    expect(WIDTH_MAX.highlighter).toBe(80);
    expect(WIDTH_MAX.eraser).toBe(120);
  });

  it("I1: 工具栏 +/- 钳制按分组取上限（荧光笔可到 80、橡皮可到 120）", () => {
    // 工具栏 changeWidth 使用 WIDTH_MAX[TOOL_WIDTH_GROUP[tool]] 钳制，
    // 此处锁定常量契约，防止回归到统一 40 上限
    expect(WIDTH_MAX.highlighter).toBeGreaterThan(WIDTH_MAX.stroke);
    expect(WIDTH_MAX.eraser).toBeGreaterThan(WIDTH_MAX.highlighter);
  });
});
