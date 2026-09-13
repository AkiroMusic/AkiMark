import { ref } from "vue";
import { TOAST_DURATION_MS } from "../constants/tools";

/** Toast 通知：单条覆盖式（新 toast 顶掉旧的），定时自动消失 */
export function useToast() {
  const toast = ref<{ text: string; ts: number } | null>(null);
  let toastTimer: number | null = null;

  function showToast(text: string, duration = TOAST_DURATION_MS) {
    toast.value = { text, ts: Date.now() };
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.value = null;
    }, duration);
  }

  /** 卸载清理：定时器回调不应再操作已销毁的 DOM */
  function dispose() {
    if (toastTimer) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  return { toast, showToast, dispose };
}
