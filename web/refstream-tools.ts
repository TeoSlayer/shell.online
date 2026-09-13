import { attachTerminalTools, type TerminalTools } from "./vendor/refstream/v0.1.0-alpha.2/ui.js";

const REFSTREAM_THEMES = [
  "shell",
  "midnight",
  "ocean",
  "amethyst",
  "ember",
  "arctic",
  "paper",
  "sand",
] as const;

export interface RefstreamToolsOptions {
  terminal: unknown;
  toolbar: HTMLElement;
  overlay: HTMLElement;
  frame?: HTMLElement;
  isActive?: () => boolean;
  onThemeChange?: (theme: unknown) => void;
  onFontSizeChange?: (size: number) => void;
  exportFilename?: string;
}

/**
 * Mount Refstream's optional browser tools only when its native engine is in
 * use. shell.online keeps ownership of transport, encryption, permissions and
 * collaboration; Refstream owns terminal-local navigation and inspection.
 */
export function attachRefstreamTools(
  renderer: "xterm" | "refstream",
  options: RefstreamToolsOptions,
): Promise<TerminalTools | null> {
  if (renderer !== "refstream") return Promise.resolve(null);

  return attachTerminalTools({
    terminal: options.terminal,
    engine: "native",
    toolbar: options.toolbar,
    overlay: options.overlay,
    frame: options.frame,
    isActive: options.isActive,
    onThemeChange: options.onThemeChange,
    onFontSizeChange: options.onFontSizeChange,
    ui: {
      toolbar: ["search", "explore", "menu"],
      menu: ["theme", "fontSize", "export"],
      themes: REFSTREAM_THEMES,
      explore: {
        tabs: ["commands"],
        initialTab: "commands",
        title: "Commands",
      },
      labels: {
        explore: "Commands",
        exploreTitle: "Commands",
        noCommands: "No command boundaries yet. Commands appear when the process reports shell markers.",
        export: "Download output",
      },
      exportFilename: options.exportFilename ?? "shell-online-output.txt",
      backToLive: true,
    },
  });
}
