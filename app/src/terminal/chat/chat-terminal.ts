/**
 * The chat renderer: a terminal surface that draws a conversation.
 *
 * It satisfies the same contract as xterm.js and Refstream, so the pane, the
 * socket, the encryption, the permission checks and the audit log are all
 * unchanged. What changes is what the bytes become on the way to the screen.
 *
 * Underneath there is still a terminal emulator. It is never opened, so it has
 * no renderer, no canvas and no DOM: it is the parser and the grid only, which
 * is the part that knows what the process actually meant. Reading finished
 * lines out of that grid is the whole trick, and it is why this handles
 * progress bars, wrapped lines, coloured output, a shell's prompt and a
 * full-screen editor correctly without a single regular expression over the
 * wire.
 *
 * The two halves of the conversation come from two different places, because
 * they are known at two different times:
 *
 *   sent      what this browser submitted, known exactly, the moment it is sent
 *   received  what the process finished writing, read from the grid behind it
 */

import { Terminal as XtermTerminal, type ITerminalInitOnlyOptions, type ITerminalOptions } from "@xterm/xterm";
import { InputLog } from "../../lib/input-log";
import { ChatView } from "./chat-view";
import { ScreenReader, paletteFromTheme, type ReaderTerminal } from "./screen-reader";
import { Transcript, type TranscriptLine } from "./transcript";
import { adapterFor, type AgentAdapter } from "./agents";

type TerminalOptions = ITerminalOptions & ITerminalInitOnlyOptions;

/**
 * Scrollback for the emulator behind the conversation.
 *
 * It only has to be deep enough that a burst of output cannot push a row out
 * before the reader has released it, and the reader runs after every chunk. A
 * thousand rows is orders of magnitude more than that, and the conversation
 * keeps its own, longer history in the transcript.
 */
const PARSE_SCROLLBACK = 1000;

/**
 * How long an agent's screen has to hold still before the row it stopped on
 * is taken to be finished rather than half-written.
 *
 * Longer than a repaint and shorter than a person notices. An agent redraws
 * several times a second while it is working, so this only ever elapses once
 * it has actually stopped.
 */
const AGENT_QUIET_MS = 400;

/**
 * How long after a line the Return that submits it is sent.
 *
 * They have to be two events, and this is what guarantees it. A program that
 * reads its own input -- which every agent here does -- treats a burst of
 * characters with a carriage return at the end of it as pasted text, and
 * deliberately does not submit on it: pasting a paragraph that happens to
 * contain a newline must not send half of it. So `text\r` written in one
 * chunk put the prompt in the agent's box and left it there, which is a send
 * button that does nothing.
 *
 * A frame is long enough for the program to have taken the text and short
 * enough that nobody sees the difference.
 */
const RETURN_AFTER_MS = 16;

/** The shell integration sequence terminals agree on for command boundaries. */
const SEMANTIC_PROMPT = 133;

export class ChatTerminal {
  readonly options: ChatOptions;

  private readonly inner: XtermTerminal;
  private readonly reader: ScreenReader;
  private readonly transcript = new Transcript();
  private readonly input = new InputLog();
  private readonly listeners = new Set<(data: string) => void>();
  private view: ChatView | null = null;

  private frame = 0;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private replaying = false;
  private onScreen = false;
  /** Set while the alternate screen has repainted since the last frame. */
  private screenDirty = false;
  private lastCommand = "";
  /**
   * The reader for the program on the alternate screen, when one recognises
   * it. Null means the screen is mirrored as a grid instead, which is the
   * honest answer for an editor, a pager, or an agent nobody has written an
   * adapter for.
   */
  private agent: AgentAdapter | null = null;
  /**
   * What the program set the window title to.
   *
   * The most reliable thing a full-screen program offers about its own
   * identity: a header is printed once and scrolls away, and a title stays.
   */
  private windowTitle = "";
  /** Whether a mirror card is open for a program no adapter could read. */
  private mirroring = false;
  private agentQuiet: ReturnType<typeof setTimeout> | null = null;
  /** Lines and Returns waiting to go out as separate events; see `enter`. */
  private outbox: string[] = [];
  private sending: ReturnType<typeof setTimeout> | null = null;
  /** Set by the shell's own markers; once seen, the timing rule steps aside. */
  private semantic = false;
  private disposed = false;

