import {
  Terminal as XtermTerminal,
  type ITerminalInitOnlyOptions,
  type ITerminalOptions,
} from "@xterm/xterm";
import { Terminal as RefstreamTerminal } from "../../../web/vendor/refstream/v0.1.0-alpha.5/refstream.js";
import { ChatTerminal } from "./chat/chat-terminal";
import { AdaptiveTerminal, type AdaptiveLayoutInput } from "./adaptive/adaptive-terminal";
import type { TerminalGrid } from "./terminal-grid";

/*
 * "adaptive" draws the session's grid whole where that is legible and lays it
 * out at the pane's width where it is not (see adaptive/). "xterm" is the
 * session's grid drawn whole at any size, as every pane did before.
 */
export type TerminalRenderer = "adaptive" | "xterm" | "refstream" | "chat";

const RENDERERS: readonly TerminalRenderer[] = ["adaptive", "xterm", "refstream", "chat"];
export const DEFAULT_TERMINAL_RENDERER: TerminalRenderer = "adaptive";
type TerminalOptions = ITerminalOptions &
  ITerminalInitOnlyOptions & {
    /**
     * Which session this is, for the renderers that keep something per
     * session. Only the chat renderer does: it keeps the conversation on the
     * device that watched it, locked with the session's own secret where
     * there is one. See chat/chat-history.ts.
     */
    session?: { id: string; secret: string | null };
  };

export interface TerminalSurface {
  /**
   * The conversation an agent recorded, when the renderer can use one.
   *
   * Only the chat renderer implements it: an emulator draws the screen the
   * agent painted and has nothing to do with a record of what it meant.
   */
  fromRecord?(payload: Uint8Array): void;
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
  /** Text renderers support bracketed paste; chat has its own native composer. */
  paste?(text: string): void;
  dispose(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  /**
   * Raw-byte input (legacy mouse reports, device queries). Only the xterm
   * surface implements it; the others have no binary input path.
   */
  onBinary?(listener: (data: string) => void): { dispose(): void };
  /**
   * A renderer that sizes itself. The pane hands it the box and a way to
   * measure the font, instead of choosing a font size for it.
   */
  layout?(input: AdaptiveLayoutInput): void;
  /** The grid this pane would pick for itself, offered as "fit to my screen". */
  naturalGrid?(): TerminalGrid | null;
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
    const chat = new ChatTerminal(options);
    /*
     * The conversation this device has already seen of this session, put back
     * before anything new arrives; see chat/chat-history.ts. The session's
     * identity is not one of xterm's options, so it is handed over here,
     * where both are in scope.
     */
    if (options.session) chat.rememberAs(options.session.id, options.session.secret);
    return chat as unknown as TerminalSurface;
  }
  if (renderer === "adaptive") {
    /* The session identity is for the chat renderer's history; xterm has no such option. */
    const { session: _session, ...terminalOptions } = options;
    return new AdaptiveTerminal(terminalOptions) as unknown as TerminalSurface;
  }
  return new XtermTerminal({ ...options, allowProposedApi: true }) as unknown as TerminalSurface;
}
