/**
 * The terminal as this viewer's own screen, whatever grid the session runs at.
 *
 * A session has one grid, because a process can only be told one size. This
 * renderer keeps two terminals so that grid is never what limits a viewer:
 *
 * - The copy. An emulator that is never shown, at the session's grid, fed
 *   every byte the process writes. It is exactly the program's screen,
 *   because it is the same bytes parsed by the same emulator.
 * - The canvas. The terminal on the page, sized for this pane at a legible
 *   font. It is never written process output; each frame it is told what its
 *   rows show, from `layout.ts`, and only changed rows are sent to it.
 *
 * When the pane can show the whole grid at a legible size, the canvas is the
 * copy row for row, drawn as large as the pane allows. When it cannot, the
 * copy is laid out again at the pane's width. Either way the choice is a
 * function of the pane's size and the session's grid, made here, in this
 * browser: nothing is sent anywhere, nothing waits on a network, and no other
 * viewer can tell it happened.
 *
 * Scrolling is this renderer's own, over the laid-out document, because the
 * canvas's rows are not the program's rows and a scrollback of them would be
 * wrong the moment the pane changed width.
 */

import {
  Terminal as XtermTerminal,
  type IDisposable,
  type IMarker,
  type ITerminalInitOnlyOptions,
  type ITerminalOptions,
} from "@xterm/xterm";
import { fittedTerminal, type TerminalBox, type TerminalCell } from "../terminal-fit";
import { clampTerminalGrid, type TerminalGrid } from "../terminal-grid";
import {
  scrollAnchor,
  windowAtBottom,
  windowFrom,
  type Anchor,
  type LaidRow,
  type LayoutOptions,
} from "./layout";
import { Painter, type CursorPaint } from "./paint";
import { BufferScreen, type BufferLike } from "./source";

type TerminalOptions = ITerminalOptions & ITerminalInitOnlyOptions;

export interface AdaptiveLayoutInput {
  box: TerminalBox;
  measure: (fontSize: number) => TerminalCell;
  pixelRatio: number;
}

/*
 * Below this the session's grid is drawn too small to read, so it is laid out
 * again instead. It is the only threshold in the renderer, and it depends on
 * nothing but the pane and the grid.
 */
export const LEGIBLE_FONT_SIZE = 11;
/** The size text is laid out at when the grid is not drawn whole. */
export const READING_FONT_SIZE = 13;
const READING_LINE_HEIGHT = 1.2;
const MAX_LINE_HEIGHT = 1.35;

/* Private modes that change what a key or the mouse sends. */
const KEY_MODES = [1, 1004, 2004] as const;
const MOUSE_MODES = [9, 1000, 1002, 1003, 1005, 1006, 1015] as const;
const MOUSE_TRACKING = [9, 1000, 1002, 1003] as const;

export type AdaptiveMode = "whole" | "laid-out";

interface Scrolled {
  anchor: Anchor;
  /** Keeps the anchor on its row as the scrollback trims its oldest rows. */
  marker: IMarker | null;
}

export class AdaptiveTerminal {
  readonly options: AdaptiveOptions;
  private readonly copy: XtermTerminal;
  private readonly canvas: XtermTerminal;
  private readonly screen: BufferScreen;
  private readonly painter: Painter;
  private readonly disposables: IDisposable[] = [];
  private readonly privateModes = new Map<number, boolean>();
  private readonly applied = new Map<string, boolean>();
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly binaryListeners = new Set<(data: string) => void>();
  private mode: AdaptiveMode = "whole";
  private scrolled: Scrolled | null = null;
  private lastLayout: AdaptiveLayoutInput | null = null;
  private natural: TerminalGrid | null = null;
  private frame = 0;
  private wheelRows = 0;
  private rowPixels = 16;
  private removeListeners: (() => void) | null = null;
  private disposed = false;

