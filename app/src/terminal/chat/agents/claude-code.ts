/**
 * Claude Code's interface, read as a conversation.
 *
 * Written against frames captured from the program, kept beside it in
 * `fixtures/`. The first version of this was written against a screen
 * somebody imagined, and every detail of it was wrong -- so the adapter
 * recognised nothing, and recognising nothing puts the raw grid back on the
 * phone, which is the thing all of this exists to avoid.
 *
 * What the real screen is:
 *
 *     ❯ list the files in this directory          a prompt somebody typed
 *
 *       Listed 1 directory                        a tool, and what it did
 *
 *     ⏺ Here's what's in /private/tmp:            what the agent said
 *
 *       Directories                               and the rest of what it
 *       - cc-socks                                said, indented under it
 *
 *     ✻ Cooked for 13s · done 8:29 PM             a status line
 *
 *     ──────────────────────────────────────      a rule
 *     ❯                                           the box you type into
 *     ──────────────────────────────────────      a rule
 *       ⏵⏵ auto mode on                           more status
 *
 * Three things about that were assumed the other way round, and each
 * assumption cost a release.
 *
 * **`⏺` is the agent speaking**, not a tool call. A tool is the indented line
 * with no marker on it at all.
 *
 * **Nothing is drawn in a box.** The composer is bounded by two full-width
 * rules and the status lines are *below* the second one, so a reader looking
 * for the last box on the screen finds none and keeps the lot.
 *
 * **The header scrolls away.** The program's name is on screen for the first
 * few exchanges and then it is gone, so the name cannot be what identifies
 * the program. The title it sets can; see `matches`.
 */

import type { TranscriptLine } from "../transcript";
import { looksPreformatted } from "../paragraphs";
import { RepaintReader } from "./stream";
import type { AgentAdapter, AgentUtterance } from "./types";

/** A full-width rule. Two of them bound the box that is typed into. */
const RULE = /^[─━]{8,}\s*$/u;

/** A prompt somebody typed. */
const PROMPT = /^❯\s?(.*)$/u;

/** The agent speaking. */
const SPOKE = /^⏺\s+(.*)$/u;

/**
 * A status line. None of it is an utterance and most of it changes every
 * frame, so shown it would be a message per repaint.
 *
 * Four shapes, all of them real:
 *
 *     ✽ Flowing… (8m 57s · ↓ 10.8k tokens)      a spinner, and what it costs
 *     ⏵⏵ auto mode on (shift+tab to cycle)      what mode it is in
 *     Tip: Use /config to change your…          advice nobody asked for
 *     ✔ Update installed · Restart to update    news about the program
 *
 * The spinner cycles through a whole block of stars and sparkles rather than
 * one glyph, so the range is matched rather than the handful anybody happens
 * to have seen -- and the range was still too narrow. A real session spun
 * through `✢` (U+2722), nine code points below where the range started, and
 * one unrecognised spinner is not one missing line: a status line that is not
 * recognised is a line that *changes* inside the region the repaint reader
 * compares, which breaks the match between one frame and the next and gives
 * the entire screen out again. That is every message in the session arriving
 * a second time, and a third, for as long as the agent is thinking.
 *
 * So the block is matched wide enough to hold the whole of the dingbat stars,
 * and SPINNER below catches the shape as well as the glyph, because the next
 * version of the program may well spin through something else again.
 *
 * The tip and the update line have no marker at all and are matched on what
 * they say, which is the only thing they have.
 */
const STATUS =
  /^(?:[\u2720-\u274F✓✔✗✘⚠⏵⏸⏹◐◑◒◓·⋯]|Tip:|Update installed\b|Restart to update\b)/u;

/**
 * A spinner by its shape rather than by its glyph.
 *
 * One symbol, a space, and a word that trails off: `✢ Jitterbugging…`,
 * `✽ Flowing… (8m 57s · ↓ 10.8k tokens)`. Nothing an agent says looks like
 * that -- what it says starts with `⏺`, and what somebody typed starts with
 * `❯` -- so this can be read as furniture without knowing which glyph this
 * week's spinner happens to use.
 */
