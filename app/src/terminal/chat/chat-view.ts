/**
 * Draws the conversation, and the floating box that talks to it.
 *
 * The view is plain DOM rather than React on purpose. It is created by
 * `createTerminal` and handed an element to open into, exactly as xterm.js and
 * Refstream are, so the pane around it does not need to know which renderer it
 * is holding. It is also the hot path: a build can finish a thousand lines in a
 * second, and a React tree rebuilt at that rate is the difference between a
 * conversation and a stutter.
 *
 * So it renders by difference. Messages are appended, never rebuilt; an open
 * message grows by the lines it gained since the last frame; and a frame that
 * changes nothing touches no nodes at all.
 */

import { bytesForKey } from "./keys";
import type { Message, StyleRun, TranscriptLine } from "./transcript";

export interface ChatViewOptions {
  /** A line the viewer wants to run. */
  onSubmit(text: string): void;
  /** Raw bytes: a control chip, or a key press in direct mode. */
  onKeys(bytes: string): void;
}

/*
 * The keyCode a browser reports while an input method is composing. Safari
 * does not set `isComposing` on keydown, so this is the only signal there.
 */
const COMPOSING = 229;

/**
 * Whether this is being read with a finger.
 *
 * It decides one thing, and it is the difference between a usable session and
 * an unusable one: whether a full-screen program gets the keys as they are
 * pressed, or gets a line when it is finished. See `composes`.
 *
 * Both tests, for the reason the stylesheet uses both: `pointer` is not
 * always reported honestly, and a phone-width window is a phone often enough
 * to be worth catching.
 */
function touchScreen(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(max-width: 760px)").matches;
}

/** Rows a finished answer shows before it is folded. */
const COLLAPSE_AFTER = 40;

/**
 * The sizes a mirrored grid is allowed to be drawn at.
 *
 * A program nobody has written an adapter for is shown as the grid it is: an
 * editor, a pager, `top`. The grid's width is the session's and is shared
 * with every other viewer, so it cannot be reflowed to a phone -- which
 * leaves the font as the only thing that can make eighty columns fit a
 * screen a third of that wide.
 *
 * The floor is where it stops trying, and it is set by legibility rather than
 * by fitting. Eighty columns only fit a phone at about six pixels, which is
 * not small text but absent text; a legible strip that can be swiped is worth
 * more than an illegible page that cannot. So under the floor the card keeps
 * the floor's size and scrolls sideways, and the fitting is what takes a
 * tablet, a landscape phone and a narrower grid from clipped to whole.
 */
const MIRROR_MAX_PX = 12;
const MIRROR_MIN_PX = 9;

/**
 * How wide a character is as a fraction of its font size, for the monospace
 * faces this app ships. Close enough to choose a size with; the grid is
 * measured by the browser afterwards either way.
 */
const MONO_ADVANCE = 0.6;

/** What the card spends on its own border and padding, either side. */
const MIRROR_GUTTER_PX = 28;

/** A pause long enough that the next message deserves a time of its own. */
const TIME_BREAK_MS = 5 * 60_000;

/**
 * How close two messages from the same side have to be to read as one turn.
 *
 * Messaging interfaces group a run of messages from one speaker: they sit
 * close together, share a corner, and only the last one is given a time. A
 * command's output arrives as several paragraphs within a second of each
 * other and is exactly that -- one turn, several things said.
 */
const GROUP_WINDOW_MS = 60_000;

/** Distance from the bottom still counted as "watching the latest". */
const STICK_SLACK_PX = 32;

interface Rendered {
  el: HTMLElement;
  body: HTMLElement | null;
  /** The message as last drawn, so a button pressed later reads what is there now. */
  message: Message;
  revision: number;
  lines: number;
}

export class ChatView {
  private readonly root: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly thread: HTMLElement;
  private readonly composer: HTMLFormElement;
  private readonly input: HTMLTextAreaElement;
  private readonly send: HTMLButtonElement;
  private readonly jump: HTMLButtonElement;
  private readonly options: ChatViewOptions;

