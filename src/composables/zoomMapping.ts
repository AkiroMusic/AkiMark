import type { Point } from "./drawingTypes";

/**
 * 缩放逆映射：把屏幕坐标（client）映射回捕获空间坐标。
 *
 * 画布以 anchor 为原点放大 z 倍渲染，捕获点 c 显示于 anchor + z*(c - anchor)，
 * 因此逆映射为 c = anchor + (q - anchor)/z。调用方必须保证渲染端的
 * transform-origin 与本函数的 anchor 同源，否则笔画偏离量 = (1-z)×(光标-锚点)。
 *
 * 恒等分支：z <= 0（未缩放）或 anchor 为 null。
 */
export function mapToCapture(p: Point, anchor: Point | null, z: number): Point {
  if (z <= 0 || !anchor) return p;
  return {
    x: anchor.x + (p.x - anchor.x) / z,
    y: anchor.y + (p.y - anchor.y) / z,
    pressure: p.pressure,
  };
}
