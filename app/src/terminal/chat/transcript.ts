/**
 * Turns one terminal session into a conversation.
 *
 * A terminal is a grid that a process paints. A chat is a list of finished
 * utterances. This module owns the translation between the two, and nothing
 * else: no DOM, no emulator, no clock of its own. It is handed what a person
 * submitted and what the process has finished writing, and it decides where
 * one message ends and the next begins.
 *
 * Three rules do almost all of the work.
 *
 * Every line it is given is already final. The reader upstream only releases
 * rows the cursor has moved past, so a progress bar redrawing itself, a
 * readline correction, or a line that is still being written never reaches
 * here as a message.
 *
 * The prompt is not output. A shell reprints its prompt and leaves the cursor
 * on it, so that row is never final, so it never arrives. The one time it does
 * arrive is the instant Enter is pressed, when it carries the command that was
 * just typed. That line is the echo, and the echo is dropped, because the
 * command is already in the conversation as the sent message that caused it.
 *
 * Output belongs to the command above it. Lines join the message that is open
 * until something closes it: the next thing submitted, the shell reporting
 * that the command exited, or the process simply going quiet.
 */

import { looksPreformatted, startsNewParagraph } from "./paragraphs";
import type { AgentUtterance } from "./agents/types";

/**
 * "tool" is an agent running something rather than saying something: a file
 * read, a command run. It is in the conversation because leaving it out makes
 * an agent look as though it sat thinking for two minutes, and it is its own
 * kind rather than a message because it is shown as one line and a result.
 */
export type MessageKind = "sent" | "received" | "notice" | "screen" | "tool";

/** A run of characters that share one appearance, as the process painted it. */
export interface StyleRun {
  text: string;
  /** CSS colors, already resolved against the session palette. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface TranscriptLine {
  /** The plain text, for copying, searching and measuring. */
  text: string;
  /** The same characters, split where their appearance changes. */
  runs: StyleRun[];
}

export type NoticeTone = "interrupt" | "info" | "gap";

export interface Message {
  id: number;
  kind: MessageKind;
  /** When the message started, in epoch milliseconds. */
  at: number;
  /** "sent" and "notice" say everything in one string. */
  text: string;
  /** "received" and a finished "screen" keep their rows. */
  lines: TranscriptLine[];
  /** A closed message never takes another line. */
  open: boolean;
  /** The exit status, when the shell publishes command markers. */
  exitCode?: number;
  tone?: NoticeTone;
  /** "screen" only: whether the full-screen program is still running. */
  live?: boolean;
  /** "screen" only: what was running, when that is known. */
  title?: string;
  /**
   * Whether this message's spacing is carrying meaning: a listing, a tree, a
   * diff. Preformatted messages are shown in a monospace block that scrolls;
   * the rest are shown as text and allowed to wrap.
   */
  preformatted?: boolean;
  /** Bumped whenever this message's contents change, so a view can skip redraws. */
  revision: number;
}

/**
 * How long the process must stay quiet before its output is treated as a
 * finished answer.
 *
 * A build pauses. It installs, it waits on a network call, it thinks between
 * two lines of progress, and every one of those pauses would cut its output
 * into another bubble if this were much shorter. It is only a fallback in any
 * case: a shell that publishes command markers ends the answer exactly, and
 * the next thing submitted always ends it whatever the clock says.
 */
export const IDLE_CLOSE_MS = 700;

/** The longest a conversation is kept. Older messages are dropped from the top. */
export const MAX_MESSAGES = 500;

/**
 * The most rows one message holds before the next line starts another.
 *
 * A single command can print a hundred thousand lines. Capping the message
 * keeps any one bubble a size a browser can lay out, and the split reads as a
 * continuation rather than as a new answer.
 */
export const MAX_LINES_PER_MESSAGE = 1500;

/**
 * How many lines an unmatched echo is still looked for in.
 *
 * The echo of a command is normally the very next line. It is not always: a
 * program that prints a banner before the shell echoes, or a session joined
 * mid-command, can put a line or two in front of it. After this many lines the
 * expectation is abandoned, so a command typed minutes ago can never delete a
 * line of real output that happens to end the same way.
 */
const ECHO_PATIENCE_LINES = 40;

/**
 * How many lines a paragraph's shape is re-read over.
 *
 * Far enough in that a table's heading row cannot decide the matter alone,
 * and short enough that re-reading is not done once per line for the whole of
 * a hundred-thousand-line build log.
 */
