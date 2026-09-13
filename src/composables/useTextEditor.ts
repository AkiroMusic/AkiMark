import { nextTick, ref } from "vue";
import { mapToCapture } from "./zoomMapping";
import type { Point } from "./drawingTypes";

/**
 * 文字工具输入框：点击位置弹出、Enter 提交、Esc/失焦取消。
 *
 * WebView2 焦点竞态兜底：打开后 200ms 内的 blur 视为被 pointerdown 默认行为
 * 抢焦，重试聚焦而非误提交。
 */
export function useTextEditor(deps: {
  /** 落笔回调（坐标已逆映射回捕获空间） */
  startText: (p: Point, text: string) => void;
  /** 当前缩放倍率（0 = 未缩放）：提交时逆映射用 */
  zoom: () => number;
}) {
  /** 待提交的输入框（x/y 为屏幕 client 坐标；anchor 为打开时的缩放锚点） */
  const textEditing = ref<{
    x: number;
    y: number;
    value: string;
    anchor: Point | null;
  } | null>(null);
  const textInputRef = ref<HTMLInputElement | null>(null);

  let textOpenedAt = 0;
  let textFocusTimer: number | null = null;

  function openTextEditor(e: PointerEvent) {
    const x = e.clientX;
    const y = e.clientY;
    textOpenedAt = Date.now();
    // 记录屏幕坐标（输入框固定定位直接用）+ 缩放锚点（落笔时逆变换回捕获空间）
    textEditing.value = { x, y, value: "", anchor: { x, y } };
    focusTextInput();
  }

  /** 聚焦输入框：nextTick 优先，失败则 setTimeout 兜底（WebView2 焦点竞态） */
  function focusTextInput() {
    nextTick(() => {
      const el = textInputRef.value;
      if (!el) return;
      el.focus();
      // 首次聚焦可能被 pointerdown 的默认行为抢走，200ms 内重试
      if (textFocusTimer) window.clearTimeout(textFocusTimer);
      textFocusTimer = window.setTimeout(() => {
        textFocusTimer = null;
        if (
          textEditing.value &&
          document.activeElement !== textInputRef.value
        ) {
          textInputRef.value?.focus();
        }
      }, 200);
    });
  }

  /** 输入框失焦：打开后 200ms 内的 blur 视为焦点竞态，不自动提交 */
  function onTextBlur() {
    if (Date.now() - textOpenedAt < 200) {
      focusTextInput();
      return;
    }
    commitText();
  }

  /** 提交文字：落笔并关闭输入框（cancel = Esc/切工具，丢弃内容） */
  function commitText(cancel = false) {
    const ed = textEditing.value;
    if (!ed) return;
    textEditing.value = null;
    if (!cancel && ed.value.trim()) {
      // 缩放模式下把屏幕坐标逆变换回捕获空间再落笔（anchor 为打开时刻的冻结锚点）
      deps.startText(
        mapToCapture({ x: ed.x, y: ed.y }, ed.anchor, deps.zoom()),
        ed.value,
      );
    }
  }

  /** 卸载清理 */
  function dispose() {
    if (textFocusTimer) {
      window.clearTimeout(textFocusTimer);
      textFocusTimer = null;
    }
  }

  /** 模板函数式 ref 绑定（:ref），挂载/卸载时同步元素引用 */
  function setTextInputRef(el: unknown) {
    textInputRef.value = (el as HTMLInputElement | null) ?? null;
  }

  return {
    textEditing,
    textInputRef,
    setTextInputRef,
    openTextEditor,
    commitText,
    onTextBlur,
    dispose,
  };
}
