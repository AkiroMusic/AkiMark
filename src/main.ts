import { createApp } from "vue";
import App from "./App.vue";
import SettingsApp from "./SettingsApp.vue";
import "./style.css";

// 同一份前端 bundle 服务两个窗口：按 window label 分流
// - overlay  → 全屏标注覆盖层（App.vue）
// - settings → 设置窗口（SettingsApp.vue）
async function bootstrap() {
  let label = "overlay";
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    label = getCurrentWindow().label;
  } catch {
    // 纯浏览器环境（vite 预览）：默认渲染 overlay
  }

  const root = document.getElementById("app");
  if (!root) return;

  const app = createApp(label === "settings" ? SettingsApp : App);
  app.mount(root);
}

bootstrap();
