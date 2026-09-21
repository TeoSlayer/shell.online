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

import { bytesForKey, chipsFor } from "./keys";
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

/** Rows a finished answer shows before it is folded. */
const COLLAPSE_AFTER = 40;

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
  private readonly chips: HTMLElement;
  private readonly jump: HTMLButtonElement;
  private readonly options: ChatViewOptions;

  private readonly nodes = new Map<number, Rendered>();
  private order: number[] = [];
  private drawnRevision = -1;
  /** Follows the newest message until the reader scrolls away from it. */
  private sticking = true;
  private direct = false;
  private disabled: string | null = null;
  private history: string[] = [];
  private historyAt = -1;
  private draft = "";
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
    this.chips = el("div", "chat-keys");
    this.drawChips();

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
    this.composer.append(this.chips, row);

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
            if (this.sticking) this.scroller.scrollTop = this.scroller.scrollHeight;
          });
    this.resizes?.observe(this.scroller);
    this.resizes?.observe(this.composer);

    this.scroller.addEventListener("scroll", this.onScroll);
    this.composer.addEventListener("submit", this.onSubmit);
    this.input.addEventListener("keydown", this.onKeyDown);
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
    this.input.placeholder = reason ?? (this.direct ? "Keys go straight to the program" : "Run a command");
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
    this.input.value = "";
    this.autosize();
    this.drawChips();
    this.setDisabled(this.disabled);
  }

  focus(): void {
    this.input.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.resizes?.disconnect();
    this.root.style.removeProperty("--chat-composer-height");
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.composer.removeEventListener("submit", this.onSubmit);
    this.input.removeEventListener("keydown", this.onKeyDown);
    this.input.removeEventListener("input", this.onInput);
    this.nodes.clear();
    this.order = [];
    this.root.innerHTML = "";
    this.root.classList.remove("chat-surface");
  }

  /* ----------------------------------------------------------------- */

  /** The control keys for the mode the composer is in. */
  private drawChips(): void {
    this.chips.replaceChildren();
    for (const chip of chipsFor(this.direct)) {
      const button = el("button", "chat-key") as HTMLButtonElement;
      button.type = "button";
      button.textContent = chip.label;
      button.title = chip.title;
      ChatView.keepsFocus(button);
      button.addEventListener("click", () => {
        if (this.disabled) return;
        this.options.onKeys(chip.bytes);
        this.input.focus();
      });
      this.chips.append(button);
    }
  }

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
      (message.kind === "sent" || message.kind === "received") &&
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

    /* A growing answer only pays for the lines it gained. */
    if (message.lines.length < node.lines) {
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

  private readonly onInput = (): void => {
    this.historyAt = -1;
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

    if (this.direct) {
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

    if (event.key === "Enter" && !event.shiftKey) {
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

  private autosize(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 168)}px`;
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
