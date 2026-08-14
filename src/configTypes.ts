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
  theme: string;
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
    | "blur";
  defaultColor: string;
  openSettingsOnStartup: boolean;
  exportDir: string | null;
}

export interface AppConfig {
  shortcuts: Shortcuts;
  general: GeneralConfig;
}
