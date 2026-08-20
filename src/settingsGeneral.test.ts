import { describe, it, expect } from "vitest";
import { buildGeneralPayload } from "./settingsGeneral";

describe("buildGeneralPayload", () => {
  it("I2: 发送配置中的实际 locale/theme/preserveDrawings，而非硬编码默认值", () => {
    const payload = buildGeneralPayload({
      locale: "en",
      theme: "light",
      preserveDrawings: true,
      lineWidths: { stroke: 3, highlighter: 10, eraser: 12 },
      defaultTool: "pen",
      defaultColor: "#6C8CFF",
      boardDefault: "white",
      openSettingsOnStartup: false,
      exportDir: null,
    });
    expect(payload.locale).toBe("en");
    expect(payload.theme).toBe("light");
    expect(payload.preserveDrawings).toBe(true);
    expect(payload.openSettingsOnStartup).toBe(false);
    expect(payload.lineWidths).toEqual({
      stroke: 3,
      highlighter: 10,
      eraser: 12,
    });
  });

  it("I2: 默认值兜底（zh-CN / dark / false）与 config.json 示例一致", () => {
    const payload = buildGeneralPayload({
      locale: "zh-CN",
      theme: "dark",
      preserveDrawings: false,
      lineWidths: { stroke: 3, highlighter: 10, eraser: 12 },
      defaultTool: "pen",
      defaultColor: "#6C8CFF",
      boardDefault: "white",
      openSettingsOnStartup: true,
      exportDir: null,
    });
    expect(payload.locale).toBe("zh-CN");
    expect(payload.theme).toBe("dark");
    expect(payload.preserveDrawings).toBe(false);
  });
});