  constructor(options: TerminalOptions) {
    this.inner = new XtermTerminal({
      ...options,
      scrollback: PARSE_SCROLLBACK,
      allowProposedApi: true,
    });
    this.reader = new ScreenReader(paletteFromTheme(options.theme as Record<string, string> | undefined));
    this.options = new ChatOptions(this);

    this.inner.onWriteParsed(() => this.drain());
    this.inner.onTitleChange((title) => {
      this.windowTitle = title;
    });
    this.inner.parser.registerOscHandler(SEMANTIC_PROMPT, (data) => {
      this.semanticMarker(data);
      /* False, so any handler the emulator has of its own still runs. */
      return false;
    });
    /*
     * Leaving the alternate screen is the one moment worth intercepting. The
     * program's last frame is still on the grid here; one instruction later it
     * is gone, and the card would keep whatever the previous chunk happened to
     * catch instead of the frame it finished on.
     */
    this.inner.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (this.onScreen && params.some(isAltScreen)) {
        this.painted(this.reader.snapshot(this.inner as unknown as ReaderTerminal), Date.now());
        /* This is the last frame; a mirror still queued would paint a blank grid. */
        this.screenDirty = false;
      }
      return false;
    });
  }

  get cols(): number {
    return this.inner.cols;
  }

  get rows(): number {
    return this.inner.rows;
  }

  open(element: HTMLElement): void {
    this.view = new ChatView(element, {
      onSubmit: (text) => this.submit(text),
      onKeys: (bytes) => this.type(bytes),
    });
    this.view.setColumns(this.inner.cols);
    this.view.setDisabled(this.options.disableStdin ? "Watching. You cannot type in this session." : null);
    this.schedule();
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.inner.write(data, () => {
      this.drain();
      if (this.replaying) {
        this.replaying = false;
        this.transcript.endReplay();
        this.schedule();
      }
      callback?.();
    });
  }

  /** The relay is about to replay the session from the top. */
  reset(): void {
    /*
     * Every timer as well as every buffer. A quiet timer armed before a
     * replay fires afterwards and closes whatever is open by then, which
     * after a reset is something else entirely.
     */
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    if (this.agentQuiet) clearTimeout(this.agentQuiet);
    this.agentQuiet = null;
    this.agent?.reset();
    this.agent = null;
    this.mirroring = false;
    this.replaying = true;
    this.transcript.beginReplay();
    this.reader.rewind();
    /* Ctrl-U: drop a half-typed line, so it cannot be submitted after the replay. */
    this.input.push("\x15");
    this.onScreen = false;
    this.inner.reset();
    this.view?.setDirect(false);
  }

  resize(cols: number, rows: number): void {
    this.inner.resize(cols, rows);
    this.view?.setColumns(cols);
    this.schedule();
  }

  refresh(): void {
    this.schedule();
  }

  focus(): void {
    this.view?.focus();
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.quiet) clearTimeout(this.quiet);
    if (this.agentQuiet) clearTimeout(this.agentQuiet);
    if (this.sending) clearTimeout(this.sending);
    this.outbox = [];
    this.listeners.clear();
    this.reader.dispose();
    this.view?.dispose();
    this.view = null;
    this.inner.dispose();
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  /* --- what the pane sets on us ------------------------------------- */

  applyTheme(theme: Record<string, string> | undefined): void {
    this.reader.setPalette(paletteFromTheme(theme));
  }

  applyStdin(disabled: boolean): void {
    this.view?.setDisabled(disabled ? "Watching. You cannot type in this session." : null);
  }

  /* --- input -------------------------------------------------------- */

  /**
   * A whole line, composed in the box and submitted.
   *
   * The sent message is created here rather than being recovered from the
   * bytes, because here it is a fact. Recovering it would mean reading the
   * echo back off the grid, which is guesswork the moment a program stops
   * echoing, as every password prompt does.
   */
  private submit(text: string): void {
    if (this.options.disableStdin) return;
    /*
     * A bare Return is a real thing to send -- it is how a prompt waiting on
     * one is answered -- but it is not an utterance, so it goes over the wire
     * without leaving an empty bubble behind it.
     */
    if (text !== "") {
      this.transcript.submitted(text, Date.now());
      this.lastCommand = text;
    }
    this.enter(text);
    this.schedule();
  }

  /**
   * A line, and then the Return that submits it, as two separate events.
   *
   * The text goes as a paste where the program asked for pastes to be marked,
   * which is what tells it that a line arriving all at once is one thing
   * somebody pasted rather than somebody typing impossibly fast -- and, for a
   * shell, stops the characters in it being taken as editing commands. The
   * Return follows on its own; see RETURN_AFTER_MS for why it cannot go in
   * the same chunk.
   */
  private enter(text: string): void {
    if (text !== "") {
      const bracketed = this.inner.modes.bracketedPasteMode;
      this.outbox.push(bracketed ? `\x1b[200~${text}\x1b[201~` : text);
    }
    this.outbox.push("\r");
    this.flushOutbox();
  }

  /**
   * Sends one queued chunk now and the rest on their own ticks.
   *
   * A queue rather than a pair of timers, because a paste is several lines and
   * each of them is a line and a Return: sent as four timers they interleave,
   * and the shell receives two commands run together.
   */
  private flushOutbox(): void {
    if (this.sending) return;
    const next = this.outbox.shift();
    if (next === undefined) return;
    this.emit(next);
    if (this.outbox.length === 0) return;
    this.sending = setTimeout(() => {
      this.sending = null;
      this.flushOutbox();
    }, RETURN_AFTER_MS);
  }

  /** Bytes with no line behind them: a control chip, or a key in direct mode. */
  private type(bytes: string): void {
    if (this.options.disableStdin) return;
    this.emit(bytes);
    /*
     * Direct mode is a program reading keys, so the keys are not utterances
     * and do not belong in the conversation. The card below is showing them
     * land, which is the honest account of what is happening.
     */
    if (this.onScreen) return;
    const now = Date.now();
    for (const entry of this.input.push(bytes)) {
      if (entry.kind === "interrupt") this.transcript.interrupted(entry.text, now);
      else {
        this.transcript.submitted(entry.text, now);
        this.lastCommand = entry.text || this.lastCommand;
      }
    }
    this.schedule();
  }

  private emit(data: string): void {
    for (const listener of this.listeners) listener(data);
  }

  /* --- output ------------------------------------------------------- */

  /**
   * Moves everything the process has finished writing into the conversation.
   *
   * Called after every chunk the emulator parses, which keeps the reader at
   * most one chunk behind the cursor and so keeps it well inside scrollback.
   */
  private drain(): void {
    if (this.disposed) return;
    const now = Date.now();
    const terminal = this.inner as unknown as ReaderTerminal;
    const alternate = this.inner.buffer.active.type === "alternate";

    if (alternate && !this.onScreen) {
      this.onScreen = true;
      this.mirroring = false;
      this.agent = null;
      /*
       * The shell's quiet rule does not apply to a screen. Left armed, it
       * fires a few hundred milliseconds in and closes whatever the program
       * has started saying.
       */
      if (this.quiet) clearTimeout(this.quiet);
      this.quiet = null;
      this.view?.setDirect(true);
    }

    if (alternate) {
      /*
       * Mirrored once per frame, not once per chunk. A program redrawing at
       * speed can land a dozen chunks between two frames, and reading the
       * whole grid for each of them is work thrown away before anyone sees it.
       */
      this.screenDirty = true;
      this.schedule();
      return;
    }

    if (this.onScreen) {
      this.onScreen = false;
      if (this.agent) {
        /* Whatever it finished on, before it gave the screen back. */
        for (const utterance of this.agent.flush()) this.transcript.fromAgent(utterance, now);
        this.agent.reset();
        this.agent = null;
      } else {
        /* Null keeps the frame the exit handler caught on the way out. */
        this.transcript.screenClosed(null, now);
      }
      this.mirroring = false;
      this.view?.setDirect(false);
      /*
       * Reading resumes where it stopped. The alternate screen is a second
       * grid, so the one the conversation is built from was never touched,
       * and the mark left on it is still pointing at the right row.
       */
    }

    const { lines, gap } = this.reader.read(terminal);
    if (gap) this.transcript.noticed("Output scrolled past faster than it could be kept.", now, "gap");
    if (lines.length > 0) this.transcript.output(lines, now);
    this.armQuiet();
    this.schedule();
  }

  /**
   * A frame of whatever has taken the alternate screen.
   *
   * The first one decides how the rest are treated, because the program
   * drawing them does not change while it is running. If an adapter
   * recognises it, the conversation it is drawing is read out of it and
   * arrives as messages. If none does -- an editor, a pager, `top`, an agent
   * nobody has written an adapter for -- the screen is mirrored as a grid,
   * which is what this renderer did for everything before.
   */
  private painted(lines: TranscriptLine[], now: number): void {
    if (!this.agent) {
      /*
       * Asked again on every frame until something answers, rather than once
       * on the first. The first frame after a program takes the screen is the
       * one least likely to identify it: an agent draws a splash and then its
       * conversation, and a session resumed from earlier starts part-way
       * through one. Asked once, a program that could have been read was not,
       * and what a phone got instead was its raw grid.
       */
      this.agent = adapterFor(lines.map((line) => line.text), this.windowTitle);
      if (this.agent) {
        /*
         * Said out loud, and said differently when the reading is built on
         * the shape this family of programs share rather than on a captured
         * frame of this one. Somebody looking at a conversation that has gone
         * wrong should be able to see why from the thread rather than from
         * the source. The renderer menu on the pane is the way back to the
         * screen itself.
         */
        /*
         * The card that was mirroring the grid goes: what it was showing is
         * about to arrive as messages, and both would be the same thing
         * twice.
         */
        this.transcript.screenClosed(null, now);
        this.transcript.noticed(`Reading ${this.agent.title} as messages.`, now);
      } else if (!this.mirroring) {
        this.mirroring = true;
        this.transcript.screenOpened(this.lastCommand || "Full-screen program", now);
      }
    }

    if (!this.agent) {
      this.transcript.screenPainted(lines, now);
      return;
    }

    for (const utterance of this.agent.read(lines)) this.transcript.fromAgent(utterance, now);
    this.armAgentQuiet();
  }

  /**
   * An agent holds back the row it looks to be part-way through writing, so
   * the row it finished on needs somebody to say the writing stopped. Nothing
   * else can: the two are identical in a single frame, and the difference is
   * only whether another frame follows.
   */
  private armAgentQuiet(): void {
    if (this.agentQuiet) clearTimeout(this.agentQuiet);
    this.agentQuiet = setTimeout(() => {
      this.agentQuiet = null;
      if (!this.agent) return;
      const now = Date.now();
      let changed = false;
      for (const utterance of this.agent.flush()) {
        this.transcript.fromAgent(utterance, now);
        changed = true;
      }
      if (changed) this.schedule();
    }, AGENT_QUIET_MS);
  }

  /**
   * A shell that publishes command markers tells us exactly where one answer
   * ends, which is better than any pause can be. From the first marker on, the
   * timing rule is left alone.
   */
  private semanticMarker(data: string): void {
    const [kind, ...rest] = data.split(";");
    const now = Date.now();
    this.semantic = true;
    if (kind === "A") this.transcript.promptStarted(now);
    /*
     * B is the end of the prompt and the start of what gets typed, so the row
     * up to the cursor is the prompt itself. Reading it here is the only way
     * to know it exactly, and exactly is the only way it is safe to remove.
     */
    if (kind === "B") {
      this.transcript.setPrompt(this.promptUnderCursor());
      this.transcript.expectCommand();
    }
    if (kind === "C") this.transcript.commandStarted();
    if (kind === "D") {
      const code = Number.parseInt(rest[0] ?? "", 10);
      this.transcript.commandFinished(Number.isFinite(code) ? code : undefined, now);
    }
    this.schedule();
  }

  /** The current row up to the cursor, which at a B marker is the prompt. */
  private promptUnderCursor(): string {
    const buffer = this.inner.buffer.active;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    return line ? line.translateToString(false, 0, buffer.cursorX) : "";
  }

  /** Closes an answer that has stopped growing, unless the shell says so itself. */
  private armQuiet(): void {
    if (this.semantic) return;
    const deadline = this.transcript.quietDeadline;
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
    if (deadline === null) return;
    this.quiet = setTimeout(() => {
      this.quiet = null;
      if (this.transcript.settle(Date.now())) this.schedule();
    }, Math.max(0, deadline - Date.now()));
  }

  /** One redraw per frame, however many chunks landed in it. */
  private schedule(): void {
    if (this.disposed || this.frame || this.transcript.isReplaying) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.screenDirty) {
        this.screenDirty = false;
        if (this.onScreen) {
          this.painted(this.reader.snapshot(this.inner as unknown as ReaderTerminal), Date.now());
        }
      }
      this.view?.render(this.transcript.messages, this.transcript.revision);
    });
  }
}

/**
 * The options object the pane writes to.
 *
 * It is assigned rather than called — `term.options.theme = ...` — so the few
 * settings that mean something to a conversation are accessors that act on
 * assignment. The rest are kept so that reading one back gives what was set.
 */
class ChatOptions {
  fontSize?: number;
  lineHeight?: number;
  fileLinks?: unknown;

  private stdin = false;
  private palette: Record<string, string> | undefined;

  constructor(private readonly terminal: ChatTerminal) {}

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

/** 1049, 1047 and 47 are the three spellings of "the alternate screen". */
function isAltScreen(param: number | number[]): boolean {
  const value = Array.isArray(param) ? param[0] : param;
  return value === 1049 || value === 1047 || value === 47;
}
