/**
 * A boxed agent's interface, read as a conversation.
 *
 * The coding agents this product runs draw the same shape of screen, because
 * they are all solving the same problem with the same box-drawing characters.
 * The shape is what this module knows; which program is drawing it is the one
 * thing each adapter supplies for itself, and it is supplied as an exact name
 * so that no two of them can ever claim each other's screen.
 *
 * The screen has three parts, and only the middle one is anything anybody
 * said:
 *
 *   a header box      the version, and the directory it is working in
 *   the conversation  prompts, prose, and the tools it ran
 *   an input box      what you are typing, which is yours and not a message
 *
 * The boxes are the easy part: everything Claude Code draws a border around
 * is furniture, and everything it says is drawn without one. So a line that
 * is a border, or that sits inside one, is dropped, and what is left is the
 * conversation.
 *
 * The conversation itself is four shapes:
 *
 *   `> something`     a prompt. Somebody typed it, so it is a sent message.
 *   `⏺ Tool(args)`    a tool call, with its result indented under it.
 *   indented prose    what the agent is saying.
 *   a spinner         "Thinking", "esc to interrupt". Not an utterance; it is
 *                     the program saying it is still going, and it changes
 *                     every frame, so it is dropped rather than shown.
 *
 * None of that is guessed at per line. The shapes are recognised, and a line
 * that is none of them is prose, which is the safe answer: prose is shown as
 * written and nothing is lost, where mistaking prose for a tool call would
 * hide it behind a heading.
 */

import type { TranscriptLine } from "../transcript";
import { looksPreformatted } from "../paragraphs";
import { RepaintReader } from "./stream";
import type { AgentAdapter, AgentUtterance } from "./types";

/** A border, or anything else drawn rather than written. */
const BORDER = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]*$/u;

/**
 * A line belonging to a box: its border, its corners, or what is inside it.
 *
 * Any box-drawing character in the first column is enough. A box's top is not
 * always all border -- Claude Code titles one of them `╭─ write a message ─╮`
 * -- so a rule that only knew borders left that line behind, and the title of
 * the box you type into arrived in the thread as a message.
 */
const BOXED = /^\s*[│┃║╭╮╰╯┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬]/u;

/** A prompt somebody typed. */
const PROMPT = /^\s*>\s?(.*)$/u;

/** A tool call. Claude Code marks them with a filled circle. */
const TOOL = /^\s*[⏺●•]\s+(.+)$/u;

/**
 * The program saying it is still working.
 *
 * Dropped because it is not an utterance and because it changes on every
 * frame: shown, a single "Thinking" would be a hundred messages.
 */
const WORKING = /^\s*[✻✶✳✢·⋯*]\s|\besc to interrupt\b|\b\d+s\s*·|\btokens\b/iu;

export class BoxedAgent implements AgentAdapter {
  readonly id: string;
  readonly title: string;
  readonly confident: boolean;
  /** The program's own name, as it writes it on its screen. */
  private readonly signature: RegExp;

  constructor(options: { id: string; title: string; signature: RegExp; confident?: boolean }) {
    this.id = options.id;
    this.title = options.title;
    this.signature = options.signature;
    this.confident = options.confident ?? false;
  }

  private readonly reader = new RepaintReader();
  /** Lines of the conversation not yet closed into an utterance. */
  private open: string[] = [];
  /**
   * The tool call whose result is still arriving, and the column it was
   * written at. What a tool reports is indented under it, and it ends at the
   * first blank line or at the first line that comes back out to its own
   * indent -- which is how the paragraph after a tool call stops being
   * swallowed as part of its output.
   */
  private tool: AgentUtterance | null = null;
  private toolIndent = 0;

  /**
   * Whether this adapter's program is the one drawing this screen.
   *
   * Its name, in the header it draws at the top. Deliberately the narrowest
   * signal available: every marker below appears in several agents'
   * interfaces, so the shape cannot tell them apart and must not be asked to.
   * Reading one agent's screen with another's rules is worse than not reading
   * it at all, and a name is the one thing that is exact.
   */
  matches(frame: readonly string[]): boolean {
    return frame.some((line) => this.signature.test(line));
  }

  read(frame: readonly TranscriptLine[]): AgentUtterance[] {
    const conversation = strip(frame.map((line) => line.text));
    const fresh = this.reader.read(conversation);
    if (fresh.length === 0) return [];

    const utterances: AgentUtterance[] = [];
    for (const line of fresh) this.classify(line, utterances);
    this.offer(utterances);
    return utterances;
  }

  /** Where one line of the conversation goes. */
  private classify(line: string, utterances: AgentUtterance[]): void {
    if (WORKING.test(line)) return;

    const prompt = PROMPT.exec(line);
    if (prompt) {
      this.close(utterances);
      const text = prompt[1].trim();
      if (text) utterances.push({ kind: "sent", text, lines: [] });
      return;
    }

    const tool = TOOL.exec(line);
    if (tool) {
      this.close(utterances);
      this.tool = { kind: "tool", text: tool[1].trim(), lines: [] };
      this.toolIndent = indentOf(line);
      utterances.push(this.tool);
      return;
    }

    if (line.trim() === "") {
      this.close(utterances);
      this.tool = null;
      return;
    }

    /*
     * The detail under a tool call belongs to it rather than starting a
     * paragraph of its own: "Read 412 lines" on its own in the thread says
     * nothing about what was read. Strictly further in than the call, so
     * the next thing the agent says -- which is back at the call's own
     * indent -- ends the result rather than joining it.
     */
    if (this.tool && indentOf(line) > this.toolIndent) {
      this.tool.lines.push(plain(line.trim()));
      return;
    }

    this.tool = null;
    this.open.push(line);
  }

