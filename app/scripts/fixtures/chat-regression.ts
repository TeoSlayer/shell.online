import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/shell.css';
import '../../src/styles/chat.css';
import { ChatView } from '../../src/terminal/chat/chat-view';
import { ChatTerminal } from '../../src/terminal/chat/chat-terminal';
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
  const terminal = new ChatTerminal({cols: 80, rows: 24});
  terminal.open(host);
  cleanup = () => terminal.dispose();
  const write = (bytes: string) => new Promise<void>(resolve => terminal.write(bytes, resolve));
  await write('one\r\ntwo\r\nthree\r\nprompt');
  await tick();
  await write('\x1b[H');
  await write('\x1b[4;7H');
  await tick();
  assert(host.querySelectorAll('.chat-line').length === 3, 'Cursor repaint does not duplicate normal output');
  terminal.reset();
  const frame = (answer: string) => '\x1b[2J\x1b[H' + ['❯ question', '', `⏺ ${answer}`, '', '────────────────────', '❯', '────────────────────'].join('\r\n');
  await write('\x1b]0;Claude Code\x07\x1b[?1049h' + frame('Partial'));
  await tick();
  await new Promise(resolve => setTimeout(resolve, 450));
  await tick();
  for (const answer of ['Partial', 'Partial answer', 'Partial answer complete']) {
    await write(frame(answer));
    await tick();
    await new Promise(resolve => setTimeout(resolve, 450));
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
  terminal.reset();
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

  result.textContent = 'PASS: identity, streaming, wheel, touch, resize, zoom anchor, cursor repaint, idle repaint, alternate exit, drawn table';
}

document.querySelector<HTMLButtonElement>('#run')!.onclick = () => {
  run().catch(error => { result.textContent = `FAIL: ${error.message}`; });
};