const SPINNER = /^\s*[^\p{L}\p{N}\s]\s+\p{L}[\p{L}\u2019']*…/u;

/**
 * The same, anywhere on the line.
 *
 * A terminal is wide, and a program with two things to say puts one at each
 * end of the same row: `Tip: … ✔ Update installed · Restart to update`. The
 * row starts as a tip, so matching the start is enough for that one -- but a
 * row that starts with something else and ends in an update is still status.
 */
const STATUS_TAIL = /(?:✓|✔)\s*Update installed|Restart to update/u;

/** Anything indented under the marker above it. */
const INDENTED = /^\s+\S/u;

/**
 * The program's own furniture at the foot of the screen, wherever it sits.
 *
 * The same markers as STATUS but allowed an indent, because the lines under
 * the composer are indented and the ones above it are not.
 */
const FURNITURE = /^\s*(?:[\u2731-\u2743✓✔✗✘⚠⏵⏸⏹◐◑◒◓]|Tip:)/u;

/**
 * The glyph Claude Code puts in front of the window title.
 *
 * The title is not the program's name for long: it becomes a summary of
 * whatever is being worked on, so a session that had been asked to list a
 * directory reported `✳ List directory files`. The glyph stays.
 */
const TITLE_MARK = /[✳✻]/u;

/** A row that begins something rather than continuing something. */
const STARTS_ITEM = /^\s*(?:[-*+•‣◦]\s|\d+[.)]\s|>\s|#{1,6}\s)/u;

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";
  readonly title = "Claude Code";
  readonly confident = true;

  private readonly reader = new RepaintReader();
  /** Lines of what the agent is saying, not yet closed into a message. */
  private open: string[] = [];
  /** Whether a marker has been seen, so the header above it can be skipped. */
  private started = false;
  /**
   * Whether the agent has begun speaking in this turn.
   *
   * It is what separates a tool from the rest of what is being said, because
   * the two look identical: both are indented lines with no marker. What
   * distinguishes them is where they are. Between the prompt and the first
   * `⏺` an indented line is a tool reporting what it did; after it, the same
   * line is the paragraph the agent is in the middle of.
   */
  private spoken = false;

  /**
   * The prompt being read, while its rows are still arriving.
   *
   * A sent prompt is not one row. The program prints it into the conversation
   * exactly as wide as the terminal and wraps the rest of it underneath,
   * indented two spaces to sit under the `❯`, with no blank line in between:
   *
   *     ❯ Please reply with exactly the single word acknowledged and nothing
   *       else, no explanation, no tool calls
   *
   * Read a row at a time, the second row is an indented line with no marker
   * before the agent has spoken -- which is precisely the shape of a tool
   * report -- so the back half of what somebody typed arrived in the
   * conversation as its own separate message. A long prompt came apart into
   * three or four of them.
   */
  private prompting: string[] | null = null;

  /** The last prompt given out, until the agent answers it; see `sent`. */
  private lastSent: string | null = null;
  private previewing = false;
  private fence: string | null = null;

  /**
   * Whether Claude Code is what is drawing this screen.
   *
   * The title it sets, first, because it is the one thing about the program
   * that does not scroll. Its name is printed in a header that is gone after
   * a few exchanges, so an adapter gated on the name stops recognising the
   * program exactly when there is a conversation worth reading -- and a
   * session resumed from earlier never had the header at all.
   *
   * The markers are the fallback for a terminal that reports no title, and
   * they are required together: `❯` alone is most shells' prompt and `⏺`
   * alone is a bullet.
   */
  matches(frame: readonly string[], title?: string): boolean {
    if (title && (/claude code/iu.test(title) || TITLE_MARK.test(title))) return true;
    if (frame.some((line) => /\bclaude code\b/iu.test(line))) return true;
    /*
     * Both markers, and nothing about the rules. A rule is only on the screen
     * while the composer is, and a conversation long enough to fill the grid
     * pushes it off -- which is the case an adapter most needs to recognise.
     */
    return frame.some((line) => SPOKE.test(line)) && frame.some((line) => PROMPT.test(line));
  }

  read(frame: readonly TranscriptLine[]): AgentUtterance[] {
    const utterances = this.classify(this.reader.read(normalize(strip(frame.map((line) => line.text)))));
    if (this.previewing) {
      const preview = this.settle();
      if (preview.length) {
        if (utterances.at(-1)?.kind === "received" && utterances.at(-1)?.open) utterances.pop();
        utterances.push(...preview);
      }
    }
    return utterances;
  }

  settle(): AgentUtterance[] {
    this.previewing = true;
    // A 400ms pause can occur mid-token. Preview it, but leave both the reader
    // and classifier at their committed boundary so a later repaint replaces
    // the preview rather than appending a second copy. Prompts and tools are
    // not published until their boundary arrives.
    const state = { open: [...this.open], prompting: this.prompting && [...this.prompting],
      started: this.started, spoken: this.spoken, fence: this.fence };
    const preview = this.classify(this.reader.preview());
    Object.assign(this, state);
    return preview.length === 1 && preview[0].kind === "received"
      ? [{ ...preview[0], open: true }] : [];
  }

  flush(): AgentUtterance[] {
    return this.classify(this.reader.flush(), true);
  }

  reset(): void {
    this.reader.reset();
    this.previewing = false;
    this.fence = null;
    this.open = [];
    this.prompting = null;
    this.lastSent = null;
    this.started = false;
    this.spoken = false;
  }

  private classify(lines: readonly string[], ending = false): AgentUtterance[] {
    const utterances: AgentUtterance[] = [];
    for (const line of lines) {
      if (this.fence) {
        this.open.push(line);
        if (closesFence(line, this.fence)) this.fence = null;
        continue;
      }
      const prompt = PROMPT.exec(line);
      if (prompt) {
        this.started = true;
        this.spoken = false;
        this.sent(utterances);
        this.close(utterances);
        const text = prompt[1].trim();
        this.prompting = text ? [text] : null;
        continue;
      }

      /*
       * Still inside the prompt: anything that is not blank and carries no
       * marker of its own is the rest of what was typed.
       */
      if (this.prompting) {
        if (INDENTED.test(line) && !SPOKE.test(line) && !STATUS.test(line.trimStart()) && !STATUS_TAIL.test(line) && !RULE.test(line)) {
          this.prompting.push(line.trim());
          continue;
        }
        this.sent(utterances);
      }

      const spoke = SPOKE.exec(line);
      if (spoke) {
        this.started = true;
        this.spoken = true;
        this.lastSent = null;
        this.close(utterances);
        if (spoke[1].trim()) this.open.push(spoke[1]);
        this.fence = fenceAt(spoke[1]);
        continue;
      }

      /* Not an utterance, and most of it changes every frame. */
      if (furniture(line)) {
        this.close(utterances);
        continue;
      }

      /*
       * The header drawn before anybody has said anything: the logo, the
       * version, what the login is doing. It is above the first marker, and
       * everything a conversation is made of is below one.
       */
      if (!this.started) continue;

      /* The box that is typed into, when a frame still holds part of it. */
      if (RULE.test(line)) {
        this.close(utterances);
        continue;
      }

      /*
       * Inside the block the marker opened, blank rows and all.
       *
       * One `⏺` is one message. That is the shape of this program's output --
       * a marker, then everything it has to say about that one thing, over
       * however many rows with however many blank lines between them -- and
       * reading it any other way is reading something the program did not
       * write. A blank line used to end the message here, a rule borrowed
       * from the line-oriented half of this renderer where it is right and
       * here is not: one answer with a paragraph break in it arrived as two
       * messages, a list with air around it as four, and a tool's result as a
       * message with nothing to say what it belonged to.
       *
       * A row with no block open belongs to nothing: the banner between the
       * header and the first prompt, whatever is left of the furniture around
       * the composer. There is nothing to attach it to, and on a screen that
       * is repainted it is the part most likely to change.
       */
      if (this.open.length === 0) continue;
      this.open.push(line);
      this.fence = fenceAt(line);
    }

    if (ending) {
      this.sent(utterances);
      this.close(utterances);
    } else {
      this.offer(utterances);
    }
    return utterances;
  }

  /**
   * Closes the prompt being read into the one message somebody sent.
   *
   * The rows are joined the way the terminal broke them: it wrapped a
   * sentence to fit 80 columns, and nobody typed those breaks.
   */
  private sent(into: AgentUtterance[]): void {
    const rows = this.prompting;
    this.prompting = null;
    if (!rows || rows.length === 0) return;
    const text = unwrap(rows).join("\n").trim();
    if (!text) return;
    /*
     * One prompt per turn.
     *
     * A prompt is read off the screen, and a screen can show the same one
     * twice: it is in the box while it is being typed, in the conversation
     * once it is sent, and on the way between the two a repaint can offer it
     * again from a join the reader had to guess at. What cannot happen is the
     * same prompt twice with nothing in between -- the agent answers every
     * one of them -- so a repeat before the agent has said anything is the
     * same prompt, read a second time.
     */
    if (text === this.lastSent) return;
    this.lastSent = text;
    into.push({ kind: "sent", text, lines: [] });
  }

  /** What the agent is saying, as it stands. Kept open so it can grow. */
  private offer(into: AgentUtterance[]): void {
    const utterance = this.paragraph(true);
    if (utterance) into.push(utterance);
  }

  /** What the agent said, finished. */
  private close(into: AgentUtterance[]): void {
    const utterance = this.paragraph(false);
    this.open = [];
    if (utterance) into.push(utterance);
  }

  private paragraph(open: boolean): AgentUtterance | null {
    const held = [...this.open];
    while (held.length > 0 && held[held.length - 1].trim() === "") held.pop();
    if (held.length === 0) return null;
    const dedented = dedent(held);
    const preformatted = dedented.some((line) => fenceAt(line) !== null) || looksPreformatted(dedented.map(plain));
    /*
     * Only prose is put back together. Where the spacing is carrying meaning
     * -- a table, a tree, a diff -- the row breaks are the meaning.
     */
    const lines = (preformatted ? dedented : unwrap(dedented)).map(plain);
    return { kind: "received", text: "", lines, open, preformatted };
  }
}

