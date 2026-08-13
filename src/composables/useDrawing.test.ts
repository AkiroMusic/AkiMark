import { describe, it, expect, beforeEach, vi } from "vitest";
import { ref } from "vue";
import { useDrawing } from "./useDrawing";
import type { Point } from "./drawingTypes";

/** 最小可用的 2D 上下文 mock：记录关键调用，不真正绘制 */
function createMockCtx() {
  const calls: string[] = [];
  const lineWidthLog: number[] = [];
  const ctx = {
    setTransform: vi.fn(() => calls.push("setTransform")),
    clearRect: vi.fn(() => calls.push("clearRect")),
    beginPath: vi.fn(() => calls.push("beginPath")),
    moveTo: vi.fn(() => calls.push("moveTo")),
    lineTo: vi.fn(() => calls.push("lineTo")),
    quadraticCurveTo: vi.fn(() => calls.push("quadraticCurveTo")),
    stroke: vi.fn(() => calls.push("stroke")),
    fill: vi.fn(() => calls.push("fill")),
    strokeRect: vi.fn(() => calls.push("strokeRect")),
    ellipse: vi.fn(() => calls.push("ellipse")),
    fillText: vi.fn(() => calls.push("fillText")),
    save: vi.fn(() => calls.push("save")),
    restore: vi.fn(() => calls.push("restore")),
    set lineCap(_v: string) {},
    set lineJoin(_v: string) {},
    set lineWidth(v: number) {
      lineWidthLog.push(v);
    },
    set strokeStyle(_v: string) {},
    set fillStyle(_v: string) {},
    set globalAlpha(_v: number) {},
    set globalCompositeOperation(_v: string) {},
    set font(_v: string) {},
    set textBaseline(_v: string) {},
    canvas: { width: 0, height: 0 },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    calls,
    lineWidthLog,
  };
}

/** 造一个假的 HTMLCanvasElement（只提供 getContext + 尺寸属性） */
function fakeCanvas(ctx: CanvasRenderingContext2D): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  } as unknown as HTMLCanvasElement;
}

/** 构造指针事件（clientX/Y + pressure + pointerType） */
function pointer(
  x: number,
  y: number,
  pressure = 0.5,
  pointerType: string = "mouse",
): PointerEvent {
  return {
    clientX: x,
    clientY: y,
    button: 0,
    pressure,
    pointerType,
  } as PointerEvent;
}

let rafCb: FrameRequestCallback | null = null;

