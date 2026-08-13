import { computed, ref, watch } from "vue";
import type { Ref } from "vue";
import type { DrawAction, LineWidths, Point, Tool } from "./drawingTypes";
import {
  ERASER_OPACITY,
  HIGHLIGHTER_OPACITY,
  PEN_OPACITY,
  SHAPE_TOOLS,
  TEXT_FONT_SIZE,
  TOOL_WIDTH_GROUP,
  WIDTH_SCALE,
} from "../constants/tools";
import { DEFAULT_COLOR } from "../constants/colors";

/** 最大画布像素（防超大显示器 OOM） */
const MAX_CANVAS_PIXELS = 6_000_000;

interface UndoEntry {
  type: "add" | "remove" | "clear";
  actions: DrawAction[];
}

interface CanvasRefs {
  history: Ref<HTMLCanvasElement | null>;
  preview: Ref<HTMLCanvasElement | null>;
}

/** 压力映射：0..1 → 0.4x..2.0x（数位板轻笔细、重笔粗；鼠标无压感恒 1x） */
function pressureScale(p?: number): number {
  if (p === undefined || p <= 0) return 1;
  return 0.4 + p * 1.6;
}

/**
 * 双 canvas 绘制引擎：
 * - historyCanvas：已提交笔画（缓存渲染，失效时才重绘）
 * - previewCanvas：进行中的笔画（高频 rAF 更新）
 * - rAF 循环 + dirty flags，空闲时零消耗
 */
