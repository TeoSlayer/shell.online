/**
 * A screen that is repainted, read as a log that is appended to.
 *
 * Every agent interface this renderer has to read is drawn the same way: a
 * grid, repainted in full, with the conversation scrolling up through it. The
 * same line is therefore on the screen in frame after frame, and then one
 * frame later it is three rows higher, and a frame after that it is gone off
 * the top. Nothing in that stream says "this is new".
 *
 * So it is worked out. Each frame is compared against what has already been
 * given out, and the longest tail of what was given out that is also the head
 * of this frame is the part they have in common. Everything after it is new.
 * That single rule covers all three shapes a repaint comes in:
 *
 *   nothing moved      the whole of what was given out is the head of the
 *                      frame, so the overlap is everything and only the rows
 *                      added at the bottom are new
 *   the screen scrolled  the overlap is the part that survived, and the rows
 *                      the scroll revealed are new
 *   a fresh screen     nothing matches, so the frame is new in its entirety
 *
 * The last line of a frame is never given out by `read`. It is the row being
 * written, the spinner, the half-drawn tool result; it is the same rule the
 * terminal reader upstream applies to the cursor row, for the same reason,
 * and without it every frame of a spinner is a message.
 *
 * Which leaves the line an agent stops on. A program that has finished
 * painting sends no more frames, so the row it finished on would be held back
 * for ever and the last thing it said would never arrive. `flush` is how the
 * caller says the screen has gone quiet and that row is not being written
 * after all.
 */

/**
 * How many given-out lines are kept to compare against.
 *
 * Only has to cover the tallest screen an agent can draw, because the overlap
 * can never be longer than the frame. A few screens' worth is generous and
 * stops a session that has run all day from holding its whole history twice.
 */
const REMEMBERED = 400;

export class RepaintReader {
  private given: string[] = [];
  /** The last frame seen in full, including the row that was held back. */
  private pending: readonly string[] = [];

  /**
   * The lines this frame added, in order.
   *
   * `frame` is the screen top to bottom, already stripped of whatever the
   * agent draws around its conversation. Blank lines are kept: they are how
   * the paragraphs downstream are cut.
   */
  read(frame: readonly string[]): string[] {
    /*
     * A screen is mostly empty at the bottom, and those rows are not content.
     * Trimmed before the comparison so that a conversation which has not
     * changed does not look as though it has, frame after frame, because the
     * blank space under it grew or shrank by a row.
     */
    const settled = trimTrailingBlanks(frame);
    // Erasing and repainting often span transport chunks. A shorter prefix
    // is an incomplete paint, not a replacement for the latest live tail.
    if (settled.length < this.pending.length && matches(this.pending, 0, settled, settled.length)) return [];
    this.pending = settled;
    /* The last line is still being written; see the note at the top. */
    if (settled.length <= 1) return [];
    return this.give(settled, settled.length - 1);
  }

  /**
   * The row that was being written was the last one there is.
   *
   * Called when the screen has gone quiet, which is the only thing that can
   * distinguish a row still being drawn from the row a program finished on:
   * they look identical in a single frame, and the difference is whether
   * another frame follows.
   */
  flush(): string[] {
    return this.give(this.pending);
  }

  /** Forgets the screen. Used when the program exits or the session replays. */
  reset(): void {
    this.given = [];
    this.pending = [];
  }

  /** Uncommitted rows, for a reversible quiet-time preview. */
  preview(): string[] {
    return this.pending.slice(this.overlap(this.pending));
  }

  private give(lines: readonly string[], end = lines.length): string[] {
    const fresh = lines.slice(this.overlap(lines), end);
    if (fresh.length === 0) return [];
    this.given.push(...fresh);
    const remembered = Math.max(REMEMBERED, lines.length);
    if (this.given.length > remembered) this.given.splice(0, this.given.length - remembered);
    return fresh;
  }

  /**
   * How much of this frame has already been given out.
   *
   * Read as "find where we left off", not "the history must still be the head
   * of the screen". The difference is the whole of this class working or not.
   *
   * It used to require every line already given out to match the head of the
   * frame. That holds only while nothing above the conversation changes, and
   * on a real screen something always does: a spinner, a tip that appears and
   * goes, a status line counting seconds. One line different anywhere above,
   * and the match fell to nothing and the entire screen was given out again --
   * which downstream is every message in the session arriving a second time,
   * and a third, for as long as the agent is thinking. That is the duplication
   * somebody was looking at.
   *
   * What is actually needed is one anchor: the tail of what was given out,
   * found anywhere in this frame. Everything after it is new, and whatever
   * changed above it does not matter, because it has been given out already
   * and is not being given out again.
   *
   * The longest anchor wins, and the latest position of it, so that a line
   * repeated on screen resolves to the most recent one. An anchor of nothing
   * but blank lines is no anchor at all -- blanks are everywhere -- so it must
   * hold something that was actually said.
   */
  private overlap(frame: readonly string[]): number {
    const most = Math.min(this.given.length, frame.length);
    for (let length = most; length > 0; length -= 1) {
      const from = this.given.length - length;
      if (!said(this.given, from, length)) continue;
      for (let at = frame.length - length; at >= 0; at -= 1) {
        if (matches(this.given, from, frame.slice(at), length)) return at + length;
      }
    }
    return this.rejoin(frame);
  }

  /**
   * Where this frame rejoins the conversation, when the tail is no help.
   *
   * The anchor above is the end of what was given out, and it only works
   * while the end of what was given out is still on the screen. Some of it
   * does not stay: this program draws a tip in a box under the conversation
   * and then takes it away again, so the last rows given were rows that no
   * longer exist anywhere, no anchor was found, and a frame holding the whole
   * session was handed over as though none of it had been seen. That is the
   * screen arriving again from the top -- the splash, every prompt, every
   * answer -- for as long as the agent keeps working.
   *
   * A conversation only grows, so any row already given out is old wherever
   * it now sits. The last row of this frame that has been given before is
   * therefore the join, and everything under it is new. The row above it has
   * to agree where both have one, because a single line on its own is a thing
   * a screen repeats -- and a blank row, or a status line already flattened to
   * a placeholder, is no evidence at all.
   */
  private rejoin(frame: readonly string[]): number {
    for (let at = frame.length - 1; at >= 0; at -= 1) {
      if (!distinct(frame[at])) continue;
      for (let seen = this.given.length - 1; seen >= 0; seen -= 1) {
        if (this.given[seen] !== frame[at]) continue;
        const above = at > 0 && seen > 0 && distinct(frame[at - 1]);
        if (above && this.given[seen - 1] !== frame[at - 1]) continue;
        return at + 1;
      }
    }
    return 0;
  }
}

/** A row specific enough to recognise a place by. */
function distinct(line: string): boolean {
  const text = line.trim();
  return text !== "" && text !== "\u273B";
}

/** Whether a run of given-out lines holds anything but blank rows. */
function said(given: readonly string[], from: number, length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (given[from + index].trim() !== "") return true;
  }
  return false;
}

function matches(given: readonly string[], from: number, frame: readonly string[], length: number): boolean {
  for (let index = 0; index < length; index += 1) {
    if (given[from + index] !== frame[index]) return false;
  }
  return true;
}

function trimTrailingBlanks(lines: readonly string[]): readonly string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  return end === lines.length ? lines : lines.slice(0, end);
}
