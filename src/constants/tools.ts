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
  { id: "line", label: "tool.line", hotkey: "4" },
  { id: "rect", label: "tool.rect", hotkey: "5" },
  { id: "circle", label: "tool.circle", hotkey: "6" },
  { id: "arrow", label: "tool.arrow", hotkey: "7" },
  { id: "text", label: "tool.text", hotkey: "8" },
  { id: "fading", label: "tool.fading", hotkey: "9" },
  { id: "blur", label: "tool.blur", hotkey: "0" },
];

/** 线宽预设 */
export const WIDTH_PRESETS = [1, 2, 3, 5, 8];

/** 渐隐笔完整渐隐周期（ms） */
export const FADE_DURATION_MS = 3000;

/** 马赛克笔最小格子（CSS px） */
export const BLUR_CELL_MIN = 3;

/** 各工具线宽倍率（相对基础线宽）。形状/文字沿用 stroke 组。 */
export const WIDTH_SCALE: Record<Tool, number> = {
  pen: 1,
  highlighter: 4,
  eraser: 5,
  line: 1,
  rect: 1,
  circle: 1,
  arrow: 1,
  text: 1,
  fading: 1,
  blur: 1,
};

/** 荧光笔透明度 */
export const HIGHLIGHTER_OPACITY = 0.45;
export const PEN_OPACITY = 1;
export const ERASER_OPACITY = 1;

/** 文字工具默认字号（px） */
export const TEXT_FONT_SIZE = 28;

/** 形状工具 → 线宽分组（共用 stroke） */
export const SHAPE_TOOLS: ReadonlySet<string> = new Set([
  "rect",
  "line",
  "arrow",
  "circle",
]);

/** 工具 → 线宽分组映射（工具栏调宽度用） */
export const TOOL_WIDTH_GROUP: Record<
  Tool,
  "stroke" | "highlighter" | "eraser"
> = {
  pen: "stroke",
  highlighter: "highlighter",
  eraser: "eraser",
  line: "stroke",
  rect: "stroke",
  circle: "stroke",
  arrow: "stroke",
  text: "stroke",
  fading: "stroke",
  blur: "stroke",
};
