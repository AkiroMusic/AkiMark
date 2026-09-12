import { describe, expect, it } from "vitest";
import { mapToCapture } from "./zoomMapping";

/** 正向变换：捕获点 c 以 anchor 为原点放大 z 倍后的屏幕位置 */
function projectToScreen(
  c: { x: number; y: number },
  anchor: { x: number; y: number },
  z: number,
) {
  return {
    x: anchor.x + (c.x - anchor.x) * z,
    y: anchor.y + (c.y - anchor.y) * z,
  };
}

describe("mapToCapture 缩放逆映射", () => {
  it("z <= 0（未缩放）时恒等，保留 pressure", () => {
    const p = { x: 12, y: 34, pressure: 0.7 };
    expect(mapToCapture(p, { x: 100, y: 100 }, 0)).toEqual(p);
    expect(mapToCapture(p, { x: 100, y: 100 }, -2)).toEqual(p);
  });

  it("anchor 为 null 时恒等", () => {
    const p = { x: 12, y: 34 };
    expect(mapToCapture(p, null, 4)).toEqual(p);
  });

  it("锚点处映射为自身（原点不动点）", () => {
    const anchor = { x: 400, y: 300 };
    expect(mapToCapture({ x: 400, y: 300 }, anchor, 8)).toEqual({
      x: 400,
      y: 300,
    });
  });

  it("z=2 时锚点右侧 100px 映射为 50px", () => {
    const anchor = { x: 0, y: 0 };
    const c = mapToCapture({ x: 100, y: 60 }, anchor, 2);
    expect(c.x).toBe(50);
    expect(c.y).toBe(30);
  });

  it("锚点为负坐标（左侧显示器）时正确逆映射", () => {
    const anchor = { x: -1920, y: 0 };
    const c = mapToCapture({ x: -1720, y: 80 }, anchor, 4);
    expect(c.x).toBe(-1870);
    expect(c.y).toBe(20);
  });

  it("往返一致性：逆映射点经正向变换回到屏幕坐标（渲染端 origin==anchor 的不变量）", () => {
    const anchor = { x: 500, y: 400 };
    for (const z of [2, 4, 6, 8]) {
      for (const q of [
        { x: 520, y: 410 },
        { x: 300, y: 700 },
        { x: 1500, y: 100 },
      ]) {
        const c = mapToCapture(q, anchor, z);
        const back = projectToScreen(c, anchor, z);
        expect(back.x).toBeCloseTo(q.x, 10);
        expect(back.y).toBeCloseTo(q.y, 10);
      }
    }
  });

  it("pressure 透传不丢失（数位板压感）", () => {
    const c = mapToCapture({ x: 10, y: 10, pressure: 0.25 }, { x: 0, y: 0 }, 2);
    expect(c.pressure).toBe(0.25);
  });
});