/**
 * The conversation, with the program's furniture taken off.
 *
 * The composer is two full-width rules with a line between them, and whatever
 * the program wants to say about itself goes underneath. So everything from
 * the first of that trailing pair is dropped.
 *
 * By position rather than by shape, because what is between those rules is a
 * line somebody is part-way through typing: given out, every keystroke would
 * arrive in the thread as a message.
 */
export function strip(frame: readonly string[]): string[] {
  /*
   * The composer is whatever lies between the last two rules, whatever it
   * happens to say and however many rows it has grown to. That is the whole
   * rule, and it is a rule about position rather than about content on
   * purpose: what is in there is a line somebody is part-way through typing,
   * and it must not be read at all until they send it.
   *
   * It used to be read by shape -- walk up from the foot of the screen over
   * anything that looked like furniture, and drop the first prompt line found
   * -- which works right up until the line being typed is long enough to
   * wrap. Then the rows below the prompt are ordinary text, the walk stops at
   * the first of them, and everything from there down is given out: half of
   * somebody's half-finished sentence, arriving on another device as a
   * message they had not sent and as output they had not asked for.
   *
   * The rules are full-width and start at column zero. Anything the agent
   * draws inside its conversation is indented under a marker, so a rule in
   * what it said cannot be mistaken for one of these.
   */
  const rules: number[] = [];
  for (let index = 0; index < frame.length; index += 1) {
    if (RULE.test(frame[index])) rules.push(index);
  }
  if (rules.length >= 2) return frame.slice(0, rules[rules.length - 2]);
  if (rules.length === 1) return frame.slice(0, rules[0]);

  /*
   * No rules yet: a program part-way through its first paint. Fall back to
   * walking the furniture off the foot of the screen, and take the prompt
   * with it.
   */
  let end = frame.length;
  let droppedPrompt = false;
  for (let index = frame.length - 1; index >= 0; index -= 1) {
    const line = frame[index];
    if (line.trim() === "" || FURNITURE.test(line)) {
      end = index;
      continue;
    }
    if (!droppedPrompt && PROMPT.test(line)) {
      droppedPrompt = true;
      end = index;
      continue;
    }
    break;
  }
  return frame.slice(0, end);
}