const SHAPE_SETTLES_AFTER = 50;

/** Commands typed ahead of the process are remembered in order, up to this many. */
const MAX_PENDING_ECHOES = 8;

interface PendingEcho {
  text: string;
  /** Lines left to look for it in. */
  patience: number;
}

export class Transcript {
  private items: Message[] = [];
  private nextId = 1;
  private open: Message | null = null;
  private echoes: PendingEcho[] = [];
  /** The shell's current prompt, when it publishes one. Empty otherwise. */
  private prompt = "";
  /**
   * Set between the shell's prompt-end and command-start markers, which is
   * exactly the window in which the next line written onto the prompt row is
   * the command somebody entered.
   */
  private awaitingCommand = false;
  /** When the open message last grew, so a caller can time the quiet close. */
  private lastGrewAt = 0;
  /** Bumped on every change, so a view can tell "nothing happened" cheaply. */
  private rev = 0;
  /** Set while a snapshot is being replayed, so the view redraws once at the end. */
  private replaying = false;
  /**
   * Whether the open message is an agent's rather than a shell's.
   *
   * The two are closed by different things. A shell's answer ends when the
   * process goes quiet, because nothing else says so. An agent's paragraph
   * ends when the adapter reading its screen says it does, and the adapter
   * has something the clock has not: the rest of the paragraph, held back
   * because the row looked as though it were still being written. Left to the
   * clock, the paragraph was closed a few hundred milliseconds before its
   * last line arrived, and the line was then lost.
   */
  private agentOwned = false;

  get messages(): readonly Message[] {
    return this.items;
  }

  get revision(): number {
    return this.rev;
  }

  /** True while a reconnect is being replayed and the view should hold still. */
  get isReplaying(): boolean {
    return this.replaying;
  }

  /**
   * When the open message should be closed for going quiet, or null when
   * nothing is open. The caller owns the timer; this module owns the rule.
   */
  get quietDeadline(): number | null {
    if (this.agentOwned) return null;
    return this.open && this.open.kind === "received" ? this.lastGrewAt + IDLE_CLOSE_MS : null;
  }

  /**
   * The prompt the shell is currently drawing, taken from its own markers.
   *
   * Worth knowing because output does not always start on a fresh row. A dev
   * server that logs while somebody is sitting at a prompt writes at the
   * cursor, which is halfway along the prompt row, so the line that is
   * eventually released reads "~/work/api > listening on :8080". The terminal
   * shows exactly that too; the difference is that a conversation can take
   * the prompt back off, and knowing the prompt exactly is what makes that
   * safe to do.
   */
  setPrompt(text: string): void {
    this.prompt = text;
  }

  /**
   * The shell has finished drawing its prompt and is waiting to be typed at.
   *
   * Whatever lands on that row next is a command, wherever it was entered --
   * this browser, another one, or the machine's own keyboard. One typed here
   * is already in the conversation and is recognised as its own echo; one
   * typed anywhere else would otherwise arrive as a line of output, which is
   * why a session driven from the terminal looked like a monologue.
   */
  expectCommand(): void {
    this.awaitingCommand = true;
  }

  /** The command is running, so nothing further is one. */
  commandStarted(): void {
    this.awaitingCommand = false;
  }

