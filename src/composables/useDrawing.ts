import { computed, ref, watch } from "vue";
import type { Ref } from "vue";
import type { DrawAction, LineWidths, Point, Tool } from "./drawingTypes";
import {
  BLUR_CELL_MIN,
  ERASER_OPACITY,
  FADE_DURATION_MS,
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

/** 渐隐笔清理/渐隐动画的轮询周期（ms） */
const FADE_TICK_MS = 250;

/** 马赛克底图（屏幕截屏）：模块级共享，导出时可用新截屏临时替换 */
let blurBase: CanvasImageSource | null = null;
/** 马赛克纯色底（黑板模式）：优先于截屏，避免马赛克暴露屏幕内容 */
let blurBaseColor: string | null = null;
/**
 * 马赛克合成底图：屏幕/板书 + 全部已提交标注（马赛克除外）。
 * 打码时以它为源，因此标注与背景会被一起模糊。
 */
let blurComposite: HTMLCanvasElement | null = null;
let blurCompositeDirty = true;

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
  opts: { coordMapper?: (p: Point) => Point } = {},
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

    // 画布尺寸变化 → 马赛克合成底图需按新尺寸重建
    blurCompositeDirty = true;
    historyDirty = true;
    scheduleRender();
  }

  /** 点坐标换算到 CSS 像素 */
  function toCssPoint(e: PointerEvent | MouseEvent): Point {
    const rect = refs.preview.value?.getBoundingClientRect();
    // 缩放模式下 canvas 被 transform 缩放，getBoundingClientRect 会返回变换后的盒；
    // 此时以布局基准（overlay 原点 0,0）直接取 client 坐标，再交给 coordMapper
    // 逆变换回捕获空间，避免变换盒导致的偏移。
    const hasMapper = opts.coordMapper != null;
    const baseX = hasMapper ? 0 : (rect?.left ?? 0);
    const baseY = hasMapper ? 0 : (rect?.top ?? 0);
    const p0 = {
      x: e.clientX - baseX,
      y: e.clientY - baseY,
    } as Point;
    // 数位板压感：仅 pen 指针类型参与调制（鼠标 pressure 恒 0.5 排除，笔压到 0.5 不被误排除）
    const pe = e as PointerEvent;
    if (
      pe.pointerType === "pen" &&
      typeof pe.pressure === "number" &&
      pe.pressure > 0
    ) {
      p0.pressure = pe.pressure;
    }
    return opts.coordMapper ? opts.coordMapper(p0) : p0;
  }

  /** 当前透明度：渐隐笔随时间衰减，其余工具恒为原始值 */
  function actionOpacity(action: DrawAction): number {
    if (action.tool === "fading" && action.bornAt !== undefined) {
      const remain = 1 - (Date.now() - action.bornAt) / FADE_DURATION_MS;
      return action.opacity * Math.max(0, remain);
    }
    return action.opacity;
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
    ctx.globalAlpha = actionOpacity(action);
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
    ctx.globalAlpha = actionOpacity(action);
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
    ctx.globalAlpha = actionOpacity(action);
    ctx.strokeStyle = action.color;
    ctx.lineWidth = action.lineWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    if (action.tool === "arrow") {
      // 箭头：线段终点沿方向回缩半个线宽，使圆帽外沿正好收在箭头尖端，
      // 避免尖端被线帽顶出
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const shrink = action.lineWidth / 2;
      ctx.lineTo(
        b.x - Math.cos(angle) * shrink,
        b.y - Math.sin(angle) * shrink,
      );
    } else {
      ctx.lineTo(b.x, b.y);
    }
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
    ctx.globalAlpha = actionOpacity(action);
    ctx.fillStyle = action.color;
    ctx.font = `600 ${size}px "Plus Jakarta Sans", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    const lines = action.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], p.x, p.y + i * size * 1.25);
    }
    ctx.restore();
  }

  /** 马赛克块尺寸（CSS px）：随线宽增长，保证打码够糊 */
  const blurCell = computed(() =>
    Math.max(BLUR_CELL_MIN, Math.round(lineWidth.value * 0.8)),
  );

  /**
   * 确保马赛克合成底图就绪：base（屏幕截屏或板书纯色）+ 全部已提交标注
   * （马赛克除外，避免递归采样）。供 drawMosaicSegment 采样，让打码同时
   * 覆盖标注与背景。node 测试环境无 DOM，保持 blurComposite = null，
   * 回退直接采样 blurBase（旧行为，测试断言 drawImage 调用）。
   */
  function ensureBlurComposite() {
    if (!blurCompositeDirty) return;
    if (!historyCtx || typeof document === "undefined") return;
    const needsComposite =
      blurBase !== null ||
      blurBaseColor !== null ||
      history.value.some((a) => a.tool === "blur") ||
      currentTool.value === "blur";
    if (!needsComposite) return;

    if (!blurComposite) blurComposite = document.createElement("canvas");
    blurComposite.width = historyCtx.canvas.width;
    blurComposite.height = historyCtx.canvas.height;
    const cctx = blurComposite.getContext("2d");
    if (!cctx) return;
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.lineCap = "round";
    cctx.lineJoin = "round";
    // 1. 底：板书纯色优先（黑板模式不截屏，避免暴露屏幕内容），否则屏幕截屏
    if (blurBaseColor) {
      cctx.fillStyle = blurBaseColor;
      cctx.fillRect(
        0,
        0,
        historyCtx.canvas.width / dpr,
        historyCtx.canvas.height / dpr,
      );
    } else if (blurBase) {
      cctx.drawImage(
        blurBase,
        0,
        0,
        historyCtx.canvas.width / dpr,
        historyCtx.canvas.height / dpr,
      );
    }
    // 2. 已提交标注（马赛克动作不参与自身底图）
    for (const action of history.value) {
      if (action.tool === "blur") continue;
      drawAction(cctx, action);
    }
    blurCompositeDirty = false;
  }

  /**
   * 马赛克笔：以合成底图（blurComposite ?? blurBase）为源，沿笔画路径采样。
   * - 每个块采样更大的源区域（cell × sourceScale=3）压进 cell，平滑插值
   *   → 块内内容被摊平混合，比旧版逐格硬贴更模糊
   * - 采样步距小于块径（重叠）→ 相邻块边缘柔和过渡
   * - 源坐标按当前画布变换的设备像素比换算（画布已 setTransform(dpr,...)）
   */
  function drawMosaicSegment(
    ctx: CanvasRenderingContext2D,
    action: DrawAction,
  ) {
    const src = blurComposite ?? blurBase;
    if (!src || action.points.length === 0) return;
    const cell = blurCell.value;
    const dprScale = Math.max(1, ctx.getTransform().a);
    // 源区放大系数：越大越糊（源区压进目标块时的摊平程度）
    const sourceScale = 3;

    // 沿折线按弧长步进采样（步距 < 块径 → 重叠，边缘柔和）
    const step = cell * 0.75;
    const pts = action.points;
    const samples: Point[] = [{ x: pts[0].x, y: pts[0].y }];
    let traveled = 0;
    let nextAt = step;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (seg < 1e-4) continue;
      const segEnd = traveled + seg;
      while (nextAt <= segEnd) {
        const t = (nextAt - traveled) / seg;
        samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        nextAt += step;
        if (samples.length >= 5000) break;
      }
      traveled = segEnd;
    }
    const last = pts[pts.length - 1];
    const tail = samples[samples.length - 1];
    if (Math.hypot(last.x - tail.x, last.y - tail.y) > 1) {
      samples.push({ x: last.x, y: last.y });
    }

    const srcSize = cell * sourceScale;
    const half = srcSize / 2;
    ctx.save();
    // 马赛克用源覆盖合成，显式切回默认模式（橡皮等其他路径不经过此处）
    ctx.globalCompositeOperation = "source-over";
    // 平滑插值：源区压缩进目标块时产生柔和的模糊感（而非旧版硬边像素格）
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    for (const s of samples) {
      ctx.drawImage(
        src,
        (s.x - half) * dprScale,
        (s.y - half) * dprScale,
        srcSize * dprScale,
        srcSize * dprScale,
        s.x - cell / 2,
        s.y - cell / 2,
        cell,
        cell,
      );
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
          actionOpacity(action),
        );
        break;
      case "fading":
        // 渐隐笔：先以略宽的白色打底（外层白边更醒目），再叠彩色笔迹；
        // 几何/透明度与钢笔一致，渐隐只影响透明度，不影响线宽/形状
        drawPressureSegment(
          ctx,
          action.points,
          "#ffffff",
          action.lineWidth + 3,
          actionOpacity(action),
        );
        drawPressureSegment(
          ctx,
          action.points,
          action.color,
          action.lineWidth,
          actionOpacity(action),
        );
        break;
      case "blur":
        drawMosaicSegment(ctx, action);
        break;
      default:
        drawSmoothSegment(
          ctx,
          action.points,
          action.color,
          action.lineWidth,
          actionOpacity(action),
        );
    }
  }

  /** 全量重绘历史层（撤销/清屏/初始化时调用） */
  function redrawHistory() {
    if (!historyCtx) return;
    // 马赛克合成底图依赖当前 history（含标注），先重建再画 blur 动作
    ensureBlurComposite();
    historyCtx.clearRect(
      0,
      0,
      historyCtx.canvas.width,
      historyCtx.canvas.height,
    );
    for (const action of history.value) {
      drawAction(historyCtx, action);
    }
    // 进行中的橡皮：按住时实时作用到历史层（已提交笔画被立即擦除）
    if (currentAction?.tool === "eraser") {
      drawAction(historyCtx, currentAction);
    }
    historyDirty = false;
  }

  function renderPreview() {
    if (!previewCtx) return;
    ensureBlurComposite();
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

  // ---- 渐隐笔生命周期 ----

  let fadeTimer: number | null = null;

  function stopFadeTimer() {
    if (fadeTimer !== null) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }
  }

  /** 有渐隐笔画时启动轮询（无则保持空闲，避免常驻定时器） */
  function ensureFadeTimer() {
    if (fadeTimer === null) {
      fadeTimer = setInterval(fadeTick, FADE_TICK_MS);
    }
  }

  /**
   * 渐隐轮询：过期笔画从 history 移除，并同步清理 undo/redo 栈中引用同一
   * action 的条目（保持撤销一致性）；未过期则周期重绘让透明度逐帧下降。
   */
  function fadeTick() {
    const now = Date.now();
    const expired = new Set<DrawAction>();
    let hasFading = false;
    for (const a of history.value) {
      if (a.tool === "fading") {
        hasFading = true;
        if (a.bornAt !== undefined && now - a.bornAt >= FADE_DURATION_MS) {
          expired.add(a);
        }
      }
    }
    // 已撤销/已重做栈中的渐隐笔画同样参与过期判定
    for (const stack of [undoStack.value, redoStack.value]) {
      for (const entry of stack) {
        for (const a of entry.actions) {
          if (a.tool === "fading") {
            hasFading = true;
            if (a.bornAt !== undefined && now - a.bornAt >= FADE_DURATION_MS) {
              expired.add(a);
            }
          }
        }
      }
    }
    if (expired.size > 0) {
      history.value = history.value.filter((a) => !expired.has(a));
      const keep = (entry: UndoEntry) =>
        entry.actions.some((a) => !expired.has(a));
      undoStack.value = undoStack.value.filter(keep);
      redoStack.value = redoStack.value.filter(keep);
      // 渐隐标注被清除 → 合成底图里的标注层需同步重建
      blurCompositeDirty = true;
    }
    if (hasFading) {
      // 周期重绘呈现渐隐动画（透明度随时间线性下降）
      historyDirty = true;
      scheduleRender();
    } else {
      stopFadeTimer();
    }
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
    // 渐隐笔记录诞生时刻，供透明度衰减与过期清理使用
    if (currentTool.value === "fading") {
      currentAction.bornAt = Date.now();
    }
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
    // 橡皮实时擦除：标记历史层脏，让 redrawHistory 把进行中的橡皮作用到已提交笔画上
    if (currentAction.tool === "eraser") {
      historyDirty = true;
    }
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
    blurCompositeDirty = true;
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
    if (currentAction.tool === "fading") ensureFadeTimer();
    redoStack.value = [];
    currentAction = null;
    lastPoint = null;
    isDrawing.value = false;

    // 新提交的标注（非马赛克）会进入合成底图 → 置脏重建
    blurCompositeDirty = true;
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
    blurCompositeDirty = true;
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
    // 重做带回渐隐笔画时重启轮询（可能已因栈中无渐隐而停止）
    if (entry.actions.some((a) => a.tool === "fading")) ensureFadeTimer();
    blurCompositeDirty = true;
    historyDirty = true;
    scheduleRender();
  }

  function clearAll() {
    if (history.value.length === 0) return;
    undoStack.value.push({ type: "clear", actions: [...history.value] });
    redoStack.value = [];
    history.value = [];
    blurCompositeDirty = true;
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
    blurBase = null;
    blurBaseColor = null;
    blurComposite = null;
    blurCompositeDirty = true;
    stopFadeTimer();
    historyDirty = true;
    previewDirty = true;
    scheduleRender();
  }

  /**
   * 把已提交笔画重绘到外部 canvas（截图导出用）。
   * 调用方负责设置 target 尺寸/变换；本函数以 CSS 像素坐标绘制。
   * base 传入时马赛克底图临时指向它（导出用新截屏做马赛克源），渲染后恢复。
   */
  function renderTo(
    target: HTMLCanvasElement | null,
    cssW: number,
    cssH: number,
    scale: number,
    base?: CanvasImageSource | null,
  ) {
    if (!target) return;
    target.width = Math.floor(cssW * scale);
    target.height = Math.floor(cssH * scale);
    const ctx = target.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const prevBase = blurBase;
    const prevColor = blurBaseColor;
    if (base) {
      // 导出时用新截屏做马赛克底（黑板模式 base 为 null，沿用板书纯色底）
      blurBase = base;
      blurBaseColor = null;
    }
    // 重建马赛克合成底图，保证导出图里 blur 动作采样到最新画面
    blurCompositeDirty = true;
    ensureBlurComposite();
    for (const action of history.value) {
      drawAction(ctx, action);
    }
    blurBase = prevBase;
    blurBaseColor = prevColor;
    blurCompositeDirty = true;
  }

  /** 设置马赛克底图（屏幕截屏）；null 表示清除 */
  function setBlurBase(img: CanvasImageSource | null) {
    blurBase = img;
    if (img) blurBaseColor = null;
    blurCompositeDirty = true;
    scheduleRender();
  }

  /** 设置马赛克纯色底（黑板模式）；null 表示清除，回到屏幕截屏底 */
  function setBlurBaseColor(color: string | null) {
    blurBaseColor = color;
    if (color) blurBase = null;
    blurCompositeDirty = true;
    scheduleRender();
  }

  function hasBlurBase(): boolean {
    return blurBase !== null || blurBaseColor !== null;
  }

  function destroy() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    stopFadeTimer();
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
    blurCell,
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
    setBlurBase,
    setBlurBaseColor,
    hasBlurBase,
    destroy,
    getDPR,
  };
}