/**
 * Takes the interface's own indent off a paragraph, and leaves the writer's.
 *
 * Claude Code indents everything under a marker by two columns, which is
 * layout; a list item's continuation is indented further, and that is
 * meaning. Removing the smallest indent removes exactly the first.
 */
export function dedent(lines: readonly string[]): string[] {
  let common = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    common = Math.min(common, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(common) || common === 0) return [...lines];
  return lines.map((line) => (line.trim() === "" ? "" : line.slice(common)));
}

/**
 * Puts a paragraph back together after the terminal broke it into rows.
 *
 * The agent wrote a paragraph and the terminal wrapped it at eighty columns.
 * Those breaks are the grid's, not the writer's, and kept they are the whole
 * difference between text that reflows to a phone and text with a ragged edge
 * two thirds of the way across it. A row is a continuation when the row above
 * it ran to the edge; one that stopped short of it stopped on purpose.
 */
export function unwrap(lines: readonly string[]): string[] {
  const widest = Math.max(0, ...lines.map((line) => line.length));
  if (widest < 24) return [...lines];
  const joined: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const previous = lines[index - 1];
    const wrapped =
      previous !== undefined &&
      previous.trim() !== "" &&
      previous.length >= widest - 2 &&
      line.trim() !== "" &&
      !STARTS_ITEM.test(line);
    if (wrapped) joined[joined.length - 1] += ` ${line.trim()}`;
    else joined.push(line);
  }
  return joined;
}

function plain(text: string): TranscriptLine {
  return { text, runs: text ? [{ text }] : [] };
}

/** Anything the program says about itself rather than about the work. */
function furniture(line: string): boolean {
  return STATUS.test(line) || STATUS_TAIL.test(line) || SPINNER.test(line);
}

/** Ignore changing chrome before comparing frames, not after deduplication. */
function normalize(frame: readonly string[]): string[] {
  let fence: string | null = null;
  return frame.map(line => {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      return line;
    }
    fence = fenceAt(SPOKE.exec(line)?.[1] ?? line);
    return !fence && furniture(line) ? "✻" : line;
  });
}

function fenceAt(line: string): string | null {
  return /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
}

function closesFence(line: string, fence: string): boolean {
  const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
  return !!close && close[0] === fence[0] && close.length >= fence.length;
}
