import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  // as unknown：vitest 3.x 的 Plugin<Api> 类型与 vite 8 的 PluginOption 存在
  // 版本间声明冲突（运行时兼容），待 vitest 适配 vite 8 后可移除
  plugins: [vue() as never],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
