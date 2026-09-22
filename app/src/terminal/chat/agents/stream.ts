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
    this.pending = settled;
    /* The last line is still being written; see the note at the top. */
    if (settled.length <= 1) return [];
    return this.give(settled.slice(0, -1));
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

  private give(lines: readonly string[]): string[] {
    const fresh = lines.slice(this.overlap(lines));
    if (fresh.length === 0) return [];
    this.given.push(...fresh);
    if (this.given.length > REMEMBERED) this.given.splice(0, this.given.length - REMEMBERED);
    return fresh;
  }

  /**
   * How much of the head of this frame has already been given out.
   *
   * The longest match wins. A short one is almost always a coincidence -- one
   * blank line, or a row of the same box character -- and taking it would give
   * out the rest of the frame a second time.
   */
  private overlap(frame: readonly string[]): number {
    const most = Math.min(this.given.length, frame.length);
    for (let length = most; length > 0; length -= 1) {
      if (matches(this.given, this.given.length - length, frame, length)) return length;
    }
    return 0;
  }
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
