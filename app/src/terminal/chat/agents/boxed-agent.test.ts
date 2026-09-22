import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code";
import { dedent, strip, unwrap } from "./boxed-agent";
import { KNOWN_AGENTS } from "./known";
import { adapterFor } from "./index";
import { plainLine } from "../transcript";

/*
 * A frame of Claude Code's interface, as it is drawn: a header box, the
 * conversation, and the box you type into. Held here as the fixture every
 * expectation below reads from, because the whole adapter is a claim about
 * this shape and the claim should be visible.
 */
const FRAME = [
  "╭──────────────────────────────────────────────────────────────╮",
  "│ Claude Code v2.1.4                          ~/work/api       │",
  "╰──────────────────────────────────────────────────────────────╯",
  "",
  "> refactor the session store to use a connection pool",
  "",
  "  I will start by reading the current store implementation, then",
  "  introduce a pool and thread it through the call sites.",
  "",
  "  ⏺ Read(app/server/lib/sessions.ts)",
  "    Read 412 lines",
  "",
  "  ⏺ Edit(app/server/lib/sessions.ts)",
  "    Updated 3 hunks",
  "",
  "  The store now acquires from the pool and releases in a finally",
  "  block, so a thrown query cannot leak a connection.",
  "",
  "  ✻ Thinking… (4s · 1.2k tokens · esc to interrupt)",
  "",
  "╭─ write a message ────────────────────────────────────────────╮",
  "│ > and cap it at ten                                          │",
  "╰──────────────────────────────────────────────────────────────╯",
];

const read = (adapter: ClaudeCodeAdapter, frame: readonly string[]) =>
  adapter.read(frame.map(plainLine));

const shape = (utterances: ReturnType<ClaudeCodeAdapter["read"]>) =>
  utterances.map((u) => `${u.kind}:${u.text || u.lines.map((l) => l.text).join(" / ")}`);

describe("recognising the program", () => {
  it("knows its own interface by the name it draws", () => {
    expect(new ClaudeCodeAdapter().matches(FRAME)).toBe(true);
  });

  /*
   * The markers are shared: several agents draw a filled circle for a tool
   * call and a `>` for a prompt. Reading one agent's screen with another's
   * rules is worse than not reading it, so the gate is the name.
   */
  it("does not claim a screen that merely looks similar", () => {
    expect(
      new ClaudeCodeAdapter().matches(["╭───╮", "│ Some Other Agent │", "> hello", "⏺ Read(x)"]),
    ).toBe(false);
  });
});

describe("taking the interface off", () => {
  it("drops the boxes and keeps what was said", () => {
    expect(strip(FRAME)).toEqual([
      "",
      "> refactor the session store to use a connection pool",
      "",
      "  I will start by reading the current store implementation, then",
      "  introduce a pool and thread it through the call sites.",
      "",
      "  ⏺ Read(app/server/lib/sessions.ts)",
      "    Read 412 lines",
      "",
      "  ⏺ Edit(app/server/lib/sessions.ts)",
      "    Updated 3 hunks",
      "",
      "  The store now acquires from the pool and releases in a finally",
      "  block, so a thrown query cannot leak a connection.",
      "",
      "  ✻ Thinking… (4s · 1.2k tokens · esc to interrupt)",
      "",
    ]);
  });

  /*
   * What is inside the last box is a line being typed, not a message. Given
   * out, every keystroke would arrive in the thread.
   */
  it("never gives out what is still being typed", () => {
    expect(strip(FRAME).join("\n")).not.toContain("and cap it at ten");
  });
});

describe("the interface's own indent", () => {
  it("comes off the paragraph", () => {
    expect(dedent(["  one", "  two"])).toEqual(["one", "two"]);
  });

  it("leaves the indent the writer meant", () => {
    expect(dedent(["  Here:", "      const pool = create();", "  and that is all"])).toEqual([
      "Here:",
      "    const pool = create();",
      "and that is all",
    ]);
  });

  it("leaves a paragraph that has none alone", () => {
    expect(dedent(["one", "  two"])).toEqual(["one", "  two"]);
  });
});

describe("putting a paragraph back together", () => {
  /*
   * The terminal broke it at eighty columns. Those breaks are the grid's and
   * not the writer's, and kept they are the difference between text that
   * reflows to a phone and text with a ragged edge across the middle of it.
   */
  it("joins the rows a terminal wrapped", () => {
    expect(
      unwrap([
        "The store now acquires from the pool and releases in a finally",
        "block, so a thrown query cannot leak a connection.",
      ]),
    ).toEqual(["The store now acquires from the pool and releases in a finally block, so a thrown query cannot leak a connection."]);
  });

  it("keeps a break the writer meant", () => {
    /* The first row stopped well short of the edge, so it stopped on purpose. */
    expect(
      unwrap([
        "Done.",
        "The pool is capped at ten and released on every path it can take out.",
      ]),
    ).toEqual(["Done.", "The pool is capped at ten and released on every path it can take out."]);
  });

  it("keeps a list a list, however full the row above it was", () => {
    expect(
      unwrap([
        "There are two things left to do before this can be merged, and they",
        "- cap the pool",
        "- release on every path",
      ]),
    ).toEqual([
      "There are two things left to do before this can be merged, and they",
      "- cap the pool",
      "- release on every path",
    ]);
  });

  it("leaves a paragraph too narrow to judge alone", () => {
    expect(unwrap(["one", "two"])).toEqual(["one", "two"]);
  });
});