  /**
   * Something read out of an agent's own interface.
   *
   * Everything else here is told what happened by the session: a line this
   * browser submitted, rows a terminal finished writing. An agent draws a
   * screen instead, so what it said has to be read off that screen, and this
   * is where the reading arrives. See agents/types.ts for what that costs.
   *
   * A prompt recovered this way is not given an echo to look for. The echo
   * rule exists because a shell prints back what it was sent; an agent's
   * interface is not echoing anything, it is drawing its own record of the
   * conversation, and there is no second copy coming.
   */
  fromAgent(utterance: AgentUtterance, at: number): Message | null {
    if (utterance.kind !== "received") this.close(at);
    if (utterance.kind === "sent") {
      /*
       * A prompt read off an agent's screen is not always news. One sent from
       * this browser is already in the thread as the message that caused it,
       * and the agent draws it into its own conversation a moment later --
       * which without this arrives as the same prompt a second time. It is
       * the same echo rule the line-oriented half applies, and the same queue
       * of commands waiting to be recognised.
       */
      if (this.consumedAsEcho(plainLine(utterance.text))) return null;
      return this.push({ kind: "sent", at, text: utterance.text, lines: [], open: false });
    }
    if (utterance.kind === "tool") {
      return this.push({
        kind: "tool",
        at,
        text: utterance.text,
        lines: utterance.lines.slice(),
        open: false,
      });
    }
    /*
     * The same paragraph arrives on every frame while the agent is writing
     * it, and once more when it ends. So it is updated where it already
     * exists rather than pushed again: what the adapter offers is always the
     * whole of the paragraph as it stands, never the part that is new.
     */
    const growing = this.open?.kind === "received" ? this.open : null;
    this.agentOwned = true;
    const target =
      growing ??
      this.push({ kind: "received", at, text: "", lines: [], open: true });
    if (!growing) this.open = target;
    /*
     * Only when it actually changed.
     *
     * The paragraph an agent is writing is offered again on every frame of
     * its screen, which for a program that repaints while it thinks is many
     * times a second and almost always the same words. Bumping the revision
     * regardless told the view something had happened, and the view rebuilt
     * the message -- so a conversation sitting still twitched, and one that
     * was growing shook rather than grew.
     */
    if (differs(target.lines, utterance.lines) || target.preformatted !== utterance.preformatted) {
      target.lines = utterance.lines.slice();
      target.preformatted = utterance.preformatted;
      this.touch(target);
      this.lastGrewAt = at;
    }
    if (!utterance.open) this.close(at);
    return target;
  }

  /** Forgets everything. Used when the relay replays a session from the top. */
  clear(): void {
    this.items = [];
    this.open = null;
    this.echoes = [];
    this.prompt = "";
    this.awaitingCommand = false;
    this.agentOwned = false;
    this.rev += 1;
  }

  /**
   * Replay is a rebuild, not an animation.
   *
   * On a reconnect the relay sends the whole screen again. Rendering that a
   * message at a time would replay somebody's last ten minutes in front of
   * them. So the transcript is rebuilt in full and the view is told once.
   */
  beginReplay(): void {
    this.replaying = true;
    this.clear();
  }

  endReplay(): void {
    this.replaying = false;
    this.rev += 1;
  }

  /** A line the viewer entered and submitted. */
  submitted(text: string, at: number): Message {
    this.close(at);
    /*
     * Trailing spaces are dropped from what is looked for, because the line
     * it will be compared against has had its own taken off: a terminal pads
     * every row out to its width, and a command that differs from its echo by
     * a space nobody can see is the same command.
     */
    const looked = text.trimEnd();
    if (looked) {
      this.echoes.push({ text: looked, patience: ECHO_PATIENCE_LINES });
      if (this.echoes.length > MAX_PENDING_ECHOES) this.echoes.shift();
    }
    return this.push({ kind: "sent", at, text, lines: [], open: false });
  }

  /**
   * Ctrl-C. What was half-typed goes with it, because "I abandoned this" is
   * part of the record and the sent message for it was never created.
   */
  interrupted(pending: string, at: number): Message {
    this.close(at);
    this.echoes = [];
    return this.push({
      kind: "notice",
      at,
      text: pending ? `Interrupted — ${pending}` : "Interrupted",
      lines: [],
      open: false,
      tone: "interrupt",
    });
  }

  /**
   * Something that happened between messages rather than inside one, such as
   * output that scrolled past before it could be kept.
   *
   * It closes whatever is open first. A notice pushed under an answer that is
   * still growing reads as if it came before lines that arrive after it.
   */
  noticed(text: string, at: number, tone: NoticeTone = "info"): Message {
    this.close(at);
    return this.push({ kind: "notice", at, text, lines: [], open: false, tone });
  }

  /**
   * Rows the process has finished writing.
   *
   * They join the open message, or start one. The echo of whatever was typed
   * is removed on the way in, which is the only place a line is ever dropped.
   */
  output(lines: readonly TranscriptLine[], at: number): void {
    for (const line of lines) {
      const stripped = this.withoutPrompt(line);
      if (this.consumedAsEcho(stripped)) continue;
      /*
       * Written onto the prompt while the shell was waiting: a command, and
       * not one of ours, because ours are consumed as their own echo above.
       * It carries no echo expectation -- this line is the echo.
       */
      if (this.awaitingCommand && stripped.text !== line.text && stripped.text.trim() !== "") {
        this.awaitingCommand = false;
        this.close(at);
        this.push({ kind: "sent", at, text: stripped.text.trim(), lines: [], open: false });
        continue;
      }
      /*
       * A blank line ends the message rather than being kept in it. It is the
       * break every program agrees on and the one a person already reads as
       * the end of a thought, so it is where one bubble stops and the next
       * begins; see paragraphs.ts.
       */
      if (stripped.text.trim() === "") {
        this.close(at);
        continue;
      }
      this.append(stripped, at);
    }
  }

