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
  private readonly waiting: HTMLElement;
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
  private lastScrollTop = 0;
  private touchY: number | null = null;
  private pointerDown = false;
  private resumeOnScroll = false;
  private direct = false;
  /** Columns the session's grid is, for sizing a mirrored program to fit. */
  private disabled: string | null = null;
  private history: string[] = [];
  private historyAt = -1;
  private draft = "";
  /*
   * Set by a keydown that asked for a line break on purpose, so the
   * beforeinput below lets that one through instead of sending. See onInsert.
   */
  private breaking = false;
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
    /*
     * We restore a message anchor ourselves, including mobile CSS zoom.
     * Native anchoring would apply a second correction after layout.
     */
    this.scroller.style.overflowAnchor = "none";
    this.scroller.tabIndex = 0;
    /*
     * Something to look at before there is anything to read.
     *
     * A session takes a moment to connect, and an agent takes longer than
     * that to draw its first screen. An empty thread in the meantime says
     * nothing about whether anything is happening -- it looks the same as a
     * session that has finished and the same as one that is broken.
     */
    this.waiting = el("div", "chat-waiting");
    this.waiting.setAttribute("role", "status");
    const waitingDots = el("div", "chat-waiting-dots");
    waitingDots.setAttribute("aria-hidden", "true");
    for (let dot = 0; dot < 3; dot += 1) waitingDots.append(el("span", "chat-waiting-dot"));
    const waitingLabel = el("p", "chat-waiting-label");
    waitingLabel.textContent = "Waiting for the session";
    this.waiting.append(waitingDots, waitingLabel);

    this.thread = el("div", "chat-thread");
    this.thread.setAttribute("role", "log");
    this.thread.setAttribute("aria-live", "polite");
    this.thread.setAttribute("aria-label", "Session transcript");
    this.scroller.append(this.waiting, this.thread);

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
    /*
     * Sent by its own handler rather than by submitting the form around it.
     *
     * A submit button in a form is supposed to be enough, and on a pointer it
     * is. On a phone it was not: the thing under the finger is the arrow
     * inside the button rather than the button, the focus guard above cancels
     * the default of the press, and between the two the tap stopped producing
     * a submit -- so the only way to send was the return key. Asking the
     * button directly removes every step that could go wrong.
     */
    /*
     * And sent from the press, not only from the click.
     *
     * A click is the end of a sequence -- touchstart, touchend, mousedown,
     * mouseup, click -- and on a phone that sequence is fragile in ways a
     * pointer's is not. The box is the thing the keyboard is pushing around,
     * the press guard above cancels the default of the mousedown, and if the
     * composer moves by a pixel between the finger landing and lifting, what
     * WebKit delivers is a cancelled gesture and no click at all. That is the
     * button that "only sometimes works", and it works every time from the
     * keyboard because the keyboard never goes near any of this.
     *
     * So the press sends, and the click that may or may not follow it is
     * ignored if it does. Guarded by the frame it happened in rather than by a
     * flag somebody has to remember to clear.
     */
    let sentAt = 0;
    const send = (event: Event) => {
      event.preventDefault();
      const now = performance.now();
      if (now - sentAt < 700) return;
      sentAt = now;
      this.submit();
      this.input.focus();
    };
    this.send.addEventListener("pointerup", send);
    this.send.addEventListener("click", send);
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
            if (this.sticking) this.scroller.scrollTop = this.scroller.scrollHeight;
          });
    this.resizes?.observe(this.scroller);
    this.resizes?.observe(this.composer);

    this.scroller.addEventListener("scroll", this.onScroll);
    this.scroller.addEventListener("wheel", this.onWheel, { passive: true });
    this.scroller.addEventListener("touchstart", this.onTouchStart, { passive: true });
    this.scroller.addEventListener("touchmove", this.onTouchMove, { passive: true });
    this.scroller.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    this.scroller.addEventListener("keydown", this.onScrollKey);
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
    /*
     * Follow only when the reader has not paused following and is still at
     * the bottom. Input intent can arrive before the native scroll event.
     *
     * `sticking` is maintained from scroll events, and a phone does not
     * deliver those while a flick is still gliding -- iOS batches them and
     * sends the last one when the scroll settles. A message arriving mid-flick
     * was therefore answered with wherever the reader had been a moment ago,
     * which for somebody who had just started scrolling up was "at the
     * bottom": the thread was pulled back down out from under them. The
     * scroller can be asked directly, and it always knows.
     */
    const wasAtBottom = this.sticking && !this.pointerDown && this.atBottom();
    this.sticking = wasAtBottom;
    /*
     * Where the reader is looking, so it can be put back.
     *
     * Anything can change height above the viewport: a paragraph re-read from
     * the agent's screen and re-wrapped, the oldest messages being trimmed off
     * the top, a tool line gaining its detail. Every one of those moves the
     * page under somebody reading further down by exactly that difference.
     * `overflow-anchor` is supposed to cover this and does not cover it here,
     * because the nodes it would anchor to are the nodes being replaced.
     */
    const anchor = wasAtBottom ? null : this.anchor();

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

    this.waiting.hidden = messages.length > 0;
    this.history = messages.filter((m) => m.kind === "sent" && m.text).map((m) => m.text);
    if (wasAtBottom) {
      this.scroller.scrollTop = this.scroller.scrollHeight;
      this.jump.hidden = true;
    } else {
      this.hold(anchor);
      this.jump.hidden = false;
    }
    this.lastScrollTop = this.scroller.scrollTop;
  }

  /** Whether the thread is close enough to its end to be following it. */
  private atBottom(): boolean {
    const { scrollHeight, scrollTop, clientHeight } = this.scroller;
    return scrollHeight - scrollTop - clientHeight <= STICK_SLACK_PX;
  }

  /** The first message on screen, and how far down the viewport it starts. */
  private anchor(): { el: HTMLElement; offset: number } | null {
    const top = this.scroller.getBoundingClientRect().top;
    for (const id of this.order) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const box = node.el.getBoundingClientRect();
      if (box.bottom > top) return { el: node.el, offset: box.top - top };
    }
    return null;
  }

  /** Puts that message back where it was, whatever happened above it. */
  private hold(anchor: { el: HTMLElement; offset: number } | null): void {
    if (!anchor || !anchor.el.isConnected) return;
    const top = this.scroller.getBoundingClientRect().top;
    const drift = anchor.el.getBoundingClientRect().top - top - anchor.offset;
    // Bounding boxes include CSS zoom (used by the mobile layout); scrollTop
    // is in layout pixels. Convert before restoring the reading position.
    const scale = this.scroller.offsetHeight > 0
      ? this.scroller.getBoundingClientRect().height / this.scroller.offsetHeight : 1;
    if (Math.abs(drift) > 0.5 && scale > 0) this.scroller.scrollTop += drift / scale;
  }

  /** The reason typing is refused, or null when the viewer may type. */
  setDisabled(reason: string | null): void {
    this.disabled = reason;
    this.input.disabled = reason !== null;
    this.send.disabled = reason !== null;
    this.composer.dataset.disabled = reason === null ? "false" : "true";
    this.input.placeholder = reason ?? (this.direct ? "Message the program" : "Run a command");
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
     * The line somebody is halfway through typing survives: a program taking
     * the screen is no reason to throw away what they were writing to it.
     */
    this.autosize();
    this.setDisabled(this.disabled);
  }

  /*
   * There is no forwarding mode any more, so there is no question to ask.
   *
   * The box used to forward each key straight to the program whenever a
   * program owned the screen, which is every agent session. That was right
   * while the grid those keys landed in was mirrored into the thread: you
   * could watch them arrive. The mirror is gone -- a grid does not go on a
   * phone, and a program that cannot be read as messages now gets a line
   * saying so -- and a forwarded key went somewhere nothing displays. On a
   * phone that had already been fixed by composing; on a laptop it meant
   * typing a prompt to an agent and watching an empty box.
   *
   * What composing gives up is keys as keys: the arrows, and the control
   * keys, which are the chips above the box and were already the only way to
   * reach them here. Ctrl-C still interrupts, from the keydown rule below.
   */

  focus(): void {
    this.input.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.resizes?.disconnect();
    this.root.style.removeProperty("--chat-composer-height");
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.scroller.removeEventListener("wheel", this.onWheel);
    this.scroller.removeEventListener("touchstart", this.onTouchStart);
    this.scroller.removeEventListener("touchmove", this.onTouchMove);
    this.scroller.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    this.scroller.removeEventListener("keydown", this.onScrollKey);
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
     * not a notice, which is an event in its own right rather than something
     * said.
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
     * Only the rows that actually changed are touched.
     *
     * An agent's paragraph is re-read from its screen on every frame, so a
     * message whose line count has not gone up still has to be looked at: the
     * same line comes back longer than it was as the sentence is written.
     * This used to answer that by emptying the bubble and building it again,
     * which is correct and is also the blink -- every frame, for as long as
     * the agent is writing, the text somebody is reading is removed from the
     * page and put back. Rows that kept their content now keep their nodes,
     * so the only thing that moves is the row that changed.
     */
    const rows = body.childNodes;
    for (let index = 0; index < message.lines.length; index += 1) {
      const line = message.lines[index];
      const signature = lineSignature(line);
      const existing = rows[index] as HTMLElement | undefined;
      if (existing && existing.dataset?.sig === signature) continue;
      if (existing && existing.childNodes.length === 1 && existing.firstChild?.nodeType === Node.TEXT_NODE
          && line.runs.length <= 1 && !styled(line.runs[0])) {
        existing.firstChild.nodeValue = line.text || " ";
        existing.dataset.sig = signature;
        continue;
      }
      const fresh = lineNode(line);
      fresh.dataset.sig = signature;
      if (existing) body.replaceChild(fresh, existing);
      else body.append(fresh);
    }
    /* Whatever the message used to be longer by. */
    while (rows.length > message.lines.length) body.removeChild(rows[rows.length - 1]);
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

  private pauseFollowing(): void {
    this.sticking = false;
    this.resumeOnScroll = false;
    this.jump.hidden = false;
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (event.deltaY < 0) this.pauseFollowing();
    else if (event.deltaY > 0) this.resumeOnScroll = true;
  };

  private readonly onPointerDown = (): void => {
    this.pointerDown = true;
    this.pauseFollowing();
  };

  private readonly onPointerUp = (): void => { this.pointerDown = false; };

  private readonly onTouchStart = (event: TouchEvent): void => {
    this.touchY = event.touches[0]?.clientY ?? null;
    this.pauseFollowing();
  };

  private readonly onTouchMove = (event: TouchEvent): void => {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && this.touchY !== null) {
      if (y > this.touchY) this.pauseFollowing();
      else if (y < this.touchY) this.resumeOnScroll = true;
    }
    this.touchY = y ?? null;
  };

  private readonly onScrollKey = (event: KeyboardEvent): void => {
    if (event.target !== this.scroller) return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
      this.pauseFollowing();
    } else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) {
      this.resumeOnScroll = true;
    }
  };

  private readonly onScroll = (): void => {
    const top = this.scroller.scrollTop;
    if (!this.atBottom()) this.sticking = false;
    else if (this.resumeOnScroll && top > this.lastScrollTop) this.sticking = true;
    this.lastScrollTop = top;
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
   * down.
   *
   * The box is exactly as tall as what is in it, and the row centres it
   * against the button. It used to be floored at the button's own height
   * instead, which made an empty box 51px tall holding one 22px line -- and a
   * textarea puts its line at the top, so the words somebody was typing sat
   * against the ceiling of the box with fifteen pixels of nothing under them.
   *
   * The ceiling is about six lines, after which the box scrolls: past that it
   * is eating the conversation it is being typed into.
   */
  private autosize(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 168)}px`;
  }
}

/**
 * What a rendered row is made of, as one string.
 *
 * Two lines with the same signature produce identical DOM, so a row whose
 * signature has not changed does not need to be built, compared or replaced.
 */
function lineSignature(line: TranscriptLine): string {
  if (line.runs.length <= 1 && !styled(line.runs[0])) return line.text;
  return line.runs
    .map((run) =>
      [
        run.text,
        run.fg ?? "",
        run.bg ?? "",
        run.bold ? "b" : "",
        run.dim ? "d" : "",
        run.italic ? "i" : "",
        run.underline ? "u" : "",
      ].join("\u0000"),
    )
    .join("\u0001");
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
