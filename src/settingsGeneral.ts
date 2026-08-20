import type { GeneralConfig } from "./configTypes";

/** 设置窗口"常规设置"表单状态（与 save_general 载荷一一对应） */
export interface GeneralFormState {
  locale: string;
  theme: string;
  preserveDrawings: boolean;
  lineWidths: { stroke: number; highlighter: number; eraser: number };
  defaultTool: GeneralConfig["defaultTool"];
  defaultColor: string;
  boardDefault: "white" | "black";
  openSettingsOnStartup: boolean;
  exportDir: string | null;
}

/**
 * 构造 save_general 载荷。
 * 独立成纯函数以便单测锁定：必须发送表单中的实际值（locale/theme/
 * preserveDrawings 等），不得回退到硬编码默认值覆盖 config.json。
 */
export function buildGeneralPayload(state: GeneralFormState): GeneralConfig {
  return {
    locale: state.locale,
    theme: state.theme,
    preserveDrawings: state.preserveDrawings,
    lineWidths: { ...state.lineWidths },
    defaultTool: state.defaultTool,
    defaultColor: state.defaultColor,
    boardDefault: state.boardDefault,
    openSettingsOnStartup: state.openSettingsOnStartup,
    exportDir: state.exportDir,
  };
}