  private readonly nodes = new Map<number, Rendered>();
  private order: number[] = [];
  private drawnRevision = -1;
  /** Follows the newest message until the reader scrolls away from it. */
  private sticking = true;
  private direct = false;
  /** Columns the session's grid is, for sizing a mirrored program to fit. */
  private columns = 0;
  private disabled: string | null = null;
  private history: string[] = [];
  private historyAt = -1;
  private draft = "";
  /*
   * Set by a keydown that asked for a line break on purpose, so the
   * beforeinput below lets that one through instead of sending. See onInsert.
   */
  private breaking = false;
  /** Decided once: a pointer does not become a finger while a session is open. */
  private readonly touch = touchScreen();
  private disposed = false;
  private readonly resizes: ResizeObserver | null;

  /**
   * Stops a control in the composer taking focus off the text box.
   *
   * On a phone, focus leaving the box closes the keyboard, which resizes the
   * page under the finger that is still coming down. The tap then lands
   * somewhere else, or on nothing, and the message is not sent -- and even
   * when it did work, the keyboard closed and reopened around every chip.
   * Refusing the default on mousedown keeps the focus, and with it the
   * keyboard and the layout, exactly where they were.
   */
  private static keepsFocus(button: HTMLElement): void {
    button.addEventListener("mousedown", (event) => event.preventDefault());
  }