  /**
   * Takes the prompt off the front of a line that was written onto it.
   *
   * Only an exact prefix of the prompt the shell last published, so a line of
   * output that merely begins the same way is left alone. A line that is
   * nothing but the prompt becomes empty and is dropped by the echo test or
   * kept as the blank row it now is.
   */
  private withoutPrompt(line: TranscriptLine): TranscriptLine {
    if (this.prompt === "" || !line.text.startsWith(this.prompt)) return line;
    let remaining = this.prompt.length;
    const runs: StyleRun[] = [];
    for (const run of line.runs) {
      if (remaining >= run.text.length) {
        remaining -= run.text.length;
        continue;
      }
      runs.push(remaining > 0 ? { ...run, text: run.text.slice(remaining) } : run);
      remaining = 0;
    }
    return { text: line.text.slice(this.prompt.length), runs };
  }

  /**
   * The shell says a command finished, and with what status.
   *
   * Only shells that publish command markers reach this. When they do, it is
   * better than any timing rule: the message closes exactly when the command
   * ended, and carries the status the command exited with.
   */
  commandFinished(exitCode: number | undefined, at: number): void {
    if (this.open && this.open.kind === "received" && exitCode !== undefined) {
      this.open.exitCode = exitCode;
      this.touch(this.open);
    }
    this.close(at);
  }

  /** The shell is about to draw a prompt, so whatever came before it is over. */
  promptStarted(at: number): void {
    this.close(at);
  }

  /**
   * A full-screen program took the alternate screen.
   *
   * Nothing it draws is a message: vim, top and a coding agent's own interface
   * are a grid being repainted, and slicing that into bubbles produces
   * nonsense. So the conversation gets one card, and the card gets a real
   * terminal inside it for as long as the program runs.
   */
  screenOpened(title: string, at: number): Message {
    this.close(at);
    const message = this.push({
      kind: "screen",
      at,
      text: title,
      lines: [],
      open: true,
      live: true,
      title,
    });
    this.open = message;
    return message;
  }

  /**
   * What the full-screen program is showing right now.
   *
   * The card mirrors the alternate screen as text rather than hosting a second
   * emulator: the bytes are already being parsed once, and reading the grid
   * that parse produced costs nothing extra and cannot fall out of step with
   * it. It also means the last mirror taken before the program exits is
   * exactly the still image to keep.
   */
  screenPainted(lines: readonly TranscriptLine[], at: number): void {
    const card = this.open?.kind === "screen" ? this.open : null;
    if (!card || !card.live) return;
    card.lines = lines.slice();
    this.touch(card);
    this.lastGrewAt = at;
  }

  /** The program exited and gave the screen back. What it last showed is kept. */
  screenClosed(snapshot: readonly TranscriptLine[] | null, at: number): void {
    const card = this.open?.kind === "screen" ? this.open : lastScreen(this.items);
    if (card) {
      card.live = false;
      /* Null keeps the last mirror, which is the frame the program left behind. */
      if (snapshot) card.lines = snapshot.slice();
      card.open = false;
      this.touch(card);
    }
    this.open = null;
    this.lastGrewAt = at;
  }

  /**
   * Closes the open message if the process has been quiet long enough. Returns
   * true when something changed, so a caller can skip a redraw.
   */
  settle(at: number): boolean {
    const deadline = this.quietDeadline;
    if (deadline === null || at < deadline) return false;
    this.close(at);
    return true;
  }

  /** Closes whatever is open, without ending the session. */
  close(at: number): void {
    this.agentOwned = false;
    if (!this.open) return;
    if (this.open.open === false) {
      this.open = null;
      return;
    }
    /* A live screen card is closed by the program exiting, not by a pause. */
    if (this.open.kind === "screen" && this.open.live) return;
    this.open.open = false;
    this.touch(this.open);
    this.open = null;
    this.lastGrewAt = at;
  }

