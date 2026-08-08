/** 工具类型 */
export type Tool = "pen" | "highlighter" | "eraser";

/** 点 */
export interface Point {
  x: number;
  y: number;
}

/** 一笔绘制动作 */
export interface DrawAction {
  tool: Tool;
  color: string;
  lineWidth: number;
  opacity: number;
  points: Point[];
}

/** 线宽分组 */
export type LineWidthGroup = "stroke" | "highlighter" | "eraser";

/** 线宽配置 */
export interface LineWidths {
  stroke: number;
  highlighter: number;
  eraser: number;
}