  constructor(options: TerminalOptions) {
    const cols = options.cols ?? 120;
    const rows = options.rows ?? 36;
    this.copy = new XtermTerminal({ ...options, cols, rows, allowProposedApi: true });
    this.canvas = new XtermTerminal({ ...options, cols, rows, scrollback: 0, allowProposedApi: true });
    this.screen = new BufferScreen(this.copy.buffer.active as unknown as BufferLike, cols);
    this.painter = new Painter(this.canvas);
    this.options = new AdaptiveOptions(this, options);

    /* The copy's private modes decide what the canvas's keys and mouse send. */
    const track = (value: boolean) => (params: (number | number[])[]) => {
      for (const param of params) {
        const mode = Array.isArray(param) ? param[0] : param;
        if (typeof mode === "number") this.privateModes.set(mode, value);
      }
      return false;
    };
    this.disposables.push(
      this.copy.parser.registerCsiHandler({ prefix: "?", final: "h" }, track(true)),
      this.copy.parser.registerCsiHandler({ prefix: "?", final: "l" }, track(false)),
      this.copy.parser.registerEscHandler({ final: "c" }, () => {
        this.privateModes.clear();
        return false;
      }),
      this.canvas.onData((data) => {
        this.follow();
        for (const listener of this.dataListeners) listener(data);
      }),
      this.canvas.onBinary((data) => {
        for (const listener of this.binaryListeners) listener(data);
      }),
    );
    this.canvas.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.shiftKey) return true;
      if (event.key !== "PageUp" && event.key !== "PageDown") return true;
      this.scrollBy((event.key === "PageUp" ? -1 : 1) * Math.max(1, this.canvas.rows - 1));
      return false;
    });
  }

  /** The session's grid, which is what the pane tells this terminal to be. */
  get cols(): number {
    return this.copy.cols;
  }

  get rows(): number {
    return this.copy.rows;
  }

  /** Whether the grid is drawn whole or laid out again, for the pane and tests. */
  get currentMode(): AdaptiveMode {
    return this.mode;
  }

  /** The canvas's own grid: what this viewer is actually shown. */
  get viewGrid(): TerminalGrid {
    return { cols: this.canvas.cols, rows: this.canvas.rows };
  }

  /*
   * The shape the pane's touch adapter (touch-scroll.ts) scrolls: every drag
   * comes here as rows, because this renderer's scrolling is its own and is
   * the one that knows when to hand the wheel to the program instead.
   */
  readonly buffer = { active: { type: "normal" } } as const;
  readonly modes = { mouseTrackingMode: "none" } as const;

  /** Rows on screen, for turning a finger's travel into rows. */
  get visibleRows(): number {
    return this.canvas.rows;
  }

  scrollLines(lines: number): void {
    this.scrollOrForward(lines);
  }

  open(element: HTMLElement): void {
    this.canvas.open(element);
    /* A finger is turned into rows by the pane's touch adapter, which calls scrollLines. */
    const wheel = (event: WheelEvent) => this.onWheel(event);
    element.addEventListener("wheel", wheel, { capture: true, passive: false });
    this.removeListeners = () => element.removeEventListener("wheel", wheel, { capture: true });
    this.schedule();
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.copy.write(data, () => {
      this.schedule();
      callback?.();
    });
  }

  reset(): void {
    this.copy.reset();
    this.privateModes.clear();
    this.follow();
    this.painter.invalidate();
    this.schedule();
  }

  /** The session changed its grid. Only the copy follows it; the canvas is this pane's. */
  resize(cols: number, rows: number): void {
    if (cols === this.copy.cols && rows === this.copy.rows) return;
    this.copy.resize(cols, rows);
    this.follow();
    if (this.lastLayout) this.layout(this.lastLayout);
    else this.schedule();
  }

  refresh(_start: number, _end: number): void {
    this.painter.invalidate();
    this.paint();
  }

  focus(): void {
    this.canvas.focus();
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.removeListeners?.();
    this.scrolled?.marker?.dispose();
    for (const disposable of this.disposables) disposable.dispose();
    this.copy.dispose();
    this.canvas.dispose();
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onBinary(listener: (data: string) => void): { dispose(): void } {
    this.binaryListeners.add(listener);
    return { dispose: () => this.binaryListeners.delete(listener) };
  }

  /**
   * Chooses how this pane shows the session, from the pane's size alone.
   *
   * The grid is drawn whole, as large as it fits, when that is legible; it is
   * laid out at the pane's width otherwise. The same pane and the same grid
   * always choose the same way.
   */
  layout(input: AdaptiveLayoutInput): void {
    this.lastLayout = input;
    const { box, measure, pixelRatio } = input;
    if (box.width <= 0 || box.height <= 0) return;
    const session = { cols: this.copy.cols, rows: this.copy.rows };
    const whole = fittedTerminal(box, session, measure, { pixelRatio, maxLineHeight: MAX_LINE_HEIGHT });
    const reading = readingGrid(box, measure, pixelRatio);
    this.natural = reading.grid;

    let fontSize: number;
    let lineHeight: number;
    let grid: TerminalGrid;
    if (whole.fontSize >= LEGIBLE_FONT_SIZE) {
      this.mode = "whole";
      ({ fontSize, lineHeight } = whole);
      grid = session;
    } else {
      this.mode = "laid-out";
      fontSize = READING_FONT_SIZE;
      lineHeight = READING_LINE_HEIGHT;
      grid = reading.grid;
    }
    const cell = measure(fontSize);
    this.rowPixels = Math.max(1, Math.floor(Math.ceil(cell.height * pixelRatio) * lineHeight) / pixelRatio);

    let changed = false;
    if (this.canvas.options.fontSize !== fontSize) {
      this.canvas.options.fontSize = fontSize;
      changed = true;
    }
    if (this.canvas.options.lineHeight !== lineHeight) {
      this.canvas.options.lineHeight = lineHeight;
      changed = true;
    }
    if (this.canvas.cols !== grid.cols || this.canvas.rows !== grid.rows) {
      this.canvas.resize(grid.cols, grid.rows);
      changed = true;
    }
    if (changed) this.painter.invalidate();
    this.paint();
  }

  /**
   * The grid this pane would choose for itself: what it lays text out at.
   * Offered to the session's owner as "fit the program to my screen".
   */
  naturalGrid(): TerminalGrid | null {
    return this.natural;
  }

  /* ---------------------------------------------------------------------- */

  applyTheme(theme: Record<string, string> | undefined): void {
    this.canvas.options.theme = theme;
  }

  applyStdin(disabled: boolean): void {
    this.canvas.options.disableStdin = disabled;
  }

  /** Back to the foot of the document, where new output is. */
  private follow(): void {
    this.scrolled?.marker?.dispose();
    this.scrolled = null;
  }

  private schedule(): void {
    if (this.frame || this.disposed) return;
    if (typeof requestAnimationFrame !== "function") {
      this.paint();
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private layoutOptions(buffer: BufferLike): LayoutOptions {
    const alternate = buffer.type === "alternate";
    return {
      cursor: { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY },
      collapseBlankRuns: alternate,
      top: alternate ? buffer.baseY : 0,
    };
  }

  private activeBuffer(): BufferLike {
    const buffer = this.copy.buffer.active as unknown as BufferLike;
    this.screen.reset(buffer, this.copy.cols);
    return buffer;
  }

  /** Draws the current window into the canvas. Idempotent: a second call writes nothing. */
  paint(): void {
    if (this.disposed) return;
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    const buffer = this.activeBuffer();
    const cursorShown = this.privateModes.get(25) !== false;
    const height = this.canvas.rows;
    const width = this.canvas.cols;
    let rows: LaidRow[];
    let cursor: CursorPaint | null = null;

    if (this.mode === "whole") {
      const top = this.scrolled && buffer.type === "normal"
        ? Math.max(0, Math.min(this.anchorLine(), buffer.baseY))
        : buffer.baseY;
      if (this.scrolled && top >= buffer.baseY) this.follow();
      rows = [];
      for (let index = 0; index < height; index += 1) rows.push({ cells: [...this.screen.row(top + index).cells] });
      const cursorRow = buffer.baseY + buffer.cursorY - top;
      if (cursorRow >= 0 && cursorRow < height) cursor = { row: cursorRow, column: buffer.cursorX, visible: cursorShown };
    } else {
      const options = this.layoutOptions(buffer);
      let window = this.scrolled
        ? windowFrom(this.screen, width, height, { y: this.anchorLine(), offset: this.scrolled.anchor.offset }, options)
        : windowAtBottom(this.screen, width, height, options);
      /* Scrolled back down to where output arrives: follow it again. */
      if (this.scrolled && window.atBottom && window.rows.length < height) {
        this.follow();
        window = windowAtBottom(this.screen, width, height, options);
      }
      rows = window.rows;
      const index = rows.findIndex((row) => row.cursor !== undefined);
      if (index >= 0) cursor = { row: index, column: rows[index].cursor ?? 0, visible: cursorShown };
    }

    this.painter.paint(rows, height, width, cursor);
    this.syncModes();
  }

  private anchorLine(): number {
    const scrolled = this.scrolled;
    if (!scrolled) return 0;
    if (scrolled.marker) {
      if (scrolled.marker.isDisposed || scrolled.marker.line < 0) return 0;
      return scrolled.marker.line;
    }
    return scrolled.anchor.y;
  }

  private anchorTo(anchor: Anchor, buffer: BufferLike): void {
    this.scrolled?.marker?.dispose();
    let marker: IMarker | null = null;
    if (buffer.type === "normal") {
      marker = this.copy.registerMarker(anchor.y - (buffer.baseY + buffer.cursorY)) ?? null;
    }
    this.scrolled = { anchor, marker };
  }

  /** Scrolls this viewer's window by `delta` rows. Returns whether anything moved. */
  scrollBy(delta: number): boolean {
    if (delta === 0) return false;
    const buffer = this.activeBuffer();
    const height = this.canvas.rows;
    const width = this.canvas.cols;

    if (this.mode === "whole") {
      if (buffer.type !== "normal") return false;
      const current = this.scrolled ? this.anchorLine() : buffer.baseY;
      const next = Math.max(0, Math.min(buffer.baseY, current + delta));
      if (next === current) return false;
      if (next >= buffer.baseY) this.follow();
      else this.anchorTo({ y: next, offset: 0 }, buffer);
      this.paint();
      return true;
    }

    const options = this.layoutOptions(buffer);
    const bottom = windowAtBottom(this.screen, width, height, options).anchor;
    const current = this.scrolled ? { y: this.anchorLine(), offset: this.scrolled.anchor.offset } : bottom;
    const next = scrollAnchor(this.screen, width, current, delta, options);
    const pastBottom = next.y > bottom.y || (next.y === bottom.y && next.offset >= bottom.offset);
    if (next.y === current.y && next.offset === current.offset) return false;
    if (pastBottom) this.follow();
    else this.anchorTo(next, buffer);
    this.paint();
    return true;
  }

  private mouseTracking(): boolean {
    return MOUSE_TRACKING.some((mode) => this.privateModes.get(mode) === true);
  }

  /**
   * A wheel over the canvas scrolls this viewer's window. When there is
   * nowhere left to scroll and the program asked for the mouse, the wheel goes
   * to the program, which is how a full-screen agent's own history is reached.
   * Drawn whole with mouse tracking on, the canvas's coordinates are the
   * program's, so xterm reports the wheel itself.
   */
  private onWheel(event: WheelEvent): void {
    if (this.mode === "whole" && this.mouseTracking()) return;
    event.preventDefault();
    event.stopPropagation();
    const rows =
      event.deltaMode === 1 ? event.deltaY : event.deltaMode === 2 ? event.deltaY * this.canvas.rows : event.deltaY / this.rowPixels;
    this.wheelRows += rows;
    const whole = Math.trunc(this.wheelRows);
    if (whole === 0) return;
    this.wheelRows -= whole;
    this.scrollOrForward(whole);
  }

  private scrollOrForward(rows: number): void {
    if (this.scrollBy(rows)) return;
    if (!this.mouseTracking() || this.options.disableStdin) return;
    this.forwardWheel(rows);
  }

  /** Wheel reports at the middle of the session's grid, in the encoding the program chose. */
  private forwardWheel(rows: number): void {
    const button = rows < 0 ? 64 : 65;
    const x = Math.ceil(this.copy.cols / 2);
    const y = Math.ceil(this.copy.rows / 2);
    const count = Math.min(Math.abs(rows), 10);
    for (let index = 0; index < count; index += 1) {
      if (this.privateModes.get(1006)) {
        const report = `\x1b[<${button};${x};${y}M`;
        for (const listener of this.dataListeners) listener(report);
      } else {
        const report = `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(x, 223), 32 + Math.min(y, 223))}`;
        for (const listener of this.binaryListeners) listener(report);
      }
    }
  }

  /**
   * Gives the canvas the copy's key and mouse modes, so a key pressed on it
   * sends what the program asked for. Mouse modes only while the grid is drawn
   * whole: laid out, a cell on the canvas is not a cell of the program's.
   */
  private syncModes(): void {
    let out = "";
    const want = (key: string, on: boolean, set: string, unset: string) => {
      if ((this.applied.get(key) ?? false) === on) return;
      this.applied.set(key, on);
      out += on ? set : unset;
    };
    for (const mode of KEY_MODES) want(String(mode), this.privateModes.get(mode) === true, `\x1b[?${mode}h`, `\x1b[?${mode}l`);
    const mouse = this.mode === "whole";
    for (const mode of MOUSE_MODES) {
      want(String(mode), mouse && this.privateModes.get(mode) === true, `\x1b[?${mode}h`, `\x1b[?${mode}l`);
    }
    want("keypad", this.copy.modes.applicationKeypadMode, "\x1b=", "\x1b>");
    if (out) this.canvas.write(out);
  }
}

/** The grid a pane lays text out at: as many cells as fit at the reading size. */
export function readingGrid(
  box: TerminalBox,
  measure: (fontSize: number) => TerminalCell,
  pixelRatio: number,
): { grid: TerminalGrid } {
  const cell = measure(READING_FONT_SIZE);
  let cols = Math.max(1, Math.floor(box.width / Math.max(cell.width, 0.1)));
  while (cols > 1 && Math.round(cell.width * cols) > box.width) cols -= 1;
  const rowDevice = Math.max(1, Math.floor(Math.ceil(cell.height * pixelRatio) * READING_LINE_HEIGHT));
  const rows = Math.max(1, Math.floor((box.height * pixelRatio) / rowDevice));
  return { grid: clampTerminalGrid(cols, rows) };
}

/**
 * The options object the pane writes to. Assignments that mean something to
 * the canvas act on assignment; font size and leading are this renderer's
 * own choice, made in `layout`, so assigning them is kept but ignored.
 */
class AdaptiveOptions {
  fontSize?: number;
  lineHeight?: number;
  fileLinks?: unknown;
  private stdin = false;
  private palette: Record<string, string> | undefined;

  constructor(
    private readonly terminal: AdaptiveTerminal,
    initial: TerminalOptions,
  ) {
    this.fontSize = initial.fontSize;
    this.lineHeight = initial.lineHeight;
    this.palette = initial.theme as Record<string, string> | undefined;
  }

  get disableStdin(): boolean {
    return this.stdin;
  }

  set disableStdin(value: boolean) {
    this.stdin = value;
    this.terminal.applyStdin(value);
  }

  get theme(): Record<string, string> | undefined {
    return this.palette;
  }

  set theme(value: Record<string, string> | undefined) {
    this.palette = value;
    this.terminal.applyTheme(value);
  }
}
