import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { capture } from "../../adaptive/fixtures/captures";
import { ScreenReader, type ReaderTerminal } from "../screen-reader";
import { Transcript } from "../transcript";
import { ClaudeCodeAdapter } from "./claude-code";

// Actual Claude v2.1.280 PTY bytes. Splitting transport must not turn an
// unfinished cursor row into a finished prompt, or a clock into new content.
async function replay(paintEvery = 1, chunkSize = 137) {
  const terminal = new Terminal({cols: 120, rows: 36, allowProposedApi: true});
  const reader = new ScreenReader(), adapter = new ClaudeCodeAdapter(), transcript = new Transcript();
  const bytes = capture("claude");
  try {
    for (let at = 0; at < bytes.length; at += chunkSize) {
      await new Promise<void>(resolve => terminal.write(bytes.slice(at, at + chunkSize), resolve));
      if ((at / chunkSize) % paintEvery !== 0 && at + chunkSize < bytes.length) continue;
      if (terminal.buffer.active.type !== "alternate") continue;
      const frame = reader.snapshot(terminal as unknown as ReaderTerminal);
      for (const utterance of adapter.read(frame, terminal.buffer.active.cursorY)) transcript.fromAgent(utterance, at);
    }
    for (const utterance of adapter.flush()) transcript.fromAgent(utterance, bytes.length);
    return transcript.messages;
  } finally { terminal.dispose(); reader.dispose(); }
}

describe("actual PTY bytes split across transport chunks", () => {
  it.each([31, 137, 509].flatMap(chunkSize => [1, 2, 3, 5, 8].map(paintEvery => ({chunkSize, paintEvery}))))(
    "keeps the prompt and answer with $chunkSize byte chunks, painting every $paintEvery chunks", async ({chunkSize, paintEvery}) => {
    const messages = await replay(paintEvery, chunkSize);
    expect(messages.filter(message => message.kind === "sent").map(message => message.text)).toEqual([
      "list the files in this directory, then explain in two sentences what a pseudo-terminal is",
    ]);
    const output = messages.flatMap(message => message.lines.map(line => line.text)).join("\n");
    expect(output.match(/Listing 1 directory/gu)).toHaveLength(1);
    expect(output.match(/Listing files in current directory/gu)).toHaveLength(1);
    expect(output).toContain("A pseudo-terminal (PTY)");
    expect(output).toContain("when no physical terminal is attached.");
  });

  it("does not append the tool heading again when its elapsed time gains an ellipsis", async () => {
    const messages = await replay();
    const output = messages.flatMap(message => message.lines.map(line => line.text)).join("\n");
    expect(output.match(/Listing 1 directory/gu)).toHaveLength(1);
    expect(output).not.toMatch(/·\s*\d+s…/u);
    expect(output).toContain("A pseudo-terminal (PTY)");
  });
});
