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
 * Where one paragraph ends: a blank line. It is the one separator every
 * program agrees on, from a commit message to a test summary, and it is the
 * separator a person already reads as a break.
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

/**
 * Splits committed output on blank lines.
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
    if (line.text.trim() === "") flush();
    else current.push(line);
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
    if (/^\s{2,}\S/u.test(text)) {
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