  constructor(root: HTMLElement, options: ChatViewOptions) {
    this.root = root;
    this.options = options;
    root.classList.add("chat-surface");
    root.innerHTML = "";

    this.scroller = el("div", "chat-scroll");
    this.thread = el("div", "chat-thread");
    this.thread.setAttribute("role", "log");
    this.thread.setAttribute("aria-live", "polite");
    this.thread.setAttribute("aria-label", "Session transcript");
    this.scroller.append(this.thread);

    this.jump = el("button", "chat-jump") as HTMLButtonElement;
    this.jump.type = "button";
    this.jump.textContent = "Jump to latest";
    this.jump.hidden = true;
    ChatView.keepsFocus(this.jump);
    this.jump.addEventListener("click", () => {
      this.sticking = true;
      this.jump.hidden = true;
      this.scroller.scrollTop = this.scroller.scrollHeight;
    });

    this.composer = el("form", "chat-composer") as HTMLFormElement;

    const row = el("div", "chat-row");
    this.input = el("textarea", "chat-input") as HTMLTextAreaElement;
    this.input.rows = 1;
    this.input.placeholder = "Run a command";
    this.input.spellcheck = false;
    this.input.autocapitalize = "off";
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("autocorrect", "off");
    /*
     * Labels the phone's return key "send" rather than "return", and stops a
     * shell command being autocorrected into English on the way to a machine.
     */
    this.input.setAttribute("enterkeyhint", "send");
    this.input.setAttribute("aria-label", "Send to the session");
    this.send = el("button", "chat-send") as HTMLButtonElement;
    this.send.type = "submit";
    this.send.setAttribute("aria-label", "Send");
    this.send.innerHTML = arrowSvg();
    ChatView.keepsFocus(this.send);
    row.append(this.input, this.send);
    this.composer.append(row);

    root.append(this.scroller, this.jump, this.composer);

    /*
     * A phone's keyboard opening does not add a message; it takes away most
     * of the room the thread had. Nothing re-renders, so the scroll position
     * stays where it was and the newest message -- the one somebody is
     * replying to -- ends up above the fold at the exact moment they started
     * typing. Following the bottom through the resize is what makes the
     * keyboard arriving feel like the composer rising rather than the
     * conversation falling out from under it.
     */
    this.resizes =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              /*
               * The thread ends above the composer, and the composer is not a
               * fixed height: it carries a row of keys that changes with the
               * mode and a box that grows with what is being typed. Measured
               * rather than guessed, because a guess that is three pixels
               * short still puts the newest message behind the glass.
               */
              if (entry.target === this.composer) {
                /*
                 * offsetHeight, not the entry's content box: the composer's
                 * padding and border are part of what the thread has to clear,
                 * and offsetHeight is already in the element's own units,
                 * which is what a length written back into CSS has to be in a
                 * subtree the phone breakpoint zooms.
                 */
                this.root.style.setProperty(
                  "--chat-composer-height",
                  `${this.composer.offsetHeight}px`,
                );
              }
            }
            this.fitMirrors();
            if (this.sticking) this.scroller.scrollTop = this.scroller.scrollHeight;
          });
    this.resizes?.observe(this.scroller);
    this.resizes?.observe(this.composer);

    this.scroller.addEventListener("scroll", this.onScroll);
    this.composer.addEventListener("submit", this.onSubmit);
    this.input.addEventListener("keydown", this.onKeyDown);
    this.input.addEventListener("beforeinput", this.onInsert);
    this.input.addEventListener("input", this.onInput);
  }

  /**
   * Redraws whatever changed.
   *
   * The revision is the whole check: the transcript bumps it on any change, so
   * a session printing nothing costs one integer comparison per frame.
   */
  render(messages: readonly Message[], revision: number): void {
    if (this.disposed || revision === this.drawnRevision) return;
    this.drawnRevision = revision;
    const wasAtBottom = this.sticking;

    /* Messages are dropped from the top as the conversation is trimmed. */
    const live = new Set(messages.map((message) => message.id));
    for (const id of this.order) {
      if (live.has(id)) continue;
      const node = this.nodes.get(id);
      if (node) {
        node.el.remove();
        this.nodes.delete(id);
      }
    }
    this.order = [];

    let previous: Message | null = null;
    for (const message of messages) {
      this.order.push(message.id);
      let node = this.nodes.get(message.id);
      if (!node) {
        node = this.create(message, previous);
        this.nodes.set(message.id, node);
        this.thread.append(node.el);
      }
      if (node.revision !== message.revision) this.update(node, message);
      previous = message;
    }

    this.history = messages.filter((m) => m.kind === "sent" && m.text).map((m) => m.text);
    if (wasAtBottom) {
      this.scroller.scrollTop = this.scroller.scrollHeight;
      this.jump.hidden = true;
    } else {
      this.jump.hidden = false;
    }
  }

  /** The reason typing is refused, or null when the viewer may type. */
  setDisabled(reason: string | null): void {
    this.disabled = reason;
    this.input.disabled = reason !== null;
    this.send.disabled = reason !== null;
    this.composer.dataset.disabled = reason === null ? "false" : "true";
    this.input.placeholder =
      reason ??
      (this.composes()
        ? this.direct
          ? "Message the program"
          : "Run a command"
        : "Keys go straight to the program");
  }

  /**
   * Direct mode, for as long as a full-screen program owns the screen.
   *
   * A program that draws its own interface reads keys, not lines, so the box
   * stops composing and starts forwarding. Nothing else about the conversation
   * changes: the history above stays where it is, and the card below shows
   * what the program is painting.
   */
  setDirect(on: boolean): void {
    if (this.direct === on) return;
    this.direct = on;
    this.root.dataset.direct = on ? "true" : "false";
    /*
     * Only where the box is about to stop being a box. Where it still
     * composes, a program taking the screen is no reason to throw away the
     * line somebody is halfway through typing into it.
     */
    if (!this.composes()) this.input.value = "";
    this.autosize();
    this.setDisabled(this.disabled);
  }

  /**
   * Whether the box composes a line, or forwards each key as it is pressed.
   *
   * A full-screen program reads keys, so forwarding them is right -- on a
   * keyboard. On a phone it was the single worst thing in this renderer: the
   * box stayed empty while what you typed was painted into the program's own
   * input box, which is somewhere inside an eighty-column grid that does not
   * fit the screen. You typed a prompt to an agent and could not see it.
   *
   * So a touch screen composes even in direct mode. What it gives up is the
   * arrow keys, which a phone keyboard does not have, and the control keys,
   * which are the chips above the box and were already the only way to reach
   * them here.
   */
  private composes(): boolean {
    return !this.direct || this.touch;
  }

  /**
   * How wide the session's grid is, so a program drawn as a grid can be
   * sized to fit rather than clipped at the edge of the screen.
   */
  setColumns(columns: number): void {
    if (this.columns === columns) return;
    this.columns = columns;
    this.fitMirrors();
  }

  /**
   * Picks a font size at which the whole width of the grid is on the screen.
   *
   * Only ever smaller than the size it would otherwise be drawn at, and never
   * smaller than the floor: past that, sideways is the honest answer.
   */
  private fitMirrors(): void {
    const room = this.scroller.clientWidth - MIRROR_GUTTER_PX;
    if (this.columns <= 0 || room <= 0) return;
    const fitted = room / this.columns / MONO_ADVANCE;
    const size = Math.max(MIRROR_MIN_PX, Math.min(MIRROR_MAX_PX, Math.floor(fitted * 10) / 10));
    this.root.style.setProperty("--chat-mirror-size", `${size}px`);
  }

  focus(): void {
    this.input.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.resizes?.disconnect();
    this.root.style.removeProperty("--chat-composer-height");
    this.root.style.removeProperty("--chat-mirror-size");
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.composer.removeEventListener("submit", this.onSubmit);
    this.input.removeEventListener("keydown", this.onKeyDown);
    this.input.removeEventListener("beforeinput", this.onInsert);
    this.input.removeEventListener("input", this.onInput);
    this.nodes.clear();
    this.order = [];
    this.root.innerHTML = "";
    this.root.classList.remove("chat-surface");
  }

  /* ----------------------------------------------------------------- */

  private create(message: Message, previous: Message | null): Rendered {
    const el = document.createElement("div");
    el.className = `chat-msg chat-${message.kind}`;
    el.dataset.kind = message.kind;
    if (message.tone) el.dataset.tone = message.tone;

    /*
     * Continues the turn above it: same speaker, close enough in time, and
     * not a screen card or a notice, both of which are events in their own
     * right rather than something said.
     */
    const grouped =
      previous !== null &&
      previous.kind === message.kind &&
      (message.kind === "sent" || message.kind === "received" || message.kind === "tool") &&
      message.at - previous.at <= GROUP_WINDOW_MS;
    el.dataset.grouped = grouped ? "true" : "false";

    if (!previous || message.at - previous.at > TIME_BREAK_MS) {
      const stamp = document.createElement("div");
      stamp.className = "chat-time";
      stamp.textContent = clock(message.at);
      el.append(stamp);
    }

    if (message.kind === "screen") {
      return { el, body: this.screenCard(el, message), message, revision: -1, lines: 0 };
    }
    if (message.kind === "notice") {
      return { el, body: this.noticeCard(el, message), message, revision: -1, lines: 0 };
    }
    if (message.kind === "tool") {
      return { el, body: this.toolCard(el, message), message, revision: -1, lines: 0 };
    }

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    const body = document.createElement("div");
    body.className = "chat-body";
    bubble.append(body);
    el.append(bubble);

    const rendered: Rendered = { el, body, message, revision: -1, lines: 0 };

    if (message.kind === "received") {
      const meta = document.createElement("div");
      meta.className = "chat-meta";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "chat-copy";
      copy.textContent = "Copy";
      ChatView.keepsFocus(copy);
      copy.addEventListener("click", () => {
        /*
         * Copied from the lines, not from the element. The rows are separate
         * elements, so the element's text runs them all together: copying a
         * directory listing this way produced one unbroken string.
         */
        const text = rendered.message.lines.map((line) => line.text).join("\n");
        void navigator.clipboard?.writeText(text).then(() => {
          copy.textContent = "Copied";
          setTimeout(() => { copy.textContent = "Copy"; }, 1400);
        });
      });
      meta.append(copy);
      bubble.append(meta);
    }

    return rendered;
  }

  private noticeCard(el: HTMLElement, message: Message): HTMLElement {
    const chip = document.createElement("div");
    chip.className = "chat-chip";
    chip.textContent = message.text;
    el.append(chip);
    return chip;
  }

  /**
   * An agent running something rather than saying something.
   *
   * One line for what it ran and one for what came back, because that is what
   * a person scanning a conversation wants from it: that the agent read a
   * file, and roughly what it found. The whole of a tool's output is the
   * session's, and the session is a tap away in the terminal renderer.
   */
  private toolCard(el: HTMLElement, message: Message): HTMLElement {
    const card = document.createElement("div");
    card.className = "chat-tool";
    const name = document.createElement("span");
    name.className = "chat-tool-name";
    name.textContent = message.text;
    const detail = document.createElement("span");
    detail.className = "chat-tool-detail";
    card.append(name, detail);
    el.append(card);
    return card;
  }

  private screenCard(el: HTMLElement, message: Message): HTMLElement {
    const card = document.createElement("div");
    card.className = "chat-screen";
    const head = document.createElement("div");
    head.className = "chat-screen-head";
    const title = document.createElement("span");
    title.textContent = message.title || "Full-screen program";
    const state = document.createElement("span");
    state.className = "chat-screen-state";
    state.textContent = "live";
    head.append(title, state);
    const host = document.createElement("div");
    host.className = "chat-screen-host";
    card.append(head, host);
    el.append(card);
    return card;
  }

  private update(node: Rendered, message: Message): void {
    node.revision = message.revision;
    node.message = message;
    node.el.dataset.open = message.open ? "true" : "false";
    const body = node.body;
    if (!body) return;

    if (message.kind === "sent" || message.kind === "notice") {
      if (body.textContent !== message.text) body.textContent = message.text;
      return;
    }

    if (message.kind === "tool") {
      const name = body.querySelector<HTMLElement>(".chat-tool-name");
      if (name && name.textContent !== message.text) name.textContent = message.text;
      const detail = body.querySelector<HTMLElement>(".chat-tool-detail");
      const said = message.lines.map((line) => line.text).join(" · ");
      if (detail && detail.textContent !== said) detail.textContent = said;
      return;
    }

    if (message.kind === "screen") {
      const state = body.querySelector<HTMLElement>(".chat-screen-state");
      if (state) state.textContent = message.live ? "live" : "exited";
      const host = body.querySelector<HTMLElement>(".chat-screen-host");
      if (host) {
        host.classList.toggle("is-still", !message.live);
        /*
         * The mirror is replaced whole. A grid being repainted has no stable
         * rows to diff against: row four of vim is a different line of the
         * file one keystroke later, so matching them up would cost more than
         * rebuilding forty small nodes.
         */
        const next = document.createDocumentFragment();
        for (const line of message.lines) next.append(lineNode(line));
        host.replaceChildren(next);
      }
      return;
    }

    /*
     * Prose wraps; a listing does not. Terminal output is a mix of the two,
     * and showing all of it preformatted is what made a long sentence run off
     * the side of a phone while a table had nothing to align against.
     */
    body.dataset.shape = message.preformatted ? "pre" : "prose";
    node.el.dataset.shape = body.dataset.shape;
    /*
     * Copy belongs on the things worth copying. Now that an answer arrives as
     * several short messages rather than one block, a control on every one of
     * them was a column of buttons down the side of the conversation. A
     * listing or a block of several lines earns one; a single sentence is
     * quicker to select than to reach for.
     */
    node.el.dataset.copyable =
      message.preformatted || message.lines.length > 2 ? "true" : "false";

    /*
     * A growing answer only pays for the lines it gained.
     *
     * The test is "no more lines than last time" rather than "fewer",
     * because not every change is a line arriving at the end. An agent's
     * paragraph is re-read from its screen on every frame and put back
     * together as it grows, so the same line comes back longer than it was;
     * rendered by appending, the row already on screen was never touched and
     * the paragraph stopped one row short of what the agent had written. A
     * message whose line count has not gone up is rebuilt, which costs
     * nothing on the short messages that is true of and never happens to the
     * long ones, where lines only ever arrive at the end.
     */
    if (message.lines.length <= node.lines) {
      body.innerHTML = "";
      node.lines = 0;
    }
    const fragment = document.createDocumentFragment();
    for (let index = node.lines; index < message.lines.length; index += 1) {
      fragment.append(lineNode(message.lines[index]));
    }
    if (fragment.childNodes.length > 0) body.append(fragment);
    node.lines = message.lines.length;

    this.fold(node, message);
    this.stamp(node, message);
  }

  /**
   * Folds an answer too long to read at once.
   *
   * Only once it is finished: folding output that is still arriving hides the
   * very line somebody is waiting for.
   */
  private fold(node: Rendered, message: Message): void {
    const folded = node.el.querySelector<HTMLElement>(".chat-more");
    if (message.open || message.lines.length <= COLLAPSE_AFTER) {
      folded?.remove();
      node.el.dataset.folded = "false";
      return;
    }
    if (folded) return;
    node.el.dataset.folded = "true";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "chat-more";
    more.textContent = `Show all ${message.lines.length} lines`;
    more.addEventListener("click", () => {
      node.el.dataset.folded = "false";
      more.remove();
    });
    node.el.querySelector(".chat-bubble")?.append(more);
  }

  /**
   * The exit status, when the shell reported one. Zero is not worth saying.
   *
   * It goes in the bubble rather than in the meta row beside Copy: that row
   * only appears under the pointer, and a command's failure is not something
   * to be found by hovering over it.
   */
  private stamp(node: Rendered, message: Message): void {
    const existing = node.el.querySelector<HTMLElement>(".chat-exit");
    if (message.exitCode === undefined || message.exitCode === 0) {
      existing?.remove();
      return;
    }
    const chip = existing ?? document.createElement("div");
    chip.className = "chat-exit";
    chip.textContent = `exit ${message.exitCode}`;
    if (!existing) node.el.querySelector(".chat-bubble")?.append(chip);
  }

  private readonly onScroll = (): void => {
    const distance = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight;
    this.sticking = distance <= STICK_SLACK_PX;
    this.jump.hidden = this.sticking;
  };

  /**
   * Sending, for the keyboards that do not report which key was pressed.
   *
   * A phone's keyboard with predictive text on does not say. iOS reports
   * every key as the composition placeholder -- keyCode 229, key
   * "Unidentified" -- including Return, and the keydown rule below therefore
   * never fires: the return key did nothing, the command stayed in the box,
   * and it looked exactly like a message that failed to send. Trying again
   * usually worked, because the second attempt often came after the
   * prediction had settled, which is what made it intermittent.
   *
   * `beforeinput` says what the browser is about to do rather than which key
   * asked for it, and "insert a line break" is the one thing a box that sends
   * on Return must not do. Every engine fires it, the keydown rule cancels
   * the event before it on a desktop, and what is left is exactly the case
   * the keydown rule could not see.
   */
  private readonly onInsert = (event: InputEvent): void => {
    if (event.inputType !== "insertLineBreak" && event.inputType !== "insertParagraph") return;
    /* Shift-Return asked for a line break and is allowed to have one. */
    if (this.breaking) {
      this.breaking = false;
      return;
    }
    event.preventDefault();
    if (this.disabled) return;
    /*
     * Direct mode is a program reading keys, so Return is a byte rather than
     * a line. The keydown rule normally turns it into one and cancels this
     * event before it ever fires; on the keyboards that do not say which key
     * was pressed it does not, and this is the same key arriving by the only
     * route left.
     */
    if (!this.composes()) {
      this.options.onKeys("\r");
      return;
    }
    this.submit();
  };

  private readonly onInput = (): void => {
    this.historyAt = -1;
    this.breaking = false;
    this.autosize();
  };

  private readonly onSubmit = (event: Event): void => {
    event.preventDefault();
    this.submit();
    /*
     * Inside the gesture that pressed Send, so a phone keeps the keyboard up
     * rather than closing it and reopening it for the next command. Nothing
     * to do when the box already has focus, which is the keyboard case.
     */
    this.input.focus();
  };

  private submit(): void {
    if (this.disabled) return;
    const text = this.input.value;
    if (text === "") return;
    this.input.value = "";
    this.historyAt = -1;
    this.draft = "";
    this.autosize();
    /*
     * A pasted block is a command per line, which is what a shell would do
     * with it. A block that ends in a newline ends in one empty piece, which
     * is punctuation rather than a command, so it is not sent as one.
     */
    const lines = text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) this.options.onSubmit(line);
    /*
     * Sending something is an explicit act of attention, so the thread
     * follows the answer to it even if the reader had scrolled away. Output
     * that arrives on its own never does this: a build finishing does not get
     * to take somebody off the line they were reading.
     */
    this.sticking = true;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.disabled) return;

    if (!this.composes()) {
      /*
       * Every key belongs to the program, except the ones that belong to the
       * browser. bytesForKey returns null for those, and the default action
       * then happens as it would on any page.
       */
      const bytes = bytesForKey(event);
      if (bytes === null) return;
      event.preventDefault();
      this.options.onKeys(bytes);
      return;
    }

    /*
     * A phone keyboard predicting a word, and every language that composes
     * one, send Enter to accept the suggestion rather than to submit. Acting
     * on it sends half a command and leaves the rest in the box.
     */
    if (event.isComposing || event.keyCode === COMPOSING) return;

    if (event.key === "Enter") {
      if (event.shiftKey) {
        /* The beforeinput that follows is a line break somebody asked for. */
        this.breaking = true;
        return;
      }
      /*
       * Cleared here as well as when the line break lands, so a Shift-Return
       * whose beforeinput never arrived cannot leave the flag set and swallow
       * the next Return.
       */
      this.breaking = false;
      event.preventDefault();
      this.submit();
      return;
    }

    /* Ctrl-C with nothing selected interrupts the session rather than the box. */
    if (event.key === "c" && event.ctrlKey && !window.getSelection()?.toString()) {
      event.preventDefault();
      this.options.onKeys("\x03");
      return;
    }

    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey) {
      if (this.recall(event.key === "ArrowUp" ? 1 : -1)) event.preventDefault();
    }
  };

  /**
   * Walks back through what was sent, the way a shell's own history does.
   *
   * Only from the ends of the text, so the arrows still move the caret inside
   * a command somebody is editing.
   */
  private recall(direction: number): boolean {
    const atStart = this.input.selectionStart === 0 && this.input.selectionEnd === 0;
    const atEnd =
      this.input.selectionStart === this.input.value.length &&
      this.input.selectionEnd === this.input.value.length;
    if (direction > 0 ? !atStart && this.input.value !== "" : !atEnd && this.input.value !== "") {
      if (this.historyAt < 0) return false;
    }
    if (this.history.length === 0) return false;
    if (this.historyAt < 0) this.draft = this.input.value;
    const next = this.historyAt + direction;
    if (next < 0) {
      this.historyAt = -1;
      this.input.value = this.draft;
      this.autosize();
      return true;
    }
    if (next >= this.history.length) return true;
    this.historyAt = next;
    this.input.value = this.history[this.history.length - 1 - next];
    this.autosize();
    const end = this.input.value.length;
    requestAnimationFrame(() => this.input.setSelectionRange(end, end));
    return true;
  }

  /**
   * Grows the box with what is being typed, between two limits.
   *
   * The floor is the send button beside it, measured rather than written
   * down. The row aligns to its bottom so that a box three lines tall keeps
   * the button on the last one, and with an empty box shorter than the button
   * that same rule left the line somebody was typing floating above the
   * button's centre, which on a phone is the composer looking assembled
   * rather than designed. Measured, because the button is one size for a
   * pointer and another for a finger.
   *
   * The ceiling is about six lines, after which the box scrolls: past that it
   * is eating the conversation it is being typed into.
   */
  private autosize(): void {
    this.input.style.height = "auto";
    const floor = this.send.offsetHeight;
    this.input.style.height = `${Math.min(Math.max(this.input.scrollHeight, floor), 168)}px`;
  }
}

