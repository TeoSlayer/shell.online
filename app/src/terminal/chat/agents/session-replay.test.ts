import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code";
import { adapterFor } from "./index";
import { CLAUDE_SESSION } from "./fixtures/claude-session";
import { plainLine } from "../transcript";

/*
 * A session that actually happened, replayed repaint by repaint.
 *
 * Every other test in this file reads a frame: one screen, handed to the
 * adapter whole. A real session is not a frame, it is one screen painted over
 * and over, and the two faults that made this renderer unusable both lived in
 * the space between two of them -- a spinner glyph nobody had seen, and a tip
 * box that appears under the conversation and then goes away, each of which
 * broke the match between one repaint and the next so that the entire screen
 * was handed over as though none of it had been read. Downstream that is
 * every message in the session arriving again, and again, for as long as the
 * agent is thinking.
 *
 * It took 71 utterances to say three things before this ran.
 */
function replay(): string[] {
  const adapter = new ClaudeCodeAdapter();
  const said: string[] = [];
  let recognised = false;
  for (const frame of CLAUDE_SESSION) {
    if (!recognised) {
      recognised = Boolean(adapterFor(frame, "✳ Claude Code"));
      if (!recognised) continue;
    }
    for (const utterance of adapter.read(frame.map(plainLine))) {
      /* An open paragraph is offered again as it grows; only finished ones count. */
      if (utterance.open) continue;
      said.push(`${utterance.kind}:${utterance.text || utterance.lines.map((line) => line.text).join("\n")}`);
    }
  }
  for (const utterance of adapter.flush()) {
    said.push(`${utterance.kind}:${utterance.text || utterance.lines.map((line) => line.text).join("\n")}`);
  }
  return said;
}

describe("a session that actually happened", () => {
  it("says each of the three prompts exactly once", () => {
    expect(replay().filter((line) => line.startsWith("sent:"))).toEqual([
      "sent:say exactly: one",
      "sent:say exactly: two",
      "sent:list three short bullet points about terminals",
    ]);
  });

  it("answers each of them exactly once", () => {
    const answers = replay().filter((line) => line.startsWith("received:"));
    expect(answers.length).toBe(3);
    expect(answers[0]).toContain("one");
    expect(answers[1]).toContain("two");
    expect(answers[2]).toContain("terminal");
  });

  it("never says the same thing twice", () => {
    const said = replay();
    expect(said.length).toBe(new Set(said).size);
  });

  /* The logo, the version, the login warning, the spinner: drawn, never said. */
  it("says nothing the program drew about itself", () => {
    const said = replay().join("\n");
    for (const noise of [
      "Claude Code v",
      "Opus 5.5",
      "login expires",
      "Jitterbugging",
      "Ebbing",
      "Cooked for",
      "Tip:",
    ]) {
      expect(said).not.toContain(noise);
    }
  });

  /* And an answer is one message, however many paragraphs it runs to. */
  it("keeps an answer whole", () => {
    const answers = replay().filter((line) => line.startsWith("received:"));
    expect(answers[2].split("\n").length).toBeGreaterThan(1);
  });
});