  /**
   * Whether a line is the terminal echoing back something that was typed, and
   * is therefore already in the conversation as the message that caused it.
   *
   * `echoMatches` below holds what counts as an echo of one command. This
   * holds which commands are still worth asking about.
   */
  private consumedAsEcho(line: TranscriptLine): boolean {
    if (this.echoes.length === 0) return false;
    const text = line.text.trimEnd();

    /*
     * Every command still waiting for its echo is tried, not only the oldest.
     *
     * The oldest is the usual answer and used to be the only one, which made
     * one unmatched command poison every command after it: a line that never
     * echoes -- a password, something a program read and swallowed, a session
     * joined mid-command -- sat at the head of the queue for forty lines, and
     * for those forty lines every real echo was compared against the wrong
     * command, failed, and arrived in the conversation as output. That is the
     * duplicate: the command in its own bubble, and the same text again in
     * the answer underneath it.
     *
     * A match therefore also retires the commands in front of it. They were
     * sent before this one and their echo cannot still be coming.
     */
    for (let index = 0; index < this.echoes.length; index += 1) {
      if (!echoMatches(text, this.echoes[index].text)) continue;
      this.echoes.splice(0, index + 1);
      return true;
    }

    for (const echo of this.echoes) echo.patience -= 1;
    this.echoes = this.echoes.filter((echo) => echo.patience > 0);
    return false;
  }

  private append(line: TranscriptLine, at: number): void {
    let target = this.open;
    if (target && target.kind !== "received") target = null;
    if (target && target.lines.length >= MAX_LINES_PER_MESSAGE) {
      target.open = false;
      this.touch(target);
      target = null;
    }
    /*
     * A blank line is not the only place one thing stops being said and the
     * next starts. Plenty of output has no blank line in it anywhere -- a
     * stack trace, an `npm ERR!` block, a help screen -- and shown as one
     * message it is the wall of terminal output a conversation is supposed to
     * replace. paragraphs.ts owns which shapes are a boundary; this is where
     * the answer is acted on as the lines arrive.
     */
    if (target && startsNewParagraph(target.lines, line)) {
      target.open = false;
      this.touch(target);
      target = null;
    }
    if (!target) {
      target = this.push({ kind: "received", at, text: "", lines: [], open: true });
      this.open = target;
    }
    target.lines.push(line);
    /*
     * Re-read while the paragraph is still small. What a paragraph is cannot
     * be known from its first line -- one sentence is prose, the same
     * sentence above two indented ones is a heading over a block -- so the
     * verdict is taken again as lines arrive, and settled once there are
     * enough of them for more lines not to change it.
     */
    if (target.lines.length <= SHAPE_SETTLES_AFTER) {
      target.preformatted = looksPreformatted(target.lines);
    }
    this.touch(target);
    this.lastGrewAt = at;
  }

  private push(message: Omit<Message, "id" | "revision">): Message {
    const full: Message = { ...message, id: this.nextId++, revision: 0 };
    this.items.push(full);
    /*
     * The conversation is trimmed from the top, the way scrollback is. Keeping
     * every message of a session that has run for a day is how a tab ends up
     * holding a hundred thousand DOM nodes it will never show again.
     */
    if (this.items.length > MAX_MESSAGES) {
      this.items.splice(0, this.items.length - MAX_MESSAGES);
    }
    this.rev += 1;
    return full;
  }

  private touch(message: Message): void {
    message.revision += 1;
    this.rev += 1;
  }
}

/**
 * Whether a released line is the terminal echoing back the given command.
 *
 * A suffix rather than an equality, because the shell draws its prompt first
 * and the command after it on the same row, so the echoed line is the two
 * together. That also takes the prompt out of the conversation, which is the
 * right answer twice over: a prompt is chrome, and it usually carries a
 * directory and a hostname nobody asked to publish.
 *
 * Both sides have their trailing spaces taken off first. The released line
 * has them because a terminal pads a row to its width; the command has them
 * because somebody can type one, and a command that differs from its own echo
 * by a space nobody can see is the same command.
 */
function echoMatches(line: string, command: string): boolean {
  return command !== "" && line.endsWith(command);
}

/** Whether a message's lines are not the ones it already has. */
function differs(had: readonly TranscriptLine[], next: readonly TranscriptLine[]): boolean {
  if (had.length !== next.length) return true;
  for (let index = 0; index < had.length; index += 1) {
    if (had[index].text !== next[index].text) return true;
  }
  return false;
}

function lastScreen(items: readonly Message[]): Message | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].kind === "screen" && items[index].live) return items[index];
  }
  return null;
}

/** A line with no styling, which is what most output is and all tests need. */
export function plainLine(text: string): TranscriptLine {
  return { text, runs: text ? [{ text }] : [] };
}
