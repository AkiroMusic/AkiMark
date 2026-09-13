// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ToolToolbar from "./ToolToolbar.vue";
import { TOOL_DEFS } from "../constants/tools";
import { COLOR_PALETTE } from "../constants/colors";

function mountToolbar(
  props: Partial<InstanceType<typeof ToolToolbar>["$props"]> = {},
) {
  return mount(ToolToolbar, {
    props: {
      tool: "pen",
      color: COLOR_PALETTE[0],
      lineWidth: { stroke: 3, highlighter: 10, eraser: 12 },
      canUndo: true,
      canRedo: false,
      canClear: true,
      penetrating: false,
      spotlight: false,
      board: "none",
      zoom: false,
      recentColors: [],
      initialPosition: null,
      ...props,
    },
    global: {
      stubs: {
        // happy-dom 无 PointerCapture：工具栏根节点拖动逻辑不参与本组测试
      },
    },
  });
}

describe("ToolToolbar 组件", () => {
  it("渲染全部 11 个工具按钮与固定色盘", () => {
    const wrapper = mountToolbar();
    const toolBtns = wrapper.findAll(".tool-btn");
    expect(toolBtns.length).toBe(TOOL_DEFS.length);
    expect(wrapper.findAll(".swatch:not(.add-swatch)").length).toBe(
      COLOR_PALETTE.length,
    );
  });

  it("当前工具高亮（active 类）", () => {
    const wrapper = mountToolbar({ tool: "counter" });
    const active = wrapper.findAll(".tool-btn.active");
    expect(active.length).toBe(1);
  });

  it("点击工具按钮 emit selectTool", () => {
    const wrapper = mountToolbar();
    const idx = TOOL_DEFS.findIndex((d) => d.id === "rect");
    void wrapper.findAll(".tool-btn")[idx].trigger("click");
    expect(wrapper.emitted("selectTool")?.[0]).toEqual(["rect"]);
  });

  it("点击色块 emit selectColor；最近自定义色渲染", () => {
    const wrapper = mountToolbar({ recentColors: ["#123456"] });
    const swatches = wrapper.findAll(".swatch.recent");
    expect(swatches.length).toBe(1);
    void swatches[0].trigger("click");
    expect(wrapper.emitted("selectColor")?.[0]).toEqual(["#123456"]);
  });

  it("线宽 +/- 按分组上限钳制（stroke 上限 40）", async () => {
    const wrapper = mountToolbar({
      lineWidth: { stroke: 40, highlighter: 10, eraser: 12 },
    });
    const plus = wrapper.findAll(".width-group .mini-btn")[1];
    await plus.trigger("click");
    // 40 已是上限：不再增长
    expect(wrapper.emitted("updateWidth")?.[0]).toEqual([{ stroke: 40 }]);

    const minus = wrapper.findAll(".width-group .mini-btn")[0];
    await minus.trigger("click");
    expect(wrapper.emitted("updateWidth")?.[1]).toEqual([{ stroke: 39 }]);
  });

  it("复制与导出按钮 emit copy / export", () => {
    const wrapper = mountToolbar();
    // 动作组按钮顺序：spotlight/zoom/board/export/copy/undo/redo/clear/penetrate/exit
    const btns = wrapper.findAll(".action-group .mini-btn");
    const exportBtn = btns.find((b) => b.attributes("title")?.includes("PNG"));
    const copyBtn = btns.find(
      (b) =>
        b.attributes("title")?.toLowerCase().includes("clipboard") ||
        b.attributes("title")?.includes("剪贴板"),
    );
    expect(exportBtn).toBeTruthy();
    expect(copyBtn).toBeTruthy();
    void exportBtn!.trigger("click");
    void copyBtn!.trigger("click");
    expect(wrapper.emitted("export")).toBeTruthy();
    expect(wrapper.emitted("copy")).toBeTruthy();
  });

  it("板书模式下缩放与穿透按钮禁用（另有 redo 因 canRedo=false 禁用）", () => {
    const wrapper = mountToolbar({ board: "white" });
    const btns = wrapper.findAll(".action-group .mini-btn:disabled");
    expect(btns.length).toBe(3);
    // 禁用的必须是 zoom / penetrate / redo（undo/clear/export 等仍可用）
    const titles = btns.map((b) => b.attributes("title") ?? "");
    expect(
      titles.some(
        (s) => s.includes("缩放") || s.toLowerCase().includes("zoom"),
      ),
    ).toBe(true);
    expect(
      titles.some(
        (s) => s.includes("穿透") || s.toLowerCase().includes("click"),
      ),
    ).toBe(true);
  });
});
