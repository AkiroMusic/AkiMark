import type { Tool } from "../composables/drawingTypes";

export interface ToolDef {
  id: Tool;
  /** 显示名（i18n key） */
  label: string;
  /** 快捷键数字键 */
  hotkey: string;
  /** 是否透明笔触（荧光笔） */
  translucent?: boolean;
}

export const TOOL_DEFS: ToolDef[] = [
  { id: "pen", label: "tool.pen", hotkey: "1" },
  {
    id: "highlighter",
    label: "tool.highlighter",
    hotkey: "2",
    translucent: true,
  },
  { id: "eraser", label: "tool.eraser", hotkey: "3" },
];

/** 线宽预设 */
export const WIDTH_PRESETS = [1, 2, 3, 5, 8];

/** 各工具线宽倍率（相对基础线宽） */
export const WIDTH_SCALE: Record<Tool, number> = {
  pen: 1,
  highlighter: 7,
  eraser: 8,
};

/** 荧光笔透明度 */
export const HIGHLIGHTER_OPACITY = 0.45;
export const PEN_OPACITY = 1;
export const ERASER_OPACITY = 1;

export function resolveLineWidths(
  widths: Record<Tool, number>,
): Record<Tool, number> {
  return {
    pen: widths.pen,
    highlighter: widths.highlighter,
    eraser: widths.eraser,
  };
}
