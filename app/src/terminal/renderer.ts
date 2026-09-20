import {
  Terminal as XtermTerminal,
  type ITerminalInitOnlyOptions,
  type ITerminalOptions,
} from "@xterm/xterm";
import { Terminal as RefstreamTerminal } from "../../../web/vendor/refstream/v0.1.0-alpha.5/refstream.js";
import { ChatTerminal } from "./chat/chat-terminal";

export type TerminalRenderer = "xterm" | "refstream" | "chat";

const RENDERERS: readonly TerminalRenderer[] = ["xterm", "refstream", "chat"];
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
    theme?: Record<string, string>;
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

export function isTerminalRenderer(value: unknown): value is TerminalRenderer {
  return typeof value === "string" && (RENDERERS as readonly string[]).includes(value);
}

export function readTerminalRenderer(): TerminalRenderer {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isTerminalRenderer(stored) ? stored : DEFAULT_TERMINAL_RENDERER;
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
  if (renderer === "chat") {
    return new ChatTerminal(options) as unknown as TerminalSurface;
  }
  return new XtermTerminal({ ...options, allowProposedApi: true }) as unknown as TerminalSurface;
}
