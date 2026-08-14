import { describe, it, expect } from "vitest";
import { TOOL_DEFS } from "./tools";

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
