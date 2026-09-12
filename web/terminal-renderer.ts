import {
  Terminal as XtermTerminal,
  type ITerminalInitOnlyOptions,
  type ITerminalOptions,
} from "@xterm/xterm";
import { Terminal as RefstreamTerminal } from "./vendor/refstream/v0.1.0-alpha.2/refstream.js";

export type TerminalRenderer = "xterm" | "refstream";
type TerminalOptions = ITerminalOptions & ITerminalInitOnlyOptions;

export interface TerminalSurface {
  readonly cols: number;
  readonly rows: number;
  options: {
    fontFamily?: string;
    fontSize?: number;
    lineHeight?: number;
    theme?: ITerminalOptions["theme"];
    disableStdin?: boolean;
  };
  readonly buffer: { readonly active: { readonly type: "normal" | "alternate" } };
  readonly modes: { readonly mouseTrackingMode: string };
  open(element: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  refresh(start: number, end: number): void;
  focus(): void;
  blur(): void;
  dispose(): void;
  scrollLines(lines: number): void;
  hasSelection(): boolean;
  getSelection(): string;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onBinary(listener: (data: string) => void): { dispose(): void };
  onTitleChange(listener: (title: string) => void): { dispose(): void };
}

export const TERMINAL_RENDERER_STORAGE_KEY = "shell-online-terminal-renderer";

export function readTerminalRenderer(): TerminalRenderer {
  try {
    return localStorage.getItem(TERMINAL_RENDERER_STORAGE_KEY) === "refstream"
      ? "refstream"
      : "xterm";
  } catch {
    return "xterm";
  }
}

export function writeTerminalRenderer(renderer: TerminalRenderer): void {
  try {
    localStorage.setItem(TERMINAL_RENDERER_STORAGE_KEY, renderer);
  } catch {
    // A private browser may forget the optional preference.
  }
}

export function createTerminal(
  renderer: TerminalRenderer,
  common: TerminalOptions,
  xtermOnly: TerminalOptions = {},
): TerminalSurface {
  if (renderer === "refstream") {
    return new RefstreamTerminal(common) as unknown as TerminalSurface;
  }
  return new XtermTerminal({ ...common, ...xtermOnly }) as unknown as TerminalSurface;
}
