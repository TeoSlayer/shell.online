import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, dedent, strip, unwrap } from "./claude-code";
import { CLAUDE_EXCHANGE, CLAUDE_START, CLAUDE_TITLE } from "./fixtures/claude-code";
import { adapterFor } from "./index";
import { plainLine } from "../transcript";

/*
 * Everything below reads one of two frames captured from Claude Code itself.
 * The version of this file that read a frame somebody imagined passed, and
 * the adapter it was testing recognised nothing on a real screen.
 */
const read = (adapter: ClaudeCodeAdapter, frame: readonly string[]) =>
  adapter.read(frame.map(plainLine));

const shape = (utterances: ReturnType<ClaudeCodeAdapter["read"]>) =>
  utterances.map((u) => `${u.kind}${u.open ? "(open)" : ""}:${u.text || u.lines.map((l) => l.text).join(" / ")}`);

describe("recognising the program", () => {
  /*
   * The header is on screen at startup and gone a few exchanges later, so the
   * name cannot be the thing that identifies the program -- which is exactly
   * how an adapter stopped recognising a session precisely when it had a
   * conversation worth reading.
   */
  it("knows it by the title, which does not scroll away", () => {
    expect(CLAUDE_EXCHANGE.some((line) => /claude code/i.test(line))).toBe(false);
    expect(new ClaudeCodeAdapter().matches(CLAUDE_EXCHANGE, CLAUDE_TITLE)).toBe(true);
  });

  /*
   * The title stops being the program's name the moment it has work to do:
   * a session asked to list a directory reported "✳ List directory files".
   * The glyph in front of it is what stays.
   */
  it("knows it by the title after the title becomes a summary of the work", () => {
    expect(new ClaudeCodeAdapter().matches([], "✳ List directory files")).toBe(true);
  });

  /*
   * A rule is only on screen while the composer is, and a conversation long
   * enough to fill the grid pushes it off -- which is precisely the screen an
   * adapter most needs to recognise.
   */
  it("knows it from a screen the composer has scrolled off", () => {
    const scrolled = CLAUDE_EXCHANGE.filter((line) => !/^[─━]/u.test(line));
    expect(new ClaudeCodeAdapter().matches(scrolled)).toBe(true);
  });

  it("knows it by its header before anything has been said", () => {
    expect(new ClaudeCodeAdapter().matches(CLAUDE_START)).toBe(true);
  });

  it("knows it by its markers when the terminal reports no title", () => {
    expect(new ClaudeCodeAdapter().matches(CLAUDE_EXCHANGE)).toBe(true);
  });

  it("does not claim a shell that merely has a prompt on it", () => {
    expect(new ClaudeCodeAdapter().matches(["❯ ls", "a.txt  b.txt", "❯"])).toBe(false);
  });

  it("does not claim an editor", () => {
    expect(adapterFor(["  1 const x = 1;", " NORMAL  notes.md    6,1  All"])).toBeNull();
  });
});

describe("taking the interface off", () => {
  /*
   * The composer is two full-width rules with a line between them, and the
   * program's own status lines are *below* the second one. A reader looking
   * for the last box on the screen finds none and keeps the lot, which is
   * every keystroke and every status line arriving as a message.
   */
  it("drops the composer and everything under it", () => {
    const kept = strip(CLAUDE_EXCHANGE);
    expect(kept.join("\n")).not.toContain("─────");
    expect(kept.join("\n")).not.toContain("auto mode on");
    expect(kept.join("\n")).not.toContain("Transcript saving is off");
    expect(kept.join("\n")).not.toContain("Cooked for 13s");
    expect(kept.filter((line) => line.trim() !== "").at(-1)).toBe("  Done.");
  });

  it("keeps everything that was said", () => {
    const kept = strip(CLAUDE_EXCHANGE).join("\n");
    expect(kept).toContain("list the files in this directory");
    expect(kept).toContain("Here's what's in /private/tmp:");
    expect(kept).toContain("cc-socks");
  });
});

describe("reading a real exchange", () => {
  it("gives the prompt, the tool and what the agent said", () => {
    const shaped = shape(read(new ClaudeCodeAdapter(), CLAUDE_EXCHANGE));
    expect(shaped[0]).toBe("sent:list the files in this directory, then say done");
    expect(shaped[1]).toBe("tool:Listed 1 directory");
    expect(shaped[2]).toContain("received");
    expect(shaped[2]).toContain("Here's what's in /private/tmp:");
  });

  /*
   * `⏺` is the agent speaking. It was read as a tool call, which put what the
   * agent said into a one-line heading and threw the rest of it away.
   */
  it("treats the filled circle as speech, not as a tool", () => {
    const spoke = read(new ClaudeCodeAdapter(), CLAUDE_EXCHANGE).filter((u) => u.kind === "received");
    expect(spoke.length).toBeGreaterThan(0);
    expect(spoke.map((u) => u.lines.map((l) => l.text).join("\n")).join("\n")).toContain("Directories");
  });

  it("says nothing for the splash a program draws before anybody speaks", () => {
    const shaped = shape(read(new ClaudeCodeAdapter(), CLAUDE_START));
    expect(shaped.join("\n")).not.toContain("Claude Code v2.1.280");
    expect(shaped.join("\n")).not.toContain("login expires");
  });

  it("says nothing for a status line", () => {
    const shaped = shape(read(new ClaudeCodeAdapter(), CLAUDE_EXCHANGE)).join("\n");
    expect(shaped).not.toContain("Cooked for");
  });

  /*
   * The paragraph the agent is still writing is offered again each frame with
   * whatever it has gained, so a reader downstream can treat every one of
   * them as "this is the paragraph now". What must not repeat is anything
   * finished.
   */
  it("repeats only the paragraph still being written", () => {
    const adapter = new ClaudeCodeAdapter();
    const first = read(adapter, CLAUDE_EXCHANGE);
    const second = read(adapter, CLAUDE_EXCHANGE);
    expect(second.every((u) => u.kind === "received" && u.open)).toBe(true);
    expect(shape(second)).toEqual(shape(first.filter((u) => u.open)));
  });

  it("never gives out the line being typed into the composer", () => {
    const adapter = new ClaudeCodeAdapter();
    const typing = CLAUDE_EXCHANGE.map((line) => (line === "❯" ? "❯ half a thought" : line));
    expect(shape(read(adapter, typing)).join("\n")).not.toContain("half a thought");
  });
});

describe("the interface's own indent and wrapping", () => {
  it("comes off the paragraph", () => {
    expect(dedent(["  one", "  two"])).toEqual(["one", "two"]);
  });

  it("leaves the indent the writer meant", () => {
    expect(dedent(["  Directories", "  - cc-socks", "    wrapped"])).toEqual([
      "Directories",
      "- cc-socks",
      "  wrapped",
    ]);
  });

  it("joins the rows a terminal wrapped", () => {
    expect(
      unwrap([
        "The store now acquires from the pool and releases in a finally",
        "block, so a thrown query cannot leak a connection.",
      ]),
    ).toEqual([
      "The store now acquires from the pool and releases in a finally block, so a thrown query cannot leak a connection.",
    ]);
  });

  it("keeps a list a list, however full the row above it was", () => {
    expect(
      unwrap([
        "There are two things left to do before this can be merged, and they",
        "- cap the pool",
      ]),
    ).toEqual(["There are two things left to do before this can be merged, and they", "- cap the pool"]);
  });
});
