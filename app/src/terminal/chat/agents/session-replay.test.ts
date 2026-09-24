import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import pkg from "@xterm/headless";
import { ClaudeCodeAdapter } from "./claude-code";
import { adapterFor } from "./index";
import { plainLine } from "../transcript";

/*
 * A session that actually happened, replayed a chunk at a time.
 *
 * Every other test in here reads a frame: one screen, handed to the adapter
 * whole. A real session is not a frame, it is thousands of repaints of one,
 * and the two bugs that made this renderer unusable both lived in the space
 * between them -- a status glyph nobody had seen, and a tip box that appears
 * under the conversation and then goes away again, each of which broke the
 * match between one repaint and the next and handed the entire screen over as
 * though none of it had been read. Downstream that is every message in the
 * session arriving again, and again, for as long as the agent is thinking.
 *
 * No frame test can see that, because it takes two frames to have a
 * relationship. This one drives the bytes of a three-exchange session through
 * a real emulator, exactly as the renderer does, and asks what came out.
 *
 * Captured with a pty at 80x40; see the capture note in fixtures/claude-code.ts.
 */
const { Terminal } = pkg as unknown as { Terminal: new (options: unknown) => any };

async function replay(): Promise<string[]> {
  const bytes = readFileSync(new URL("./fixtures/claude-session.bin", import.meta.url));
  const term = new Terminal({ cols: 80, rows: 40, allowProposedApi: true, scrollback: 1000 });
  const adapter = new ClaudeCodeAdapter();
  const said: string[] = [];
  let recognised = false;
  for (let at = 0; at < bytes.length; at += 256) {
    await new Promise<void>((written) => term.write(bytes.subarray(at, at + 256), () => written()));
    const buffer = term.buffer.active;
    if (buffer.type !== "alternate") continue;
    const lines: string[] = [];
    for (let row = 0; row < term.rows; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(false) ?? "");
    }
    if (!recognised) {
      recognised = Boolean(adapterFor(lines, "✳ Claude Code"));
      if (!recognised) continue;
    }
    for (const utterance of adapter.read(lines.map(plainLine))) {
      /* An open paragraph is offered again as it grows; only closed ones count. */
      if (utterance.open) continue;
      said.push(`${utterance.kind}:${utterance.text || utterance.lines.map((l) => l.text).join("\n")}`);
    }
  }
  for (const utterance of adapter.flush()) {
    said.push(`${utterance.kind}:${utterance.text || utterance.lines.map((l) => l.text).join("\n")}`);
  }
  return said;
}

describe("a session that actually happened", () => {
  it("says each of the three prompts exactly once", async () => {
    const sent = (await replay()).filter((line) => line.startsWith("sent:"));
    expect(sent).toEqual([
      "sent:say exactly: one",
      "sent:say exactly: two",
      "sent:list three short bullet points about terminals",
    ]);
  });

  it("answers each of them exactly once", async () => {
    const answers = (await replay()).filter((line) => line.startsWith("received:"));
    expect(answers.length).toBe(3);
    expect(answers[0]).toContain("one");
    expect(answers[1]).toContain("two");
    expect(answers[2]).toContain("terminal");
  });

  it("never says the same thing twice", async () => {
    const said = await replay();
    expect(said.length).toBe(new Set(said).size);
  });

  /* The logo, the version, the login warning: drawn once, said never. */
  it("says nothing the program drew about itself", async () => {
    const said = (await replay()).join("\n");
    for (const noise of ["Claude Code v", "Opus 5.5", "login expires", "Jitterbugging", "Ebbing", "Cooked for", "Tip:"]) {
      expect(said).not.toContain(noise);
    }
  });
});
