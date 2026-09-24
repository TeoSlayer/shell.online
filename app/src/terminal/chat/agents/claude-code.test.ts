import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, dedent, strip, unwrap } from "./claude-code";
import {
  CLAUDE_EXCHANGE,
  CLAUDE_START,
  CLAUDE_TITLE,
  CLAUDE_TYPING,
  CLAUDE_WRAPPED_PROMPT,
} from "./fixtures/claude-code";
import { adapterFor } from "./index";
import { Transcript, plainLine } from "../transcript";

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
    /* The status line above the composer is `classify`'s to drop, not this. */
    expect(kept.filter((line) => line.trim() !== "").at(-1)).toBe("✻ Cooked for 13s · done 8:29 PM");
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

  /*
   * Everything the program says about itself rather than about the work. The
   * spinner cycles a whole block of glyphs, and the tip and the update line
   * carry no marker at all.
   */
  it("says nothing for any of the shapes a status line comes in", () => {
    const adapter = new ClaudeCodeAdapter();
    const frame = [
      "❯ do the thing",
      "",
      "⏺ Working on it.",
      "",
      "✽ Flowing… (8m 57s · ↓ 10.8k tokens)",
      "✻ Cooked for 13s · done 8:29 PM",
      "◐ medium · /effort",
      "Tip: Use /config to change your default permission mode (including Plan Mode",
      "✔ Update installed · Restart to update",
      "⏵⏵ auto mode on (shift+tab to cycle)",
      "",
      "────────────────────────────────────────",
      "❯",
      "────────────────────────────────────────",
    ];
    const said = shape(read(adapter, frame)).join("\n");
    expect(said).toContain("Working on it.");
    for (const noise of ["Flowing", "Cooked for", "medium", "Tip:", "Update installed", "auto mode on"]) {
      expect(said).not.toContain(noise);
    }
  });

  /*
   * A wide terminal lets a program put two things at opposite ends of one
   * row, so a line can start as a tip and end as an update.
   */
  it("says nothing for two status lines sharing a row", () => {
    const adapter = new ClaudeCodeAdapter();
    const frame = [
      "❯ ask",
      "",
      "⏺ answered",
      "",
      "  Tip: use /config for the permission mode          ✔ Update installed · Restart to update",
      "",
      "────────────────────────────────────────",
      "❯",
      "────────────────────────────────────────",
    ];
    const said = shape(read(adapter, frame)).join("\n");
    expect(said).toContain("answered");
    expect(said).not.toContain("Update installed");
    expect(said).not.toContain("Tip:");
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

  /*
   * The case that reached somebody's phone: typing on a laptop, where the
   * line being written wraps inside the composer. Read by shape, the rows
   * below the prompt are ordinary text, so the walk up from the foot of the
   * screen stopped at the first of them and gave the rest out -- half a
   * half-finished sentence arriving elsewhere as a message nobody had sent.
   */
  it("never gives out a line being typed that has wrapped onto more rows", () => {
    const adapter = new ClaudeCodeAdapter();
    const typing = [
      "❯ an earlier question",
      "",
      "⏺ an earlier answer",
      "",
      "────────────────────────────────────────",
      "❯ this is a long thought that somebody is",
      "  still in the middle of writing and it has",
      "  wrapped onto three rows of the box",
      "────────────────────────────────────────",
      "  ⏵⏵ auto mode on",
    ];
    const said = shape(read(adapter, typing)).join("\n");
    expect(said).not.toContain("still in the middle of writing");
    expect(said).not.toContain("wrapped onto three rows");
    expect(said).not.toContain("this is a long thought");
    /* What was actually said is still there. */
    expect(said).toContain("an earlier question");
  });

  /* The same thing, from a frame captured while it was actually being typed. */
  it("says nothing at all for a real screen with an unsent line on it", () => {
    const adapter = new ClaudeCodeAdapter();
    expect(shape(read(adapter, CLAUDE_TYPING))).toEqual([]);
  });

  /*
   * And it arrives the moment it is sent, because the program itself moves it
   * out of the composer and up into the conversation.
   */
  it("gives it out once it has been sent", () => {
    const adapter = new ClaudeCodeAdapter();
    read(adapter, [
      "────────────────────────────────────────",
      "❯ a thought half written",
      "────────────────────────────────────────",
    ]);
    const sent = shape(
      read(adapter, [
        "❯ a thought half written, now finished",
        "",
        "⏺ working on it",
        "",
        "────────────────────────────────────────",
        "❯",
        "────────────────────────────────────────",
      ]),
    );
    expect(sent).toContain("sent:a thought half written, now finished");
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

describe("a prompt the terminal had to wrap", () => {
  /*
   * The case somebody reported as "sent messages randomly decompose into
   * separate markdown-like threads". The rest of the prompt is an indented
   * line with no marker, arriving before the agent has spoken, which is the
   * shape this adapter reads as a tool -- so the back half of what they typed
   * arrived as its own message, and a long enough prompt came apart into
   * several.
   */
  it("arrives as the one message somebody sent", () => {
    const shaped = shape(read(new ClaudeCodeAdapter(), CLAUDE_WRAPPED_PROMPT));
    expect(shaped[0]).toBe(
      "sent:Please reply with exactly the single word acknowledged and nothing else, no preamble, no explanation, no tool calls, just that one word on its own line",
    );
  });

  it("does not leave the rest of it behind as a tool", () => {
    const said = shape(read(new ClaudeCodeAdapter(), CLAUDE_WRAPPED_PROMPT));
    expect(said.filter((u) => u.startsWith("tool:"))).toEqual([]);
    expect(said.join("\n")).not.toContain("received:preamble");
  });

  it("still reads what the agent said back", () => {
    const said = shape(read(new ClaudeCodeAdapter(), CLAUDE_WRAPPED_PROMPT)).join("\n");
    expect(said).toContain("acknowledged");
  });
});

describe('streaming parser boundaries', () => {
  it('does not consume an answer marker as part of an adjacent prompt', () => {
    const adapter = new ClaudeCodeAdapter();
    const said = [...read(adapter, ['❯ hello', '⏺ answer', '  more', '✻ Done']), ...adapter.flush()];
    expect(said.find(u => u.kind === 'sent')?.text).toBe('hello');
    expect(said.some(u => u.kind === 'received' && u.lines.some(l => l.text.includes('answer')))).toBe(true);
  });

  it('does not join a deliberate short line after an already unwrapped paragraph', () => {
    expect(unwrap(['This is a sentence that reaches the terminal edge exactly', 'and continues.', 'New paragraph.'])).toEqual([
      'This is a sentence that reaches the terminal edge exactly and continues.', 'New paragraph.',
    ]);
  });
});

describe('quiet-time previews through the transcript', () => {
  it('keeps one growing message through repeated idle pauses and repaints', () => {
    const adapter = new ClaudeCodeAdapter();
    const transcript = new Transcript();
    const feed = (utterances: ReturnType<ClaudeCodeAdapter['read']>) => {
      for (const utterance of utterances) transcript.fromAgent(utterance, 1);
    };
    feed(read(adapter, ['❯ question', '', '⏺ partial']));
    feed(adapter.settle());
    const id = transcript.messages.find(m => m.kind === 'received')!.id;
    for (const answer of ['partial', 'partial answer', 'partial answer complete']) {
      feed(read(adapter, ['❯ question', '', `⏺ ${answer}`]));
      feed(adapter.settle());
      expect(transcript.messages.filter(m => m.kind === 'received')).toHaveLength(1);
      expect(transcript.messages.find(m => m.id === id)?.lines.map(l => l.text)).toEqual([answer]);
    }
    feed(adapter.flush());
    expect(transcript.messages.filter(m => m.kind === 'received')).toHaveLength(1);
    expect(transcript.messages.find(m => m.id === id)?.open).toBe(false);
  });

  it('does not shrink the preview between paints and the next quiet timer', () => {
    const adapter = new ClaudeCodeAdapter();
    const transcript = new Transcript();
    const feed = (rows: ReturnType<ClaudeCodeAdapter['read']>) => rows.forEach(u => transcript.fromAgent(u, 1));
    feed(read(adapter, ['⏺ first row', '  live tail']));
    feed(adapter.settle());
    const before = JSON.stringify(transcript.messages);
    feed(read(adapter, ['⏺ first row', '  live tail']));
    expect(JSON.stringify(transcript.messages)).toBe(before);
  });

  it('does not replay previous paragraphs when a spinner or header changes', () => {
    const adapter = new ClaudeCodeAdapter();
    const transcript = new Transcript();
    const frame = (n: number) => [`Tip: suggestion ${n}`, '❯ question', '', '⏺ first answer', '', `✻ Working ${n}`, '', '⏺ second answer', '  more'];
    for (let n = 0; n < 10; n++) {
      for (const u of read(adapter, frame(n))) transcript.fromAgent(u, n);
      for (const u of adapter.settle()) transcript.fromAgent(u, n);
    }
    expect(transcript.messages.filter(m => m.kind === 'sent')).toHaveLength(1);
    expect(transcript.messages.filter(m => m.kind === 'received')).toHaveLength(2);
  });
});

describe('fenced output', () => {
  it('keeps blank lines and prompt-like text inside a code block', () => {
    const adapter = new ClaudeCodeAdapter();
    const transcript = new Transcript();
    for (const u of [...read(adapter, ['⏺ ```text', '  first', '', '  ❯ literal prompt', '  ⏺ literal bullet', '  ✓ literal result', '  ```', '✻ Done']), ...adapter.flush()]) {
      transcript.fromAgent(u, 1);
    }
    const messages = transcript.messages.filter(m => m.kind === 'received');
    expect(messages).toHaveLength(1);
    expect(messages[0].preformatted).toBe(true);
    expect(messages[0].lines.map(l => l.text)).toContain('');
    expect(messages[0].lines.map(l => l.text).join('\n')).toContain('literal prompt');
  });
});


describe("fragmented repaint", () => {
  it("keeps an idle preview visible while the screen is cleared and rebuilt", () => {
    const adapter = new ClaudeCodeAdapter();
    const transcript = new Transcript();
    const feed = (rows: ReturnType<ClaudeCodeAdapter["read"]>) => rows.forEach(u => transcript.fromAgent(u, 1));
    feed(read(adapter, ["⏺ first row", "  live tail"]));
    feed(adapter.settle());
    const before = JSON.stringify(transcript.messages);
    for (const rows of [[], ["⏺ first row"], ["⏺ first row", "  live tail"]]) {
      feed(read(adapter, rows));
      feed(adapter.settle());
      expect(JSON.stringify(transcript.messages)).toBe(before);
    }
  });
});
