import { ref } from "vue";

type Messages = Record<string, string>;

const en: Messages = {
  "tool.pen": "Pen",
  "tool.highlighter": "Highlighter",
  "tool.eraser": "Eraser",
  "action.undo": "Undo",
  "action.redo": "Redo",
  "action.clear": "Clear",
  "action.exit": "Exit",
  "action.penetrate": "Click through",
  "toolbar.space": "Space to toggle",
  "settings.title": "Settings",
  "settings.shortcuts": "Global Shortcuts",
  "settings.toggleDrawing": "Start / stop drawing",
  "settings.clearDrawing": "Clear screen",
  "settings.togglePenetration": "Toggle click-through",
  "settings.recordHint": "Click, then press the key combination",
  "settings.autostart": "Launch at startup",
  "settings.autostartDesc": "Run AkiMark silently in the background on login",
  "settings.defaultTool": "Default tool",
  "settings.defaultColor": "Default color",
  "settings.lineWidths": "Line widths",
  "settings.openSettingsOnStartup": "Open settings on startup",
  "settings.save": "Save",
  "settings.saved": "Saved",
  "settings.close": "Close",
  "settings.shortcutConflict": "Shortcut occupied by another app",
};

const zhCN: Messages = {
  "tool.pen": "画笔",
  "tool.highlighter": "荧光笔",
  "tool.eraser": "橡皮",
  "action.undo": "撤销",
  "action.redo": "重做",
  "action.clear": "清屏",
  "action.exit": "退出",
  "action.penetrate": "点击穿透",
  "toolbar.space": "空格键切换",
  "settings.title": "设置",
  "settings.shortcuts": "全局快捷键",
  "settings.toggleDrawing": "开始 / 结束标注",
  "settings.clearDrawing": "清屏",
  "settings.togglePenetration": "切换穿透模式",
  "settings.recordHint": "点击后按下新的组合键",
  "settings.autostart": "开机自启动",
  "settings.autostartDesc": "登录后在后台静默运行，几乎不占资源",
  "settings.defaultTool": "默认画笔工具",
  "settings.defaultColor": "默认颜色",
  "settings.lineWidths": "线宽",
  "settings.openSettingsOnStartup": "启动时打开设置",
  "settings.save": "保存",
  "settings.saved": "已保存",
  "settings.close": "关闭",
  "settings.shortcutConflict": "快捷键被其他程序占用",
};

const catalogs: Record<string, Messages> = {
  en,
  "zh-CN": zhCN,
};

const locale = ref<"en" | "zh-CN">(
  (navigator.language.startsWith("zh") ? "zh-CN" : "en") as "en" | "zh-CN",
);

/** 极简 i18n：dot-path 查表，无外部依赖 */
export function useI18n() {
  const t = (key: string): string => catalogs[locale.value][key] ?? key;

  return {
    locale,
    t,
    setLocale: (l: "en" | "zh-CN") => {
      locale.value = l;
    },
  };
}
