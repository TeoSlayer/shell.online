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
 * A status line: how long it took, what mode it is in, what is wrong with the
 * login. None of it is an utterance and most of it changes every frame.
 */
const STATUS = /^[✻✶✳✢⚠⏵⏸◐◑◒◓·⋯]/u;

/** Anything indented under the marker above it. */
const INDENTED = /^\s+\S/u;

/**
 * The program's own furniture at the foot of the screen, wherever it sits.
 *
 * The same markers as STATUS but allowed an indent, because the lines under
 * the composer are indented and the ones above it are not.
 */
const FURNITURE = /^\s*[✻✶✳✢⚠⏵⏸◐◑◒◓]/u;

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
    return this.classify(this.reader.read(strip(frame.map((line) => line.text))));
  }

  flush(): AgentUtterance[] {
    return this.classify(this.reader.flush(), true);
  }

  reset(): void {
    this.reader.reset();
    this.open = [];
    this.started = false;
    this.spoken = false;
  }

  private classify(lines: readonly string[], ending = false): AgentUtterance[] {
    const utterances: AgentUtterance[] = [];
    for (const line of lines) {
      const prompt = PROMPT.exec(line);
      if (prompt) {
        this.started = true;
        this.spoken = false;
        this.close(utterances);
        const text = prompt[1].trim();
        if (text) utterances.push({ kind: "sent", text, lines: [] });
        continue;
      }

      const spoke = SPOKE.exec(line);
      if (spoke) {
        this.started = true;
        this.spoken = true;
        this.close(utterances);
        if (spoke[1].trim()) this.open.push(spoke[1]);
        continue;
      }

      /* Not an utterance, and most of it changes every frame. */
      if (STATUS.test(line)) {
        this.close(utterances);
        continue;
      }

      /*
       * The header drawn before anybody has said anything: the logo, the
       * version, what the login is doing. It is above the first marker, and
       * everything a conversation is made of is below one.
       */
      if (!this.started) continue;

      /*
       * A blank line ends what was being said rather than being kept in it.
       *
       * It is the break every program agrees on and the one a person already
       * reads as the end of a thought, so it is where one message stops and
       * the next begins -- the same rule the line-oriented half of this
       * renderer applies, for the same reason. An agent listing a directory
       * says what it found, then the directories, then the pipes, then the
       * sockets, and a person reading that in a chat reads five things.
       */
      if (line.trim() === "") {
        this.close(utterances);
        continue;
      }

      /*
       * Indented, before the agent has said anything in this turn: a tool,
       * and the one line it reported. "Listed 1 directory", "Read 412 lines".
       */
      if (!this.spoken && this.open.length === 0 && INDENTED.test(line)) {
        utterances.push({ kind: "tool", text: line.trim(), lines: [] });
        continue;
      }

      this.open.push(line);
    }

    if (ending) this.close(utterances);
    else this.offer(utterances);
    return utterances;
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
    const preformatted = looksPreformatted(dedented.map(plain));
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
  let end = frame.length;
  let droppedPrompt = false;
  for (let index = frame.length - 1; index >= 0; index -= 1) {
    const line = frame[index];
    if (line.trim() === "" || RULE.test(line) || FURNITURE.test(line)) {
      end = index;
      continue;
    }
    /*
     * The last prompt on the screen is the one being typed into. Any earlier
     * one is a message somebody sent, so only the first found walking up is
     * taken, and the walk stops at the line above it.
     */
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
  for (const line of lines) {
    const previous = joined[joined.length - 1];
    const wrapped =
      previous !== undefined &&
      previous.trim() !== "" &&
      previous.length >= widest - 2 &&
      line.trim() !== "" &&
      !STARTS_ITEM.test(line);
    if (wrapped) joined[joined.length - 1] = `${previous} ${line.trim()}`;
    else joined.push(line);
  }
  return joined;
}

function plain(text: string): TranscriptLine {
  return { text, runs: text ? [{ text }] : [] };
}