export function useDrawing(
  refs: CanvasRefs,
  getDPR: () => number,
  initial: { tool?: Tool; color?: string; lineWidths?: LineWidths } = {},
) {
  const currentTool = ref<Tool>(initial.tool ?? "pen");
  const currentColor = ref(initial.color ?? DEFAULT_COLOR);
  const lineWidths = ref<LineWidths>({
    stroke: initial.lineWidths?.stroke ?? 3,
    highlighter: initial.lineWidths?.highlighter ?? 10,
    eraser: initial.lineWidths?.eraser ?? 12,
  });
  const isDrawing = ref(false);

  // 数据
  const history = ref<DrawAction[]>([]);
  const undoStack = ref<UndoEntry[]>([]);
  const redoStack = ref<UndoEntry[]>([]);

  // 进行中
  let currentAction: DrawAction | null = null;
  let lastPoint: Point | null = null;

  // 渲染状态
  let historyCtx: CanvasRenderingContext2D | null = null;
  let previewCtx: CanvasRenderingContext2D | null = null;
  let historyDirty = false;
  let previewDirty = false;
  let rafId: number | null = null;
  let dpr = 1;

  const canUndo = computed(() => undoStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);
  const canClear = computed(() => history.value.length > 0);

  // 当前工具线宽（随工具切换）
  const lineWidth = computed(() => {
    const w = lineWidths.value[TOOL_WIDTH_GROUP[currentTool.value]];
    return w * WIDTH_SCALE[currentTool.value];
  });

  function currentOpacity(): number {
    switch (currentTool.value) {
      case "highlighter":
        return HIGHLIGHTER_OPACITY;
      case "eraser":
        return ERASER_OPACITY;
      default:
        return PEN_OPACITY;
    }
  }

  /** 初始化/尺寸变化时设置画布 */
  function setupCanvases(width: number, height: number, scale: number) {
    dpr = Math.min(
      scale,
      Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height)),
    );
    dpr = Math.max(1, dpr);

    const cssW = Math.floor(width);
    const cssH = Math.floor(height);

    for (const [canvas, key] of [
      [refs.history.value, "historyCtx"],
      [refs.preview.value, "previewCtx"],
    ] as const) {
      if (!canvas) continue;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      const ctx = canvas.getContext("2d");
      if (key === "historyCtx") historyCtx = ctx;
      else previewCtx = ctx;
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
      }
    }

    historyDirty = true;
    scheduleRender();
  }

  /** 点坐标换算到 CSS 像素 */
  function toCssPoint(e: PointerEvent | MouseEvent): Point {
    const rect = refs.preview.value?.getBoundingClientRect();
    const p = {
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    } as Point;
    // 数位板压感：仅 pen 指针类型参与调制（鼠标 pressure 恒 0.5 排除，笔压到 0.5 不被误排除）
    const pe = e as PointerEvent;
    if (
      pe.pointerType === "pen" &&
      typeof pe.pressure === "number" &&
      pe.pressure > 0
    ) {
      p.pressure = pe.pressure;
    }
    return p;
  }

  /** 二次贝塞尔中点平滑绘制一段（荧光笔/橡皮：固定宽度） */
  function drawSmoothSegment(
    ctx: CanvasRenderingContext2D,
    points: Point[],
    color: string,
    width: number,
    opacity: number,
  ) {
    if (points.length === 0) return;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length < 3) {
      ctx.lineTo(points[1]?.x ?? points[0].x, points[1]?.y ?? points[0].y);
    } else {
      for (let i = 1; i < points.length - 1; i++) {
        const xc = (points[i].x + points[i + 1].x) / 2;
        const yc = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
      }
      const last = points[points.length - 1];
      const prev = points[points.length - 2];
      ctx.quadraticCurveTo(prev.x, prev.y, last.x, last.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 压感画笔：逐段按压力调制线宽（钢笔工具专用） */
  function drawPressureSegment(
    ctx: CanvasRenderingContext2D,
    points: Point[],
    color: string,
    baseWidth: number,
    opacity: number,
  ) {
    if (points.length < 2) return;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const w = Math.max(
        0.5,
        (baseWidth * pressureScale(a.pressure) +
          baseWidth * pressureScale(b.pressure)) /
          2,
      );
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 矩形 */
  function drawRect(ctx: CanvasRenderingContext2D, action: DrawAction) {
    const [a, b] = action.points;
    if (!a || !b) return;
    ctx.save();
    ctx.globalAlpha = action.opacity;
    ctx.strokeStyle = action.color;
    ctx.lineWidth = action.lineWidth;
    ctx.strokeRect(
      Math.min(a.x, b.x),
      Math.min(a.y, b.y),
      Math.abs(b.x - a.x),
      Math.abs(b.y - a.y),
    );
    ctx.restore();
  }

  /** 圆形（以两点为对角的外接椭圆） */
  function drawCircle(ctx: CanvasRenderingContext2D, action: DrawAction) {
    const [a, b] = action.points;
    if (!a || !b) return;
    const rx = Math.abs(b.x - a.x) / 2;
    const ry = Math.abs(b.y - a.y) / 2;
    if (rx < 0.25 && ry < 0.25) return;
    ctx.save();
    ctx.globalAlpha = action.opacity;
    ctx.strokeStyle = action.color;
    ctx.lineWidth = action.lineWidth;
    ctx.beginPath();
    ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** 直线（arrow 时加箭头） */
  function drawLine(ctx: CanvasRenderingContext2D, action: DrawAction) {
    const [a, b] = action.points;
    if (!a || !b) return;
    ctx.save();
    ctx.globalAlpha = action.opacity;
    ctx.strokeStyle = action.color;
    ctx.lineWidth = action.lineWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    if (action.tool === "arrow") {
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const head = Math.max(8, action.lineWidth * 4);
      ctx.fillStyle = action.color;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(
        b.x - head * Math.cos(angle - Math.PI / 6),
        b.y - head * Math.sin(angle - Math.PI / 6),
      );
      ctx.lineTo(
        b.x - head * Math.cos(angle + Math.PI / 6),
        b.y - head * Math.sin(angle + Math.PI / 6),
      );
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** 文字（支持多行） */
  function drawText(ctx: CanvasRenderingContext2D, action: DrawAction) {
    const [p] = action.points;
    if (!p || !action.text) return;
    const size = action.fontSize ?? TEXT_FONT_SIZE;
    ctx.save();
    ctx.globalAlpha = action.opacity;
    ctx.fillStyle = action.color;
    ctx.font = `600 ${size}px "Plus Jakarta Sans", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    const lines = action.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], p.x, p.y + i * size * 1.25);
    }
    ctx.restore();
  }

  function drawAction(ctx: CanvasRenderingContext2D, action: DrawAction) {
    switch (action.tool) {
      case "eraser":
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        drawSmoothSegment(ctx, action.points, "#000", action.lineWidth, 1);
        ctx.restore();
        break;
      case "rect":
        drawRect(ctx, action);
        break;
      case "circle":
        drawCircle(ctx, action);
        break;
      case "line":
      case "arrow":
        drawLine(ctx, action);
        break;
      case "text":
        drawText(ctx, action);
        break;
      case "pen":
        drawPressureSegment(
          ctx,
          action.points,
          action.color,
          action.lineWidth,
          action.opacity,
        );
        break;
      default:
        drawSmoothSegment(
          ctx,
          action.points,
          action.color,
          action.lineWidth,
          action.opacity,
        );
    }
  }

  /** 全量重绘历史层（撤销/清屏/初始化时调用） */
  function redrawHistory() {
    if (!historyCtx) return;
    historyCtx.clearRect(
      0,
      0,
      historyCtx.canvas.width,
      historyCtx.canvas.height,
    );
    for (const action of history.value) {
      drawAction(historyCtx, action);
    }
    historyDirty = false;
  }

  function renderPreview() {
    if (!previewCtx) return;
    previewCtx.clearRect(
      0,
      0,
      previewCtx.canvas.width,
      previewCtx.canvas.height,
    );
    if (currentAction) {
      drawAction(previewCtx, currentAction);
    }
    previewDirty = false;
  }

  function render() {
    if (historyDirty) redrawHistory();
    if (previewDirty) renderPreview();
  }

  function scheduleRender() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      render();
    });
  }

  // ---- 笔画生命周期 ----

  function startDraw(e: PointerEvent): boolean {
    if (e.button !== 0 && e.button !== 2) return false;
    const p = toCssPoint(e);
    const isShape = SHAPE_TOOLS.has(currentTool.value);
    currentAction = {
      tool: currentTool.value,
      color: currentColor.value,
      lineWidth: lineWidth.value,
      opacity: currentOpacity(),
      points: [p],
    };
    // 形状工具：起始点即两点起点
    if (isShape) currentAction.points.push({ x: p.x, y: p.y });
    lastPoint = p;
    isDrawing.value = true;
    previewDirty = true;
    scheduleRender();
    return true;
  }

  function drawTo(e: PointerEvent) {
    if (!currentAction || !isDrawing.value) return;
    const p = toCssPoint(e);
    // 形状工具：只更新终点
    if (SHAPE_TOOLS.has(currentAction.tool)) {
      currentAction.points[1] = p;
      lastPoint = p;
      previewDirty = true;
      scheduleRender();
      return;
    }
    // 自适应最小采样距离（视角面积大则采样更稀）
    const minDistSq = 0.5;
    if (lastPoint) {
      const dx = p.x - lastPoint.x;
      const dy = p.y - lastPoint.y;
      if (dx * dx + dy * dy < minDistSq) return;
    }
    // 合并 coalesced 事件
    const points: Point[] = [p];
    if (
      "getCoalescedEvents" in e &&
      typeof e.getCoalescedEvents === "function"
    ) {
      const coalesced = e.getCoalescedEvents();
      if (coalesced.length > 1) {
        points.length = 0;
        for (const ce of coalesced) points.push(toCssPoint(ce));
      }
    }
    currentAction.points.push(...points);
    lastPoint = p;
    previewDirty = true;
    scheduleRender();
  }

  /** 文字工具：以给定坐标落笔，携带文本内容 */
  function startText(pos: Point, text: string) {
    if (!text.trim()) return;
    currentAction = {
      tool: "text",
      color: currentColor.value,
      lineWidth: lineWidth.value,
      opacity: currentOpacity(),
      points: [{ x: pos.x, y: pos.y }],
      text,
      fontSize: TEXT_FONT_SIZE,
    };
    history.value.push(currentAction);
    undoStack.value.push({ type: "add", actions: [currentAction] });
    redoStack.value = [];
    currentAction = null;
    lastPoint = null;
    isDrawing.value = false;
    historyDirty = true;
    scheduleRender();
  }

  function endDraw() {
    if (!currentAction || !isDrawing.value) return;
    // 单点也要留下痕迹（自由笔）
    const isShape = SHAPE_TOOLS.has(currentAction.tool);
    if (currentAction.points.length === 1 && !isShape) {
      const p = currentAction.points[0];
      currentAction.points.push({
        x: p.x + 0.01,
        y: p.y + 0.01,
        pressure: p.pressure,
      });
    }
    // 形状工具起点终点重合 → 丢弃（避免画个点）
    if (isShape && currentAction.points.length === 2) {
      const [a, b] = currentAction.points;
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5) {
        currentAction = null;
        lastPoint = null;
        isDrawing.value = false;
        previewDirty = true;
        scheduleRender();
        return;
      }
    }
    history.value.push(currentAction);
    undoStack.value.push({ type: "add", actions: [currentAction] });
    redoStack.value = [];
    currentAction = null;
    lastPoint = null;
    isDrawing.value = false;

    previewDirty = true;
    historyDirty = true;
    scheduleRender();
  }

  function undo() {
    const entry = undoStack.value.pop();
    if (!entry) return;
    if (entry.type === "add") {
      const count = entry.actions.length;
      const removed = history.value.splice(history.value.length - count, count);
      redoStack.value.push({ type: "add", actions: removed });
    } else {
      history.value.push(...entry.actions);
      redoStack.value.push(entry);
    }
    historyDirty = true;
    scheduleRender();
  }

  function redo() {
    const entry = redoStack.value.pop();
    if (!entry) return;
    if (entry.type === "add") {
      history.value.push(...entry.actions);
      undoStack.value.push(entry);
    } else {
      const count = entry.actions.length;
      const removed = history.value.splice(history.value.length - count, count);
      undoStack.value.push({ type: "add", actions: removed });
    }
    historyDirty = true;
    scheduleRender();
  }

  function clearAll() {
    if (history.value.length === 0) return;
    undoStack.value.push({ type: "clear", actions: [...history.value] });
    redoStack.value = [];
    history.value = [];
    historyDirty = true;
    scheduleRender();
  }

  function hardReset() {
    history.value = [];
    undoStack.value = [];
    redoStack.value = [];
    currentAction = null;
    lastPoint = null;
    isDrawing.value = false;
    historyDirty = true;
    previewDirty = true;
    scheduleRender();
  }

  /**
   * 把已提交笔画重绘到外部 canvas（截图导出用）。
   * 调用方负责设置 target 尺寸/变换；本函数以 CSS 像素坐标绘制。
   */
  function renderTo(
    target: HTMLCanvasElement | null,
    cssW: number,
    cssH: number,
    scale: number,
  ) {
    if (!target) return;
    target.width = Math.floor(cssW * scale);
    target.height = Math.floor(cssH * scale);
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const action of history.value) {
      drawAction(ctx, action);
    }
  }

  function destroy() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // 配置变更 → 重绘（颜色/线宽不影响已提交笔画，但保留便于扩展）
  watch(lineWidths, () => {
    historyDirty = true;
    scheduleRender();
  });

  return {
    currentTool,
    currentColor,
    lineWidths,
    lineWidth,
    isDrawing,
    canUndo,
    canRedo,
    canClear,
    setupCanvases,
    startDraw,
    drawTo,
    endDraw,
    startText,
    undo,
    redo,
    clearAll,
    hardReset,
    renderTo,
    destroy,
    getDPR,
  };
}
