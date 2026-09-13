export type TerminalTool = "search" | "export" | "engine" | "explore" | "agent" | "theme" | "fontSize" | "menu";
export type TerminalExploreView = "commands" | "read" | "replay" | "agent";
export type TerminalThemeName = "shell" | "midnight" | "ocean" | "amethyst" | "ember" | "arctic" | "paper" | "sand";

export interface TerminalUiOptions {
  toolbar?: false | readonly TerminalTool[];
  menu?: false | readonly Exclude<TerminalTool, "menu">[];
  themes?: false | readonly TerminalThemeName[];
  explore?: false | {
    tabs?: readonly TerminalExploreView[];
    initialTab?: string;
    title?: string;
  };
  search?: boolean;
  backToLive?: boolean;
  labels?: Readonly<Record<string, string>>;
  className?: string;
  cssVariables?: Readonly<Record<`--${string}`, string>>;
  exportFilename?: string;
}

export interface TerminalToolsOptions {
  terminal: unknown;
  engine?: "native" | "xterm";
  toolbar: HTMLElement;
  overlay: HTMLElement;
  frame?: HTMLElement;
  ui?: TerminalUiOptions;
  onThemeChange?: (theme: unknown) => void;
  onFontSizeChange?: (size: number) => void;
  isActive?: () => boolean;
}

export interface TerminalTools {
  openSearch(): void;
  openExplore(view?: string): void;
  openMenu(): void;
  close(): void;
  dispose(): void;
}

export function attachTerminalTools(options: TerminalToolsOptions): Promise<TerminalTools>;
