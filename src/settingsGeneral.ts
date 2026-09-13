import type { GeneralConfig } from "./configTypes";

/** 设置窗口"常规设置"表单状态（与 save_general 载荷一一对应） */
export interface GeneralFormState {
  locale: string;
  preserveDrawings: boolean;
  lineWidths: { stroke: number; highlighter: number; eraser: number };
  defaultTool: GeneralConfig["defaultTool"];
  defaultColor: string;
  boardDefault: "white" | "black";
  /** 最近自定义色（设置表单不编辑，仅透传，避免 save_general 时被清空） */
  recentColors: string[];
  openSettingsOnStartup: boolean;
  exportDir: string | null;
}

/**
 * 构造 save_general 载荷。
 * 独立成纯函数以便单测锁定：必须发送表单中的实际值（locale/
 * preserveDrawings 等），不得回退到硬编码默认值覆盖 config.json。
 */
export function buildGeneralPayload(state: GeneralFormState): GeneralConfig {
  return {
    locale: state.locale,
    preserveDrawings: state.preserveDrawings,
    lineWidths: { ...state.lineWidths },
    defaultTool: state.defaultTool,
    defaultColor: state.defaultColor,
    boardDefault: state.boardDefault,
    recentColors: [...state.recentColors],
    openSettingsOnStartup: state.openSettingsOnStartup,
    exportDir: state.exportDir,
  };
}
