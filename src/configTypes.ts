/** 与 src-tauri/src/config.rs 对应的前端类型（Rust camelCase serde） */

export interface LineWidthsConfig {
  stroke: number;
  highlighter: number;
  eraser: number;
}

export interface Shortcuts {
  toggleDrawing: string;
  clearDrawing: string;
  togglePenetration: string;
}

export interface GeneralConfig {
  locale: string;
  preserveDrawings: boolean;
  lineWidths: LineWidthsConfig;
  defaultTool:
    | "pen"
    | "highlighter"
    | "eraser"
    | "line"
    | "rect"
    | "circle"
    | "arrow"
    | "text"
    | "fading"
    | "blur"
    | "counter";
  defaultColor: string;
  /** 默认板书底色（白板 / 黑板） */
  boardDefault: "white" | "black";
  /** 最近使用的自定义颜色（工具栏取色器加入，最多 4 个） */
  recentColors: string[];
  openSettingsOnStartup: boolean;
  exportDir: string | null;
}

export interface AppConfig {
  shortcuts: Shortcuts;
  general: GeneralConfig;
}
