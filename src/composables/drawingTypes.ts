/** 工具类型：自由笔 + 形状 + 文字 + 渐隐笔 + 马赛克笔 */
export type Tool =
  | "pen"
  | "highlighter"
  | "eraser"
  | "line"
  | "rect"
  | "circle"
  | "arrow"
  | "text"
  | "fading"
  | "blur";

/** 形状工具（拖拽定义两点） */
export type ShapeTool = "rect" | "line" | "arrow" | "circle";

/** 点（pressure 用于数位板压感，鼠标恒为 0.5） */
export interface Point {
  x: number;
  y: number;
  pressure?: number;
}

/** 一笔绘制动作：自由笔多段点；形状仅两点（起/终）；文字单点 + 文本 */
export interface DrawAction {
  tool: Tool;
  color: string;
  lineWidth: number;
  opacity: number;
  points: Point[];
  /** text 工具专用：文本内容 */
  text?: string;
  /** text 工具专用：字号（px） */
  fontSize?: number;
  /** fading 渐隐笔专用：笔画诞生时刻（ms 时间戳），用于计算剩余透明度 */
  bornAt?: number;
}

/** 线宽分组 */
export type LineWidthGroup = "stroke" | "highlighter" | "eraser";

/** 线宽配置 */
export interface LineWidths {
  stroke: number;
  highlighter: number;
  eraser: number;
}
