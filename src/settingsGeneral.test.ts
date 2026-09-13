import { describe, it, expect } from "vitest";
import { buildGeneralPayload } from "./settingsGeneral";

describe("buildGeneralPayload", () => {
  it("I2: 发送配置中的实际 locale/preserveDrawings，而非硬编码默认值", () => {
    const payload = buildGeneralPayload({
      locale: "en",
      preserveDrawings: true,
      lineWidths: { stroke: 3, highlighter: 10, eraser: 12 },
      defaultTool: "pen",
      defaultColor: "#6C8CFF",
      boardDefault: "white",
      recentColors: ["#123456"],
      openSettingsOnStartup: false,
      exportDir: null,
    });
    expect(payload.locale).toBe("en");
    expect(payload.preserveDrawings).toBe(true);
    expect(payload.recentColors).toEqual(["#123456"]);
    expect(payload.openSettingsOnStartup).toBe(false);
    expect(payload.lineWidths).toEqual({
      stroke: 3,
      highlighter: 10,
      eraser: 12,
    });
  });

  it("I2: 默认值兜底（zh-CN / false）与 config.json 示例一致", () => {
    const payload = buildGeneralPayload({
      locale: "zh-CN",
      preserveDrawings: false,
      lineWidths: { stroke: 3, highlighter: 10, eraser: 12 },
      defaultTool: "pen",
      defaultColor: "#6C8CFF",
      boardDefault: "white",
      recentColors: [],
      openSettingsOnStartup: true,
      exportDir: null,
    });
    expect(payload.locale).toBe("zh-CN");
    expect(payload.preserveDrawings).toBe(false);
  });

  it("I2: recentColors 透传不被截断/去重（由调用方管理内容）", () => {
    const payload = buildGeneralPayload({
      locale: "zh-CN",
      preserveDrawings: false,
      lineWidths: { stroke: 3, highlighter: 10, eraser: 12 },
      defaultTool: "pen",
      defaultColor: "#6C8CFF",
      boardDefault: "white",
      recentColors: ["#a1b2c3", "#d4e5f6", "#fff000", "#0f0f0f"],
      openSettingsOnStartup: true,
      exportDir: null,
    });
    expect(payload.recentColors).toHaveLength(4);
    expect(payload.recentColors[0]).toBe("#a1b2c3");
  });
});
