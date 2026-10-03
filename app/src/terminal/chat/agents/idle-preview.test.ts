import { expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude-code";
import { Transcript, plainLine } from "../transcript";

const read = (adapter: ClaudeCodeAdapter, frame: readonly string[]) => adapter.read(frame.map(plainLine));

it('keeps a resumed answer whole after the idle preview is closed for display and caching', () => {
  const adapter = new ClaudeCodeAdapter();
  const transcript = new Transcript();
  for (const answer of ['Partial', 'Partial answer completed']) {
    for (const utterance of [...read(adapter, ['❯ ask', '', `⏺ ${answer}`]), ...adapter.settle()]) transcript.fromAgent(utterance, 1);
    expect(transcript.messages.at(-1)?.open).toBe(true);
    transcript.closeAgentPreview(2);
    expect(transcript.messages.at(-1)?.open).toBe(false);
    for (const utterance of adapter.settle()) transcript.fromAgent(utterance, 2);
    expect(transcript.messages.at(-1)?.open).toBe(false);
  }
  expect(transcript.messages.filter(m => m.kind === 'received').map(m => m.lines.map(l => l.text).join('\n'))).toEqual(['Partial answer completed']);
  for (const utterance of [...read(adapter, ['❯ ask', '', '⏺ Partial answer completed', '', '⏺ Next paragraph']), ...adapter.settle()]) transcript.fromAgent(utterance, 3);
  expect(transcript.messages.filter(m => m.kind === 'received').map(m => m.lines.map(l => l.text).join('\n'))).toEqual(['Partial answer completed', 'Next paragraph']);
});
