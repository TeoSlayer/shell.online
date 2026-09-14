import {
  Terminal as XtermTerminal,
  type ITerminalInitOnlyOptions,
  type ITerminalOptions,
} from "@xterm/xterm";
import { Terminal as RefstreamTerminal } from "../../../web/vendor/refstream/v0.1.0-alpha.4/refstream.js";

export type TerminalRenderer = "xterm" | "refstream";
export const DEFAULT_TERMINAL_RENDERER: TerminalRenderer = "xterm";
type TerminalOptions = ITerminalOptions & ITerminalInitOnlyOptions;

export interface TerminalSurface {
  readonly cols: number;
  readonly rows: number;
  options: {
    fontSize?: number;
    lineHeight?: number;
    disableStdin?: boolean;
    fileLinks?: unknown;
  };
  open(element: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  refresh(start: number, end: number): void;
  focus(): void;
  dispose(): void;
  onData(listener: (data: string) => void): { dispose(): void };
}

const STORAGE_KEY = "shell-online-terminal-renderer";

export function readTerminalRenderer(): TerminalRenderer {
  try {
    return localStorage.getItem(STORAGE_KEY) === "refstream"
      ? "refstream"
      : DEFAULT_TERMINAL_RENDERER;
  } catch {
    return DEFAULT_TERMINAL_RENDERER;
  }
}

export function writeTerminalRenderer(renderer: TerminalRenderer): void {
  try {
    localStorage.setItem(STORAGE_KEY, renderer);
  } catch {
    // A private browser may forget the optional preference.
  }
}

export function createTerminal(renderer: TerminalRenderer, options: TerminalOptions): TerminalSurface {
  if (renderer === "refstream") {
    return new RefstreamTerminal(options) as unknown as TerminalSurface;
  }
  return new XtermTerminal({ ...options, allowProposedApi: true }) as unknown as TerminalSurface;
}
