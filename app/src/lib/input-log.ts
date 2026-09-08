/**
 * Turns a stream of keystrokes into the lines a person actually submitted.
 *
 * A terminal receives one keystroke at a time, including corrections. What is
 * worth auditing is not every byte but the line that was finally entered: the
 * command for a shell, the prompt for an agent. So this assembles bytes into a
 * line and emits it on Enter, applying the edits along the way.
 *
 * It deliberately understands only the editing keys a person uses at a raw
 * prompt. Anything a full-screen program interprets for itself, arrow keys and
 * other escape sequences, is dropped rather than guessed at.
 */

export type EntryKind = "input" | "interrupt";

export interface Entry {
  kind: EntryKind;
  text: string;
}

const ENTER = ["\r", "\n"];
const BACKSPACE = ["\x7f", "\b"];
const CTRL_C = "\x03";
const CTRL_U = "\x15";
const CTRL_W = "\x17";
const ESCAPE = "\x1b";

/** Longer than this is not a command, and not worth storing whole. */
export const MAX_ENTRY_LENGTH = 4000;

/*
 * Escape sequences come in two shapes worth distinguishing. CSI is
 * "ESC [ ... final", used by arrow keys. SS3 is "ESC O x", exactly one byte
 * after the intro, used by function keys. Treating them alike let the byte
 * after "ESC O" through as if it had been typed.
 */
type EscapeState = "none" | "intro" | "csi" | "ss3";

export class InputLog {
  private buffer = "";
  private escape: EscapeState = "none";

  /**
   * Feeds terminal input and returns whatever was completed by it.
   *
   * One chunk can complete several lines, as when text is pasted.
   */
  push(data: string): Entry[] {
    const entries: Entry[] = [];

    for (const character of data) {
      if (this.escape === "intro") {
        if (character === "[") this.escape = "csi";
        else if (character === "O") this.escape = "ss3";
        else this.escape = "none";
        continue;
      }
      if (this.escape === "ss3") {
        /* Exactly one byte names the key, and it is not typed text. */
        this.escape = "none";
        continue;
      }
      if (this.escape === "csi") {
        /* A CSI sequence ends at its final byte, in the range @ to ~. */
        const code = character.codePointAt(0) ?? 0;
        if (code >= 0x40 && code <= 0x7e) this.escape = "none";
        continue;
      }

      if (character === ESCAPE) {
        this.escape = "intro";
        continue;
      }

      if (ENTER.includes(character)) {
        const text = this.buffer.trim();
        this.buffer = "";
        if (text) entries.push({ kind: "input", text: clamp(text) });
        continue;
      }

      if (character === CTRL_C) {
        const pending = this.buffer.trim();
        this.buffer = "";
        entries.push({ kind: "interrupt", text: pending ? clamp(pending) : "" });
        continue;
      }

      if (character === CTRL_U) {
        this.buffer = "";
        continue;
      }

      if (character === CTRL_W) {
        /*
         * Delete back over trailing space, then over one word, which is what
         * a shell does. The space before the deleted word stays, so the next
         * thing typed does not run into the previous word.
         */
        this.buffer = this.buffer.replace(/\s+$/, "").replace(/\S+$/, "");
        continue;
      }

      if (BACKSPACE.includes(character)) {
        this.buffer = this.buffer.slice(0, -1);
        continue;
      }

      /* Remaining control characters are not text a person typed. */
      const code = character.codePointAt(0) ?? 0;
      if (code < 0x20) continue;

      this.buffer += character;
      /* Stop the buffer growing without bound on a runaway paste. */
      if (this.buffer.length > MAX_ENTRY_LENGTH * 2) {
        this.buffer = this.buffer.slice(-MAX_ENTRY_LENGTH);
      }
    }

    return entries;
  }

  /** What has been typed but not yet submitted. */
  get pending(): string {
    return this.buffer;
  }
}

function clamp(text: string): string {
  return text.length > MAX_ENTRY_LENGTH ? `${text.slice(0, MAX_ENTRY_LENGTH)}…` : text;
}
