import { describe, expect, it } from "vitest";
import { InputLog, MAX_ENTRY_LENGTH } from "./input-log";

function feed(chunks: string[]) {
  const log = new InputLog();
  return chunks.flatMap((chunk) => log.push(chunk));
}

describe("submitting a line", () => {
  it("records what was entered, not the keystrokes", () => {
    expect(feed(["l", "s", " ", "-", "l", "\r"])).toEqual([
      { kind: "input", text: "ls -l" },
    ]);
  });

  it("accepts a line arriving as one chunk, as when pasted", () => {
    expect(feed(["npm run build\r"])).toEqual([
      { kind: "input", text: "npm run build" },
    ]);
  });

  it("records several lines from one chunk", () => {
    expect(feed(["one\rtwo\rthree\r"])).toEqual([
      { kind: "input", text: "one" },
      { kind: "input", text: "two" },
      { kind: "input", text: "three" },
    ]);
  });

  it("treats newline like return", () => {
    expect(feed(["hello\n"])).toEqual([{ kind: "input", text: "hello" }]);
  });

  it("ignores an empty line", () => {
    expect(feed(["\r", "\r", "   \r"])).toEqual([]);
  });

  it("emits nothing until the line is submitted", () => {
    const log = new InputLog();
    expect(log.push("git comm")).toEqual([]);
    expect(log.pending).toBe("git comm");
    expect(log.push("it\r")).toEqual([{ kind: "input", text: "git commit" }]);
    expect(log.pending).toBe("");
  });
});

describe("corrections", () => {
  it("applies backspace, so the record is what was meant", () => {
    expect(feed(["lsss", "\x7f", "\x7f", " -l\r"])).toEqual([
      { kind: "input", text: "ls -l" },
    ]);
  });

  it("accepts the other backspace byte", () => {
    expect(feed(["abc", "\b", "\r"])).toEqual([{ kind: "input", text: "ab" }]);
  });

  it("backspaces past the start without going negative", () => {
    expect(feed(["\x7f\x7f\x7f", "ok\r"])).toEqual([{ kind: "input", text: "ok" }]);
  });

  it("clears the line on Ctrl-U", () => {
    expect(feed(["rm -rf /", "\x15", "ls\r"])).toEqual([
      { kind: "input", text: "ls" },
    ]);
  });

  it("deletes a word on Ctrl-W", () => {
    expect(feed(["git commit wrong", "\x17", "--amend\r"])).toEqual([
      { kind: "input", text: "git commit --amend" },
    ]);
  });
});

describe("interrupts", () => {
  it("records Ctrl-C, with whatever was half-typed", () => {
    expect(feed(["sleep 100", "\x03"])).toEqual([
      { kind: "interrupt", text: "sleep 100" },
    ]);
  });

  it("records a bare Ctrl-C", () => {
    expect(feed(["\x03"])).toEqual([{ kind: "interrupt", text: "" }]);
  });

  it("does not carry the abandoned text into the next line", () => {
    expect(feed(["abandoned", "\x03", "ls\r"])).toEqual([
      { kind: "interrupt", text: "abandoned" },
      { kind: "input", text: "ls" },
    ]);
  });
});

describe("things that are not typed text", () => {
  it("drops arrow keys rather than recording their bytes", () => {
    /* A full-screen program reads these itself; they are not a submission. */
    expect(feed(["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "ls\r"])).toEqual([
      { kind: "input", text: "ls" },
    ]);
  });

  it("drops a function key", () => {
    expect(feed(["\x1bOP", "top\r"])).toEqual([{ kind: "input", text: "top" }]);
  });

  it("drops other control characters", () => {
    expect(feed(["a", "\x00", "\x07", "\x1f", "b\r"])).toEqual([
      { kind: "input", text: "ab" },
    ]);
  });

  it("keeps tabs out of the recorded text", () => {
    expect(feed(["cd sr", "\t", "c\r"])).toEqual([{ kind: "input", text: "cd src" }]);
  });
});

describe("bounds", () => {
  it("truncates a very long line rather than storing it whole", () => {
    const long = "x".repeat(MAX_ENTRY_LENGTH + 500);
    const [entry] = feed([long, "\r"]);
    expect(entry.text.length).toBe(MAX_ENTRY_LENGTH + 1);
    expect(entry.text.endsWith("…")).toBe(true);
  });

  it("does not let an unsubmitted buffer grow without bound", () => {
    const log = new InputLog();
    for (let i = 0; i < 20; i += 1) log.push("y".repeat(1000));
    expect(log.pending.length).toBeLessThanOrEqual(MAX_ENTRY_LENGTH * 2);
  });
});

describe("agent prompts", () => {
  it("records a prompt the same way as a command", () => {
    /* For an agent the submitted line is the prompt; the mechanism is one. */
    expect(feed(["refactor the parser to use a table\r"])).toEqual([
      { kind: "input", text: "refactor the parser to use a table" },
    ]);
  });

  it("records a prompt containing punctuation and quotes intact", () => {
    expect(feed([`fix "the bug" in src/main.go, then run tests\r`])).toEqual([
      { kind: "input", text: `fix "the bug" in src/main.go, then run tests` },
    ]);
  });
});
