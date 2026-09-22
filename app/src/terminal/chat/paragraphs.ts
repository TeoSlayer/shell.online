/**
 * Cuts terminal output into the messages a conversation is made of.
 *
 * A command's output is not one utterance. `git status` says which branch you
 * are on, then what is staged, then what is not, and a person reading it in a
 * chat reads three things, not one wall. Wrapping the lot in a single bubble
 * is what makes the renderer look like terminal output someone put a border
 * around rather than a conversation.
 *
 * Two decisions live here, and both are about what the process meant rather
 * than what it printed.
 *
 * Where one paragraph ends. A blank line is the separator every program
 * agrees on and the one a person already reads as a break, so it is the first
 * rule. It is not the only one, because plenty of output has no blank line in
 * it at all: `npm ERR!` blocks, a stack trace, a help screen and an agent's
 * own notes are all several things said in a row with nothing between them,
 * and shown as one message they are the wall this renderer exists to avoid.
 * Two more rules catch those, and both are about shape rather than content,
 * because shape is the thing the process controls deliberately. See
 * `startsNewParagraph`.
 *
 * How a paragraph should be shown: prose is prose and a table is a table.
 * Terminal output is a mix of the two, and treating all of it as preformatted
 * text is why long sentences ran off the side of a phone while a directory
 * listing had nothing to align against. A paragraph whose shape carries
 * meaning -- columns, indentation, box drawing -- is kept exactly as it was
 * written. A paragraph that is sentences is allowed to wrap.
 */

import type { TranscriptLine } from "./transcript";

export interface Paragraph {
  lines: TranscriptLine[];
  /**
   * Whether the spacing in these lines is load-bearing. Preformatted
   * paragraphs are shown in a monospace block that scrolls; the rest wrap as
   * text does.
   */
  preformatted: boolean;
}

/*
 * Box drawing, block elements and the braille range some programs draw
 * progress with. A single one of these means the line is a picture.
 */
const DRAWING = /[─-▟⣿⠀-⣿]/u;

/* Two spaces inside a line, which is a column boundary rather than a word gap. */
const COLUMN_GAP = /\S {2,}\S/u;

/** A line that is only punctuation and spaces, such as a rule under a heading. */
const RULE = /^[\s\-=_*~#+.]+$/u;

/** Leading whitespace: a line that belongs under the one above it. */
const INDENTED = /^\s{2,}\S/u;

/**
 * Whether a line's shape is carrying meaning on its own.
 *
 * The same three tests `looksPreformatted` weighs over a whole paragraph,
 * asked of one line, which is what a streaming reader has to work with.
 */
function structural(line: TranscriptLine): boolean {
  const text = line.text;
  if (DRAWING.test(text)) return true;
  if (COLUMN_GAP.test(text)) return true;
  if (INDENTED.test(text)) return true;
  return RULE.test(text) && text.trim().length > 2;
}

/**
 * Whether `next` begins a new message rather than continuing the one whose
 * lines are given.
 *
 * This is the streaming form of the rules `intoParagraphs` applies in bulk,
 * and both use it, so the two cannot drift apart. It is asked once per line
 * of output, so it looks at the tail of the open message and never at all of
 * it.
 *
 * Three rules, in the order they fire.
 *
 * **A blank line.** Handled by the caller, which drops the blank rather than
 * keeping it, so it does not reach here.
 *
 * **Back to the margin.** A line at column zero after a run of indented ones
 * is the next item in whatever list this is: the next `npm ERR!` block, the
 * next frame's heading in a stack trace, the next command in a help screen.
 * It is the one boundary that is safe in every output, because a table never
 * changes indent halfway down and a wrapped sentence never un-indents.
 *
 * **A change of shape, confirmed.** Sentences followed by columns are two
 * things, and no program prints a blank line between them reliably. The
 * confirmation matters: the run being left has to be at least two lines of
 * one kind, so a single indented line inside a paragraph of prose, or one
 * sentence inside a listing, does not cut the message in half. It is also
 * what keeps a table's own heading row attached to the table: one prose line
 * followed by columns is a heading, not a paragraph that ended.
 */
export function startsNewParagraph(open: readonly TranscriptLine[], next: TranscriptLine): boolean {
  if (open.length === 0) return false;
  const previous = open[open.length - 1];

  /* Back to the margin, after something that was hanging off it. */
  if (INDENTED.test(previous.text) && !INDENTED.test(next.text) && next.text.trim() !== "") return true;

  /* A change of shape, once the run being left is long enough to be a run. */
  if (open.length < 2) return false;
  const before = open[open.length - 2];
  const settled = structural(previous);
  if (structural(before) !== settled) return false;
  return structural(next) !== settled;
}

/**
 * Splits committed output into the messages it is made of.
 *
 * Runs of blank lines collapse: two blank lines between paragraphs is
 * typography, not two separators, and an empty message is not worth showing.
 */
export function intoParagraphs(lines: readonly TranscriptLine[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: TranscriptLine[] = [];

  const flush = () => {
    if (current.length === 0) return;
    paragraphs.push({ lines: current, preformatted: looksPreformatted(current) });
    current = [];
  };

  for (const line of lines) {
    if (line.text.trim() === "") {
      flush();
      continue;
    }
    if (startsNewParagraph(current, line)) flush();
    current.push(line);
  }
  flush();
  return paragraphs;
}

/**
 * Whether a paragraph's spacing is carrying meaning.
 *
 * Deliberately quick to say yes. Showing prose as preformatted costs a line
 * that scrolls sideways instead of wrapping; showing a table as prose
 * destroys it, and there is no getting it back from the rendered result.
 */
export function looksPreformatted(lines: readonly TranscriptLine[]): boolean {
  if (lines.length === 0) return false;

  for (const line of lines) {
    /* Anything drawn rather than written is a picture, however short. */
    if (DRAWING.test(line.text)) return true;
  }

  if (lines.length === 1) {
    /* One line alone has nothing to align with, unless it is itself columns. */
    return COLUMN_GAP.test(lines[0].text);
  }

  let structured = 0;
  for (const line of lines) {
    const text = line.text;
    if (COLUMN_GAP.test(text)) {
      structured += 1;
      continue;
    }
    /* Indentation that is not the second line of a wrapped sentence. */
    if (INDENTED.test(text)) {
      structured += 1;
      continue;
    }
    if (RULE.test(text) && text.trim().length > 2) structured += 1;
  }

  /*
   * A third is enough. A table with a plain heading row, or a tree with one
   * unindented root, would otherwise be flattened by the lines that look
   * ordinary, and those are exactly the shapes worth protecting.
   */
  return structured * 3 >= lines.length;
}
