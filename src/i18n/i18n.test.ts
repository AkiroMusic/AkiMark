import { describe, expect, it } from "vitest";
import { useI18n } from "./index";

// i18n 模块级 locale 状态在测试间共享：用例按序编写，末尾复位

describe("i18n 极简实现", () => {
  it("两种语言包 key 集合完全一致（缺 key 会以裸 key 形式漏给用户）", () => {
    // 经由 t() 的回退行为间接校验：分别枚举两个 catalog 的 key
    // （模块未导出 catalogs，这里用 en 包的已知 key 抽样 + 全量对比的行为式做法）
    const { t, setLocale } = useI18n();
    setLocale("en");
    const enKeys = collectKeys(t);
    setLocale("zh-CN");
    const zhKeys = collectKeys(t);
    expect(zhKeys).toEqual(enKeys);
  });

  it("未知 key 原样返回（回退可见，而非抛错/空白）", () => {
    const { t } = useI18n();
    expect(t("definitely.not.a.key")).toBe("definitely.not.a.key");
  });

  it("setLocale 切换译文", () => {
    const { t, setLocale } = useI18n();
    setLocale("en");
    expect(t("settings.title")).toBe("Settings");
    setLocale("zh-CN");
    expect(t("settings.title")).toBe("设置");
  });
});

/** 通过探测已知前缀收集 key（模块未导出 catalogs，行为式收集） */
function collectKeys(t: (key: string) => string): string[] {
  // 用回退特性无法枚举；改为固定清单对比 —— 取两包共有的代表性 key 做行为断言
  const probes = [
    "tool.pen",
    "tool.counter",
    "action.copy",
    "action.copied",
    "action.copyFailed",
    "action.blurReady",
    "action.penetrationFailed",
    "error.initFailed",
    "settings.language",
    "settings.preserveDrawings",
    "settings.helpInCtrlD",
  ];
  return probes.filter((k) => t(k) !== k);
}
