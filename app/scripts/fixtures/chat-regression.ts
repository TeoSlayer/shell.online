import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/shell.css';
import '../../src/styles/chat.css';
import { ChatView } from '../../src/terminal/chat/chat-view';
import { ChatTerminal } from '../../src/terminal/chat/chat-terminal';
import { ChatHistory } from '../../src/terminal/chat/chat-history';
import { renderMarkdown, looksMarkdown } from '../../src/terminal/chat/markdown';
import { Transcript, plainLine } from '../../src/terminal/chat/transcript';

const host = document.querySelector<HTMLElement>('#fixture')!;
const result = document.querySelector<HTMLElement>('#result')!;
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const close = (actual: number, expected: number, message: string) => assert(Math.abs(actual - expected) < 2, `${message}: ${actual} vs ${expected}`);
let cleanup = () => {};

async function run() {
  cleanup();
  result.textContent = 'Running';
  const view = new ChatView(host, { onSubmit() {}, onKeys() {} });
  cleanup = () => view.dispose();
  const transcript = new Transcript();
  const render = () => view.render(transcript.messages, transcript.revision);
  for (let n = 0; n < 80; n++) transcript.output([plainLine(`Message ${n}: stable output`), plainLine('')], n);
  render();
  await tick();
  const scroller = host.querySelector<HTMLElement>('.chat-scroll')!;
  const bottom = () => scroller.scrollHeight - scroller.clientHeight;
  close(scroller.scrollTop, bottom(), 'Initially follows latest');
  const firstRow = host.querySelector('.chat-line');
  const before = [...host.querySelectorAll('.chat-msg')];
  render();
  assert(before.every((node, n) => node === host.querySelectorAll('.chat-msg')[n]), 'Idle render preserves message nodes');
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -8 }));
  const position = scroller.scrollTop;
  transcript.output([plainLine('Output during upward wheel')], 100);
  render();
  close(scroller.scrollTop, position, 'Wheel intent owns the scroll');
  assert(!host.querySelector<HTMLButtonElement>('.chat-jump')!.hidden, 'Jump control appears');
  assert(firstRow === host.querySelector('.chat-line'), 'New output preserves old rows');
  host.querySelector<HTMLButtonElement>('.chat-jump')!.click();
  await tick();
  close(scroller.scrollTop, bottom(), 'Jump resumes following');
  scroller.dispatchEvent(new TouchEvent('touchstart', { touches: [] }));
  const touched = scroller.scrollTop;
  transcript.output([plainLine('Output while a finger is down')], 101);
  render();
  close(scroller.scrollTop, touched, 'Touch intent owns the scroll');
  host.style.height = '420px';
  await tick();
  close(scroller.scrollTop, touched, 'Resize cannot reenable following');
  scroller.scrollTop = 350;
  scroller.dispatchEvent(new Event('scroll'));
  const anchor = [...host.querySelectorAll<HTMLElement>('.chat-msg')].find(node => node.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top)!;
  const offset = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const message = transcript.messages[0];
  message.lines.push(...Array.from({ length: 10 }, (_, n) => plainLine(`Added above ${n}`)));
  message.revision++;
  view.render(transcript.messages, transcript.revision + 1);
  close(anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top, offset, 'Reading anchor survives growth above it');
  view.dispose();
  const streamingView = new ChatView(host, { onSubmit() {}, onKeys() {} });
  cleanup = () => streamingView.dispose();
  const streaming = new Transcript();
  streaming.fromAgent({kind:'received', text:'', lines:[plainLine('Live')], open:true}, 1);
  streamingView.render(streaming.messages, streaming.revision);
  const row = host.querySelector('.chat-line')!;
  const textNode = row.firstChild;
  streaming.fromAgent({kind:'received', text:'', lines:[plainLine('Live text grows')], open:true}, 2);
  streamingView.render(streaming.messages, streaming.revision);
  assert(row === host.querySelector('.chat-line') && textNode === row.firstChild, 'Streaming preserves row and text node');
  streamingView.dispose();
  let terminal = new ChatTerminal({cols: 80, rows: 24});
  terminal.open(host);
  cleanup = () => terminal.dispose();
  const write = (bytes: string) => new Promise<void>(resolve => terminal.write(bytes, resolve));
  await write('one\r\ntwo\r\nthree\r\nprompt');
  await tick();
  await write('\x1b[H');
  await write('\x1b[4;7H');
  await tick();
  assert(host.querySelectorAll('.chat-line').length === 3, 'Cursor repaint does not duplicate normal output');
  terminal.dispose();
  terminal = new ChatTerminal({cols: 80, rows: 24});
  terminal.open(host);
  const frame = (answer: string) => '\x1b[2J\x1b[H' + ['❯ question', '', `⏺ ${answer}`, '', '────────────────────', '❯', '────────────────────'].join('\r\n');
  await write('\x1b]0;Claude Code\x07\x1b[?1049h' + frame('Partial'));
  await tick();
  await new Promise(resolve => setTimeout(resolve, 1600));
  await tick();
  for (const answer of ['Partial', 'Partial answer', 'Partial answer complete']) {
    await write(frame(answer));
    await tick();
    await new Promise(resolve => setTimeout(resolve, 1600));
    await tick();
    assert(host.querySelectorAll('.chat-received').length === 1, 'Alternate repaint preserves one answer');
    assert(host.querySelector('.chat-received .chat-body')?.textContent === answer, 'Alternate answer grows without stale text');
  }
  await write('\x1b[?1049l');
  await tick();
  assert(host.querySelectorAll('.chat-received').length === 1, 'Exiting alternate screen does not duplicate answer');

  /*
   * A table, in the same message as the prose around it.
   *
   * One `⏺` is one message, so an answer that says something and then draws a
   * table is one message holding both -- and a message holding any Markdown
   * at all is re-read as Markdown when it closes. The paragraph rule there
   * joins consecutive rows with a space, which is what undoes a terminal's
   * wrapping and what turned a table into
   * `┌───┬───┐ │ │ │ ├───┼───┤` on a single line. Rows that are drawn are
   * never joined to anything.
   */
  terminal.dispose();
  terminal = new ChatTerminal({cols: 80, rows: 24});
  terminal.open(host);
  const table = [
    '⏺ The three PRs from your last message:',
    '  ┌──────────┬───────────────┐',
    '  │ commit   │ what          │',
    '  ├──────────┼───────────────┤',
    '  │ ae1812c  │ chat history  │',
    '  │ 79a129c  │ wide grid     │',
    '  └──────────┴───────────────┘',
    '  Done.',
  ];
  await write('\x1b]0;Claude Code\x07\x1b[?1049h\x1b[2J\x1b[H' + ['❯ question', ''].concat(table, ['', '────────────────────', '❯', '────────────────────']).join('\r\n'));
  await tick();
  await new Promise(resolve => setTimeout(resolve, 900));
  await tick();
  await tick();
  const answer = host.querySelector('.chat-received .chat-body');
  assert(!!answer, 'The answer holding a table is in the thread');
  /*
   * Built, not printed. Kept as text a drawn table only looks like one in a
   * font whose box glyphs tile the cell exactly, which is why a terminal
   * draws them itself; a browser's `│` is shorter than its cell, so the
   * verticals never meet the horizontals.
   */
  const built = answer!.querySelector('table.md-table');
  assert(!!built, `A drawn table is built as a table (kids=${[...answer!.children].map(c => c.className || c.tagName).join('/')})`);
  const heads = [...built!.querySelectorAll('th')].map(cell => cell.textContent);
  assert(JSON.stringify(heads) === '["commit","what"]', `The heading row is the heading (got ${JSON.stringify(heads)})`);
  const cells = [...built!.querySelectorAll('tbody tr')].map(row => [...row.children].map(cell => cell.textContent));
  assert(JSON.stringify(cells) === '[["ae1812c","chat history"],["79a129c","wide grid"]]', `Every cell lands in its own column (got ${JSON.stringify(cells)})`);
  assert(!answer!.textContent!.includes('├'), 'The drawing itself is gone, not printed alongside');
  assert(answer!.textContent!.includes('Done.'), 'What was written around the table is still there');
  await write('\x1b[?1049l');
  await tick();

  /*
   * Leaving the chat renderer and coming back.
   *
   * The pane tears the renderer down and builds a new one, and the relay
   * replays the whole screen into it. Reported from a real session: after
   * doing that the thinking wheel went out and nothing new ever arrived
   * again, until a prompt was sent by hand.
   */
  terminal.dispose();
  const again = new ChatTerminal({ cols: 80, rows: 24 });
  again.open(host);
  cleanup = () => again.dispose();
  const write2 = (bytes: string) => new Promise<void>(resolve => again.write(bytes, resolve));
  const settle = async (ms = 500) => { await tick(); await new Promise(r => setTimeout(r, ms)); await tick(); };
  const screen = (...rows: string[]) => '\x1b[2J\x1b[H' + rows.join('\r\n');
  /* The snapshot a fresh connection is given, the way the pane delivers it. */
  again.reset();
  await write2('\x1b]0;✳ Claude Code\x07\x1b[?1049h' + screen('❯ first question', '', '⏺ first answer', '', '────────────────────', '❯', '────────────────────'));
  await settle(1600);
  assert(host.querySelectorAll('.chat-received').length === 1, `Re-entry draws the replayed answer (got ${host.querySelectorAll('.chat-received').length})`);
  /* And then the session carries on, exactly as it would have before. */
  await write2(screen('❯ first question', '', '⏺ first answer', '', '⏺ second answer', '', '────────────────────', '❯', '────────────────────'));
  await settle(1600);
  const answers = [...host.querySelectorAll('.chat-received .chat-body')].map(node => node.textContent);
  assert(answers.length === 2, `New output arrives after re-entry (got ${JSON.stringify(answers)})`);
  assert(answers[1] === 'second answer', `The new answer is the new one (got ${JSON.stringify(answers)})`);
  /* And the wheel stops, because the screen did. */
  assert(host.querySelector<HTMLElement>('.chat-thinking')?.hidden !== false, 'A settled screen is not still thinking');

  /*
   * The last frame of a turn still has the spinner on it.
   *
   * A spinner animates, so a screen that has not been repainted for over a
   * second is a screen whose spinner has stopped -- but `working` is only
   * recomputed when a frame arrives, so the last frame's spinner left it
   * true for ever and the commit never ran. Reported as output that only
   * appears after refreshing the page, sometimes.
   */
  again.reset();
  await write2('\x1b]0;✳ Claude Code\x07\x1b[?1049h' + screen('❯ ask', '', '⏺ the answer', '', '────────────────────', '❯', '────────────────────'));
  await settle(1600);
  /*
   * Two new things at once, so the 400ms preview has nothing to offer: it
   * only previews a lone open paragraph, and two utterances are not one.
   * Without a commit this is a turn that never appears at all.
   */
  await write2(screen('❯ ask', '', '⏺ the answer', '', '⏺ a tool ran', '  ⎿  it did', '', '⏺ the last thing said', '✳ Working…', '────────────────────', '❯', '────────────────────'));
  await settle(1800);
  const ended = [...host.querySelectorAll('.chat-received .chat-body')].map(node => node.textContent);
  assert(ended.some(text => (text ?? '').includes('the last thing said')),
    `A turn whose last frame still showed a spinner is shown (got ${JSON.stringify(ended)})`);
  /*
   * And the wheel goes out. `working` is only recomputed when a frame
   * arrives, so the spinner the last frame caught would otherwise keep it
   * turning over a session that has finished.
   */
  assert(host.querySelector<HTMLElement>('.chat-thinking')?.hidden !== false,
    'A screen at rest stops thinking even if its last frame held a spinner');


  again.dispose();
  const formatView = new ChatView(host, { onSubmit() {}, onKeys() {} });
  cleanup = () => formatView.dispose();
  const formatted = new Transcript();
  const raw = ['# Python source', 'if __name__ == "__main__":', '    print("**literal**")'];
  formatted.fromAgent({ kind: 'received', text: '', lines: raw.map(plainLine), preformatted: true, open: false }, 1);
  formatView.render(formatted.messages, formatted.revision);
  assert([...host.querySelectorAll('.chat-line')].map(n => n.textContent).join('\n') === raw.join('\n'), 'Raw code retains exact rows and identifiers');
  assert(!host.querySelector('.md-strong'), 'Raw code is never parsed as emphasis');
  const fenced = ['```python', ...raw, '', '', '    print(42)', '```'];
  formatted.fromAgent({ kind: 'received', text: '', lines: fenced.map(plainLine), preformatted: true, open: false }, 2);
  formatView.render(formatted.messages, formatted.revision);
  assert(host.querySelector('.md-pre code')?.textContent === fenced.slice(1, -1).join('\n'), 'Fenced code retains all whitespace and identifiers');
  assert(!!host.querySelector('.md-number'), 'Fenced code receives syntax colour');
  const rich = formatted.fromAgent({ kind: 'received', text: '', lines: [plainLine('## Heading'), plainLine('**Strong** and `code`')], open: false }, 3)!;
  formatView.render(formatted.messages, formatted.revision);
  const headingNode = host.querySelector('.md-heading');
  assert(headingNode?.textContent === 'Heading', 'Markdown heading is rendered');
  rich.revision++;
  formatView.render(formatted.messages, formatted.revision + 1);
  assert(host.querySelector('.md-heading') === headingNode, 'A metadata revision preserves rich content and its nodes');
  rich.lines = [plainLine('## Changed heading')];
  rich.revision++;
  formatView.render(formatted.messages, formatted.revision + 2);
  assert(host.querySelector('.md-heading')?.textContent === 'Changed heading', 'Changed rich text is updated');
  const markdownHost = document.createElement('div');
  renderMarkdown(markdownHost, '## Pipe output\n| not a table |\nfollowing text');
  assert(markdownHost.textContent?.includes('following text'), 'A non-table pipe row cannot wedge the renderer');
  const pipeTable = '| Name | Value |\n| --- | --- |\n| a | 1 |';
  assert(looksMarkdown(pipeTable), 'A standalone Markdown table is detected');
  renderMarkdown(markdownHost, pipeTable);
  assert(markdownHost.querySelectorAll('th').length === 2 && markdownHost.querySelectorAll('td').length === 2, 'A standalone pipe table renders');
  renderMarkdown(markdownHost, '~~~python\n__name__ = 1\n~~~');
  assert(markdownHost.querySelector('.md-pre code')?.textContent === '__name__ = 1', 'Tilde fences retain identifiers');
  assert(looksMarkdown('~~~python\n__name__ = 1\n~~~'), 'Tilde fences are detected');
  const paddedTable = ['Name | Value', '--- | ---:', '`left|right`    |   2', 'escaped \\| pipe | 3'];
  formatted.fromAgent({kind: 'received', text: '', lines: paddedTable.map(plainLine), preformatted: true, open: false}, 4);
  formatView.render(formatted.messages, formatted.revision);
  const aligned = [...host.querySelectorAll('table.md-table')].at(-1)!;
  assert(aligned?.querySelectorAll('th').length === 2 && aligned.querySelectorAll('td').length === 4, 'Padded and borderless Markdown tables retain their columns');
  assert(aligned.querySelector('td')?.textContent === 'left|right', 'Pipes inside inline code stay in one table cell');
  assert((aligned.querySelectorAll('td')[1] as HTMLElement).style.textAlign === 'right', 'Table alignment is retained');
  formatView.dispose();

  const normal = new ChatTerminal({cols: 100, rows: 30});
  normal.open(host);
  cleanup = () => normal.dispose();
  const normalWrite = (data: string) => new Promise<void>(resolve => normal.write(data, resolve));
  for (const line of fenced) await normalWrite(line + '\r\n');
  await settle(1000);
  assert(host.querySelector('.md-pre code')?.textContent === fenced.slice(1, -1).join('\n'), 'Normal terminal output keeps fenced code across separate transport chunks');
  await normalWrite('\r\n' + paddedTable.join('\r\n') + '\r\n');
  await settle(1000);
  assert(host.querySelectorAll('table.md-table td').length === 4, 'Normal terminal table rows remain one table');
  normal.dispose();

  const growing = new ChatTerminal({cols: 80, rows: 24});
  growing.open(host);
  cleanup = () => growing.dispose();
  growing.reset();
  const growWrite = (data: string) => new Promise<void>(resolve => growing.write(data, resolve));
  await growWrite('\x1b]0;Claude Code\x07\x1b[?1049h' + screen('❯ question', '', '⏺ Partial', '✳ Working…', '────────────────────', '❯', '────────────────────'));
  await tick();
  await growWrite(screen('❯ question', '', '⏺ Partial answer completed', '', '────────────────────', '❯', '────────────────────'));
  await settle(1600);
  assert(host.querySelectorAll('.chat-received').length === 1 && host.querySelector('.chat-received .chat-body')?.textContent === 'Partial answer completed', 'A snapshot taken mid-answer continues in place');
  growing.dispose();

  // Exercise actual IndexedDB, encryption, cache-load races, and screen replay.
  const session = `chat-regression-${crypto.randomUUID()}`;
  const cache = new ChatHistory(session, 'fixture-secret');
  const remembered = new Transcript();
  remembered.output([plainLine('older output outside the screen'), plainLine('')], 10);
  remembered.submitted('cached question', 20);
  remembered.fromAgent({kind: 'received', text: '', lines: [plainLine('cached answer')], open: false}, 30);
  cache.save(remembered.messages);
  await cache.flush();
  assert((await cache.load())?.length === 3, 'Encrypted history is written and read');
  const other = new ChatHistory(session + '-other', 'fixture-secret');
  assert(await other.load() === null, 'Sessions cannot read each other’s history');
  other.dispose();
  const wrongKey = new ChatHistory(session, 'different-secret');
  assert(await wrongKey.load() === null, 'A different key cannot read cached messages');
  wrongKey.dispose();
  const originalLoad = ChatHistory.prototype.load;
  ChatHistory.prototype.load = async function () {
    await new Promise(resolve => setTimeout(resolve, 200));
    return originalLoad.call(this);
  };
  const cached = new ChatTerminal({cols: 80, rows: 24});
  cleanup = () => { ChatHistory.prototype.load = originalLoad; cached.dispose(); cache.dispose(); };
  cached.rememberAs(session, 'fixture-secret');
  cached.open(host);
  cached.reset();
  const snapshot = '\x1b]0;Claude Code\x07\x1b[?1049h' + screen('❯ cached question', '', '⏺ cached answer', '', '────────────────────', '❯', '────────────────────');
  const cachedWrite = (data: string) => new Promise<void>(resolve => cached.write(data, resolve));
  await cachedWrite(snapshot);
  ChatHistory.prototype.load = originalLoad;
  await tick();
  const bodies = () => [...host.querySelectorAll('.chat-received .chat-body')].map(n => n.textContent);
  assert(JSON.stringify(bodies()) === JSON.stringify(['older output outside the screen', 'cached answer']), `First render retains history with no replay duplicate: ${JSON.stringify(bodies())}`);
  await settle(1600);
  assert(bodies().length === 2, 'Settling cannot reintroduce a replay duplicate');
  const info = host.querySelector<HTMLElement>('[data-tone="info"] .chat-chip');
  const blue = document.createElement('span');
  blue.style.color = 'var(--blue-deep)';
  blue.style.backgroundColor = 'var(--blue-wash)';
  host.append(blue);
  assert(!!info && getComputedStyle(info).color === getComputedStyle(blue).color && getComputedStyle(info).backgroundColor === getComputedStyle(blue).backgroundColor, 'The Reading notice uses the blue information colours');
  blue.remove();
  await cachedWrite(screen('❯ cached question', '', '⏺ cached answer', '', '⏺ new live answer', '', '────────────────────', '❯', '────────────────────'));
  await settle(1600);
  assert(bodies().filter(t => t === 'new live answer').length === 1, 'Live output arrives once after cache restore');
  cached.reset();
  await cachedWrite('\x1b]0;Claude Code\x07\x1b[?1049h' + screen('⏺ new live answer', '', '────────────────────', '❯', '────────────────────'));
  await tick();
  assert(JSON.stringify(bodies()) === JSON.stringify(['older output outside the screen', 'cached answer', 'new live answer']), 'Reconnect keeps both cached and newly received history');
  cached.dispose();
  // A fresh renderer is the refresh/re-entry lifecycle used by the session pane.
  const refreshed = new ChatTerminal({cols: 80, rows: 24});
  cleanup = () => { refreshed.dispose(); cache.dispose(); };
  refreshed.rememberAs(session, 'fixture-secret');
  refreshed.open(host);
  refreshed.reset();
  await new Promise<void>(resolve => refreshed.write(snapshot, resolve));
  await tick();
  assert(bodies().length === 3, `Refresh restores all closed history without duplicating the snapshot: ${JSON.stringify(bodies())}`);
  assert(!host.textContent?.includes('Nothing from this session'), 'A populated cache has no empty-cache notice');

  result.textContent = 'PASS: identity, streaming, wheel, touch, resize, zoom anchor, cursor repaint, idle repaint, alternate exit, drawn table, re-entry, spinner at rest, code fidelity, Markdown, cache race, refresh, replay';
}

document.querySelector<HTMLButtonElement>('#run')!.onclick = () => {
  run().catch(error => { result.textContent = `FAIL: ${error.message}`; });
};