  /**
   * The screen has gone quiet, so the row that looked like it was still being
   * written was the row the agent finished on. See RepaintReader.flush.
   */
  flush(): AgentUtterance[] {
    const utterances: AgentUtterance[] = [];
    for (const line of this.reader.flush()) this.classify(line, utterances);
    this.close(utterances);
    return utterances;
  }

  reset(): void {
    this.reader.reset();
    this.open = [];
    this.tool = null;
  }

  /**
   * The paragraph being written, as it stands. Kept open, so the next frame
   * offers the same one with whatever it has gained.
   */
  private offer(into: AgentUtterance[]): void {
    const utterance = this.paragraph(true);
    if (utterance) into.push(utterance);
  }

  /** The paragraph being written, finished. Nothing is gathered after it. */
  private close(into: AgentUtterance[]): void {
    const utterance = this.paragraph(false);
    this.open = [];
    if (utterance) into.push(utterance);
  }

  private paragraph(open: boolean): AgentUtterance | null {
    if (this.open.length === 0) return null;
    const dedented = dedent(this.open);
    const preformatted = looksPreformatted(dedented.map(plain));
    /*
     * Only prose is put back together. Where the spacing is carrying meaning
     * -- a table, a tree, a diff -- the row breaks are the meaning, and
     * joining them destroys the thing they were drawing.
     */
    const lines = (preformatted ? dedented : unwrap(dedented)).map(plain);
    if (lines.every((line) => line.text.trim() === "")) return null;
    return { kind: "received", text: "", lines, open, preformatted };
  }
}

/**
 * Everything that is not the conversation, taken off.
 *
 * The input box is the one that has to go by position rather than by shape.
 * It is a box like the header is a box, but what is inside it is a line
 * somebody is part-way through typing, and giving that out would put every
 * keystroke in the thread. It is always the last box on the screen, so
 * everything from the last border down is dropped.
 */
export function strip(frame: readonly string[]): string[] {
  let end = frame.length;
  for (let index = frame.length - 1; index >= 0; index -= 1) {
    const line = frame[index];
    if (line.trim() === "") continue;
    if (BORDER.test(line) || BOXED.test(line)) {
      end = index;
      continue;
    }
    break;
  }
  const kept: string[] = [];
  for (const line of frame.slice(0, end)) {
    if (BOXED.test(line)) continue;
    if (line.trim() !== "" && BORDER.test(line)) continue;
    kept.push(line);
  }
  return kept;
}

/**
 * Puts a paragraph back together after the terminal broke it into rows.
 *
 * An agent writes a paragraph and the terminal wraps it at eighty columns.
 * Those breaks are the grid's, not the writer's, and kept they are the whole
 * difference between text that reflows to a phone and text that reads with a
 * ragged edge two thirds of the way across it.
 *
 * A row is a continuation of the one above it when that row ran to the edge.
 * The edge is taken from the paragraph rather than assumed, because the width
 * is the session's and the session's is not known here -- the longest row in
 * the paragraph is as close to it as the paragraph ever got. A row that
 * stopped short of it stopped because the writer meant it to, so it keeps its
 * break: a list stays a list, and a line of a short stanza stays a line.
 */
export function unwrap(lines: readonly string[]): string[] {
  const widest = Math.max(0, ...lines.map((line) => line.length));
  /* Too narrow to tell a wrapped row from a deliberate one. */
  if (widest < 24) return [...lines];
  const joined: string[] = [];
  for (const line of lines) {
    const previous = joined[joined.length - 1];
    const wrapped =
      previous !== undefined &&
      previous.length >= widest - 2 &&
      line.trim() !== "" &&
      !STARTS_ITEM.test(line);
    if (wrapped) joined[joined.length - 1] = `${previous} ${line.trim()}`;
    else joined.push(line);
  }
  return joined;
}

/**
 * A row that begins something rather than continuing something: a bullet, a
 * numbered item, a quotation. It keeps its own line however full the row
 * above it was.
 */
const STARTS_ITEM = /^\s*(?:[-*+•‣◦]\s|\d+[.)]\s|>\s)/u;

/**
 * Takes the interface's own indent off a paragraph, and leaves the writer's.
 *
 * Claude Code indents everything it says by a couple of columns, which is
 * layout rather than meaning; a code block inside that paragraph is indented
 * further, and that is meaning. Removing the smallest indent in the paragraph
 * removes exactly the first and keeps exactly the second.
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

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function plain(text: string): TranscriptLine {
  return { text, runs: text ? [{ text }] : [] };
}
