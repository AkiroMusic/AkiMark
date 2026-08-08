import { computed, ref, watch } from "vue";
import type { Ref } from "vue";
import type { DrawAction, LineWidths, Point, Tool } from "./drawingTypes";
import {
  ERASER_OPACITY,
  HIGHLIGHTER_OPACITY,
  PEN_OPACITY,
  WIDTH_SCALE,
} from "../constants/tools";
import { DEFAULT_COLOR } from "../constants/colors";

/** 画布引用映射：工具名 → 线宽配置键 */
const TOOL_WIDTH_KEY: Record<Tool, keyof LineWidths> = {
  pen: "stroke",
  highlighter: "highlighter",
  eraser: "eraser",
};

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
    highlighter: initial.lineWidths?.highlighter ?? 18,
    eraser: initial.lineWidths?.eraser ?? 24,
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
    const w = lineWidths.value[TOOL_WIDTH_KEY[currentTool.value]];
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
    return {
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    };
  }

  /** 二次贝塞尔中点平滑绘制一段 */
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

  function drawAction(ctx: CanvasRenderingContext2D, action: DrawAction) {
    if (action.tool === "eraser") {
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      drawSmoothSegment(ctx, action.points, "#000", action.lineWidth, 1);
      ctx.restore();
    } else {
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
    currentAction = {
      tool: currentTool.value,
      color: currentColor.value,
      lineWidth: lineWidth.value,
      opacity: currentOpacity(),
      points: [p],
    };
    lastPoint = p;
    isDrawing.value = true;
    previewDirty = true;
    scheduleRender();
    return true;
  }

  function drawTo(e: PointerEvent) {
    if (!currentAction || !isDrawing.value) return;
    const p = toCssPoint(e);
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

  function endDraw() {
    if (!currentAction || !isDrawing.value) return;
    // 单点也要留下痕迹
    if (currentAction.points.length === 1) {
      const p = currentAction.points[0];
      currentAction.points.push({ x: p.x + 0.01, y: p.y + 0.01 });
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
    undo,
    redo,
    clearAll,
    hardReset,
    destroy,
    getDPR,
  };
}