describe("reading a screen as a conversation", () => {
  it("gives the prompt, the prose and the tools as separate messages", () => {
    expect(shape(read(new ClaudeCodeAdapter(), FRAME))).toEqual([
      "sent:refactor the session store to use a connection pool",
      "received:I will start by reading the current store implementation, then introduce a pool and thread it through the call sites.",
      "tool:Read(app/server/lib/sessions.ts)",
      "tool:Edit(app/server/lib/sessions.ts)",
      "received:The store now acquires from the pool and releases in a finally block, so a thrown query cannot leak a connection.",
    ]);
  });

  it("keeps a tool's result with the tool rather than as a message of its own", () => {
    const tools = read(new ClaudeCodeAdapter(), FRAME).filter((u) => u.kind === "tool");
    expect(tools.map((t) => t.lines.map((l) => l.text))).toEqual([["Read 412 lines"], ["Updated 3 hunks"]]);
  });

  /*
   * A spinner is the program saying it is still going. It changes on every
   * frame, so shown it would be a message per frame.
   */
  it("says nothing for a spinner", () => {
    expect(shape(read(new ClaudeCodeAdapter(), FRAME)).join("\n")).not.toContain("Thinking");
  });

  it("says nothing at all for a frame that changed nothing", () => {
    const adapter = new ClaudeCodeAdapter();
    read(adapter, FRAME);
    expect(read(adapter, FRAME)).toEqual([]);
  });

  it("gives out only what the next frame added", () => {
    const adapter = new ClaudeCodeAdapter();
    read(adapter, FRAME);
    const next = [
      ...FRAME.slice(0, 19),
      "  Done. The pool is capped at ten.",
      "",
      "╭─ write a message ────────────────────────────────────────────╮",
      "│ >                                                            │",
      "╰──────────────────────────────────────────────────────────────╯",
    ];
    /*
     * The row an agent stops on looks exactly like a row it is still writing.
     * The difference is whether another frame follows, so it is held back
     * until the screen goes quiet and the caller says so.
     */
    expect(shape(read(adapter, next))).toEqual([]);
    expect(shape(adapter.flush())).toEqual(["received:Done. The pool is capped at ten."]);
  });

  it("gives out the line an agent finished on once the screen goes quiet", () => {
    const adapter = new ClaudeCodeAdapter();
    read(adapter, FRAME);
    /* Nothing further is painted; without a flush the last line never arrives. */
    expect(shape(adapter.flush())).toEqual([]);
  });

  it("does not repeat itself when the conversation scrolls off the top", () => {
    const adapter = new ClaudeCodeAdapter();
    read(adapter, FRAME);
    /* The header has scrolled away and the prompt is gone with it. */
    const scrolled = [
      "  The store now acquires from the pool and releases in a finally",
      "  block, so a thrown query cannot leak a connection.",
      "",
      "  ⏺ Bash(npm test -w app)",
      "    Test Files  111 passed (111)",
      "",
      "╭─ write a message ────────────────────────────────────────────╮",
      "│ >                                                            │",
      "╰──────────────────────────────────────────────────────────────╯",
    ];
    expect(shape(read(adapter, scrolled))).toEqual(["tool:Bash(npm test -w app)"]);
  });

  it("keeps a block whose spacing is carrying meaning as it was written", () => {
    const adapter = new ClaudeCodeAdapter();
    const frame = [
      "│ Claude Code v2.1.4 │",
      "",
      "  NAME      READY   STATUS",
      "  api       1/1     Running",
      "  worker    1/1     Running",
      "",
      "╭─ write a message ─╮",
      "│ >                 │",
      "╰───────────────────╯",
    ];
    const [message] = read(adapter, frame).filter((u) => u.kind === "received");
    expect(message.preformatted).toBe(true);
  });

  it("forgets the screen when the program exits", () => {
    const adapter = new ClaudeCodeAdapter();
    read(adapter, FRAME);
    adapter.reset();
    expect(read(adapter, FRAME)).toHaveLength(5);
  });
});

describe("telling one agent's screen from another's", () => {
  /*
   * The shape is shared -- a header box, `>` prompts, bullet tool calls --
   * so the shape cannot tell them apart and is never asked to. Each adapter
   * is gated on its own program's name, which is the one exact thing on the
   * screen.
   */
  it("gives a screen to the program whose name is on it", () => {
    expect(adapterFor(FRAME)?.id).toBe("claude-code");
    expect(adapterFor(["╭───╮", "│ OpenClaw v3.1 │", "> hello"])?.id).toBe("openclaw");
    expect(adapterFor(["│ Codex CLI │", "> hello"])?.id).toBe("codex");
    expect(adapterFor(["│ Hermes Agent │", "> hello"])?.id).toBe("hermes");
  });

  it("claims nothing when no name is on the screen", () => {
    expect(adapterFor(["╭───╮", "│ 1 const x = 1; │", "╰───╯"])).toBeNull();
    /* vim's status line, which has a filename and a mode and no program name. */
    expect(adapterFor(["  1 export function x() {}", " NORMAL  keyboard-inset.ts   6,1  All"])).toBeNull();
  });

  /*
   * `codex` is an ordinary word and turns up in paths and prose. The header
   * is the only place a name is read from, so it has to look like a program
   * announcing itself rather than like a directory.
   */
  it("does not take a word in a path for a program", () => {
    expect(adapterFor(["│ Claude Code v2.1.4    ~/work/codex-experiments │"])?.id).toBe("claude-code");
    expect(adapterFor(["  reading ~/src/codex/notes.md"])).toBeNull();
  });

  it("says which adapters were written against a real frame", () => {
    const confident = KNOWN_AGENTS.map((make) => make()).filter((a) => a.confident).map((a) => a.id);
    expect(confident).toEqual(["claude-code"]);
  });
});
