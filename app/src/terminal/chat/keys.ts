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

export interface KeyChip {
  label: string;
  bytes: string;
  title: string;
  /**
   * Which mode the chip belongs to.
   *
   * The two modes want different keys, and offering the wrong ones is worse
   * than offering none. An arrow chip while the composer is writing lines
   * moves the shell's own history, which is a line this browser cannot see
   * and would then send a different one over the top of; the composer's own
   * Up and Down walk the conversation instead, which is the history somebody
   * can actually read. Tab is the same story: the completed line lands on the
   * prompt row, and the prompt row is the one thing a conversation does not
   * show.
   */
  mode: "line" | "direct" | "both";
}

/** The control keys the composer offers as buttons, for phones and for TUIs. */
export const KEY_CHIPS: readonly KeyChip[] = [
  { label: "Ctrl-C", bytes: "\x03", title: "Interrupt the running command", mode: "both" },
  { label: "Ctrl-D", bytes: "\x04", title: "End of input", mode: "line" },
  { label: "Esc", bytes: "\x1b", title: "Escape", mode: "both" },
  { label: "Tab", bytes: "\t", title: "Complete", mode: "direct" },
  { label: "Enter", bytes: "\r", title: "Return", mode: "direct" },
  { label: "↑", bytes: "\x1b[A", title: "Up", mode: "direct" },
  { label: "↓", bytes: "\x1b[B", title: "Down", mode: "direct" },
];

/** The chips to show, given whether a program is reading keys directly. */
export function chipsFor(direct: boolean): readonly KeyChip[] {
  return KEY_CHIPS.filter((chip) => chip.mode === "both" || chip.mode === (direct ? "direct" : "line"));
}