function lineNode(line: TranscriptLine): HTMLElement {
  const node = document.createElement("div");
  node.className = "chat-line";
  if (line.text === "") {
    node.append(document.createTextNode(" "));
    return node;
  }
  /* The common case is one unstyled run, which needs no elements of its own. */
  if (line.runs.length <= 1 && !styled(line.runs[0])) {
    node.textContent = line.text;
    return node;
  }
  for (const run of line.runs) node.append(runNode(run));
  return node;
}

function runNode(run: StyleRun): Node {
  if (!styled(run)) return document.createTextNode(run.text);
  const span = document.createElement("span");
  /* textContent, never innerHTML: this is output from somebody else's machine. */
  span.textContent = run.text;
  if (run.fg) span.style.color = run.fg;
  if (run.bg) span.style.backgroundColor = run.bg;
  if (run.bold) span.style.fontWeight = "700";
  if (run.dim) span.style.opacity = "0.62";
  if (run.italic) span.style.fontStyle = "italic";
  if (run.underline) span.style.textDecoration = "underline";
  return span;
}

function styled(run: StyleRun | undefined): boolean {
  if (!run) return false;
  return Boolean(run.fg || run.bg || run.bold || run.dim || run.italic || run.underline);
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function arrowSvg(): string {
  return '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false"><path d="M8 13V3M8 3 3.6 7.4M8 3l4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
