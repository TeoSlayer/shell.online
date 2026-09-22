/**
 * Translates a browser key press into the bytes a terminal expects.
 *
 * The chat composer sends whole lines, which is the right unit for a shell and
 * the wrong one for everything else: a full-screen program wants the arrow key
 * the moment it is pressed, and Ctrl-C has to arrive while the command it is
 * cancelling is still running. So the chat keeps a direct mode, and this is
 * what direct mode types with.
 *
 * It covers the keys a person uses, and deliberately nothing more. A sequence
 * this does not know is not guessed at: returning null lets the caller leave
 * the browser's own default alone rather than sending a plausible-looking byte
 * the program will misread.
 *
 * There used to be a table of control keys here as well, drawn as chips above
 * the composer. They are gone: on a phone they were half the height of the box
 * and standing over the conversation at all times, and a keyboard has the keys
 * themselves. What a touch screen has lost with them is any way to interrupt a
 * running program, which wants somewhere of its own rather than a row inside
 * the thing you type into.
 */

export interface KeyPress {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/* Application cursor mode swaps the introducer; both forms are common. */
const CURSOR: Record<string, [normal: string, application: string]> = {
  ArrowUp: ["\x1b[A", "\x1bOA"],
  ArrowDown: ["\x1b[B", "\x1bOB"],
  ArrowRight: ["\x1b[C", "\x1bOC"],
  ArrowLeft: ["\x1b[D", "\x1bOD"],
  Home: ["\x1b[H", "\x1bOH"],
  End: ["\x1b[F", "\x1bOF"],
};

const PLAIN: Record<string, string> = {
  Enter: "\r",
  Tab: "\t",
  Backspace: "\x7f",
  Escape: "\x1b",
  Delete: "\x1b[3~",
  Insert: "\x1b[2~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
};

const FUNCTION: Record<string, string> = {
  F1: "\x1bOP", F2: "\x1bOQ", F3: "\x1bOR", F4: "\x1bOS",
  F5: "\x1b[15~", F6: "\x1b[17~", F7: "\x1b[18~", F8: "\x1b[19~",
  F9: "\x1b[20~", F10: "\x1b[21~", F11: "\x1b[23~", F12: "\x1b[24~",
};

export function bytesForKey(event: KeyPress, applicationCursor = false): string | null {
  /*
   * The platform shortcuts stay with the browser. Copy, paste, find and tab
   * switching are the viewer's, not the session's, and a terminal that
   * swallowed Cmd-C would make its own output impossible to take away.
   */
  if (event.metaKey) return null;

  if (event.ctrlKey && !event.altKey) {
    const letter = event.key.length === 1 ? event.key.toLowerCase() : "";
    if (letter >= "a" && letter <= "z") {
      return String.fromCharCode(letter.charCodeAt(0) - 96);
    }
    /* The handful of control codes that are not a letter. */
    const punctuation: Record<string, string> = {
      " ": "\x00", "@": "\x00", "[": "\x1b", "\\": "\x1c", "]": "\x1d", "^": "\x1e", "_": "\x1f", "?": "\x7f",
    };
    const found = punctuation[event.key];
    if (found) return found;
  }

  const cursor = CURSOR[event.key];
  if (cursor) return cursor[applicationCursor ? 1 : 0];

  const fn = FUNCTION[event.key];
  if (fn) return fn;

  const plain = PLAIN[event.key];
  if (plain) return event.altKey ? `\x1b${plain}` : plain;

  /* Ordinary typing. Alt sends the escape prefix that terminals read as Meta. */
  if (event.key.length === 1 || [...event.key].length === 1) {
    return event.altKey ? `\x1b${event.key}` : event.key;
  }

  return null;
}