beforeEach(() => {
  rafCb = null;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

function flushRaf() {
  if (rafCb) {
    const cb = rafCb;
    rafCb = null;
    cb(0);
  }
}

function setup() {
  const historyCtx = createMockCtx();
  const previewCtx = createMockCtx();
  const drawing = useDrawing(
    {
      history: ref(fakeCanvas(historyCtx.ctx)),
      preview: ref(fakeCanvas(previewCtx.ctx)),
    },
    () => 1,
  );
  drawing.setupCanvases(1000, 800, 1);
  flushRaf();
  return { drawing, historyCtx, previewCtx };
}

describe("useDrawing 状态机", () => {
  it("自由笔画：start → draw → end 提交一个 action", () => {
    const { drawing } = setup();
    expect(drawing.isDrawing.value).toBe(false);
    expect(drawing.startDraw(pointer(10, 10))).toBe(true);
    expect(drawing.isDrawing.value).toBe(true);
    drawing.drawTo(pointer(30, 20));
    drawing.drawTo(pointer(50, 30));
    drawing.endDraw();
    expect(drawing.isDrawing.value).toBe(false);
    expect(drawing.canClear.value).toBe(true);
    expect(drawing.canUndo.value).toBe(true);
    drawing.undo();
    expect(drawing.canClear.value).toBe(false);
    drawing.redo();
    expect(drawing.canClear.value).toBe(true);
  });

  it("中键不启动绘制；左键/右键均可启动（右键供临时橡皮使用）", () => {
    const { drawing } = setup();
    const mmb = {
      clientX: 1,
      clientY: 1,
      button: 1,
      pressure: 0.5,
    } as PointerEvent;
    expect(drawing.startDraw(mmb)).toBe(false);
    expect(drawing.isDrawing.value).toBe(false);
    // 右键 = 临时橡皮路径（overlay 层会先切到 eraser 再调用）
    const rmb = {
      clientX: 1,
      clientY: 1,
      button: 2,
      pressure: 0.5,
    } as PointerEvent;
    expect(drawing.startDraw(rmb)).toBe(true);
    drawing.endDraw();
    expect(drawing.isDrawing.value).toBe(false);
  });

  it("单点点击也会留下痕迹（补 0.01 偏移）", () => {
    const { drawing } = setup();
    drawing.startDraw(pointer(100, 100));
    drawing.endDraw();
    expect(drawing.canClear.value).toBe(true);
  });

  it("形状工具：拖拽只保留起点与终点两个点", () => {
    const { drawing } = setup();
    drawing.currentTool.value = "rect";
    drawing.startDraw(pointer(10, 10));
    drawing.drawTo(pointer(20, 20));
    drawing.drawTo(pointer(40, 40));
    drawing.endDraw();
    expect(drawing.canClear.value).toBe(true);
  });

  it("形状工具：起点终点几乎重合时丢弃该笔", () => {
    const { drawing } = setup();
    drawing.currentTool.value = "arrow";
    drawing.startDraw(pointer(50, 50));
    drawing.drawTo(pointer(50.1, 50.1));
    drawing.endDraw();
    expect(drawing.canClear.value).toBe(false);
  });

  it("圆形工具：拖拽两点绘制，并调用 ellipse 渲染", () => {
    const { drawing, historyCtx } = setup();
    drawing.currentTool.value = "circle";
    drawing.startDraw(pointer(10, 10));
    drawing.drawTo(pointer(40, 30));
    drawing.endDraw();
    flushRaf();
    expect(drawing.canClear.value).toBe(true);
    expect(historyCtx.calls).toContain("ellipse");
  });

  it("clearAll 可撤销", () => {
    const { drawing } = setup();
    drawing.startDraw(pointer(10, 10));
    drawing.drawTo(pointer(20, 20));
    drawing.endDraw();
    drawing.clearAll();
    expect(drawing.canClear.value).toBe(false);
    expect(drawing.canUndo.value).toBe(true);
    drawing.undo();
    expect(drawing.canClear.value).toBe(true);
  });

  it("文字工具：startText 提交文本 action", () => {
    const { drawing } = setup();
    drawing.currentTool.value = "text";
    drawing.startText({ x: 5, y: 6 } as Point, "你好 AkiMark");
    expect(drawing.canClear.value).toBe(true);
    drawing.undo();
    expect(drawing.canClear.value).toBe(false);
  });

  it("空文本不落笔", () => {
    const { drawing } = setup();
    drawing.currentTool.value = "text";
    drawing.startText({ x: 5, y: 6 } as Point, "   ");
    expect(drawing.canClear.value).toBe(false);
  });

  it("压感：低压力(0.1)线宽显著细于基础值", () => {
    const { drawing, historyCtx } = setup();
    drawing.startDraw(pointer(10, 10, 0.1, "pen"));
    drawing.drawTo(pointer(30, 10, 0.1, "pen"));
    drawing.drawTo(pointer(50, 10, 0.1, "pen"));
    drawing.endDraw();
    flushRaf();
    expect(historyCtx.lineWidthLog.length).toBeGreaterThan(0);
    for (const w of historyCtx.lineWidthLog) {
      expect(w).toBeLessThan(3); // 基础宽 3 → 0.1 压力应显著更细
    }
  });

  it("压感：高压力(0.9)线宽显著粗于基础值", () => {
    const { drawing, historyCtx } = setup();
    drawing.startDraw(pointer(10, 10, 0.9, "pen"));
    drawing.drawTo(pointer(30, 10, 0.9, "pen"));
    drawing.drawTo(pointer(50, 10, 0.9, "pen"));
    drawing.endDraw();
    flushRaf();
    expect(historyCtx.lineWidthLog.length).toBeGreaterThan(0);
    for (const w of historyCtx.lineWidthLog) {
      expect(w).toBeGreaterThan(3); // 基础宽 3 → 0.9 压力应显著更粗
    }
  });

  it("压感：鼠标/触控板（无 pen 指针）恒为基础线宽，不调制", () => {
    const { drawing, historyCtx } = setup();
    drawing.startDraw(pointer(10, 10, 0.5, "mouse"));
    drawing.drawTo(pointer(30, 10, 0.5, "mouse"));
    drawing.drawTo(pointer(50, 10, 0.5, "mouse"));
    drawing.endDraw();
    flushRaf();
    expect(historyCtx.lineWidthLog.length).toBeGreaterThan(0);
    for (const w of historyCtx.lineWidthLog) {
      expect(w).toBe(3); // 鼠标恒为基础宽 3，不随压力/速度变化
    }
  });

  it("hardReset 清空所有状态", () => {
    const { drawing } = setup();
    drawing.startDraw(pointer(10, 10));
    drawing.endDraw();
    drawing.hardReset();
    expect(drawing.canClear.value).toBe(false);
    expect(drawing.canUndo.value).toBe(false);
    expect(drawing.canRedo.value).toBe(false);
  });

  it("工具切换改变 lineWidth（荧光笔倍率更大）", () => {
    const { drawing } = setup();
    drawing.currentTool.value = "highlighter";
    // highlighter 基础 18 * 7 = 126；这里仅验证切换后宽度跟随分组
    const hl = drawing.lineWidth.value;
    drawing.currentTool.value = "pen";
    expect(drawing.lineWidth.value).toBeLessThan(hl);
  });
});
