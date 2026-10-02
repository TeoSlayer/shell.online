// The same assertions run against main and the fix checkout. Keep imports on
// public APIs present in both versions, so failures describe behavior, not APIs.
import '../../src/styles/tokens.css';
import '../../src/styles/base.css';
import '../../src/styles/chat.css';
import { ChatView } from '../../src/terminal/chat/chat-view';
import { ChatTerminal } from '../../src/terminal/chat/chat-terminal';
import { ChatHistory } from '../../src/terminal/chat/chat-history';
import { Transcript, plainLine } from '../../src/terminal/chat/transcript';
import { renderMarkdown } from '../../src/terminal/chat/markdown';
import { capture } from '../../src/terminal/adaptive/fixtures/captures';
import { CLAUDE_SESSION } from '../../src/terminal/chat/agents/fixtures/claude-session';

const host = document.querySelector<HTMLElement>('#fixture')!;
const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const bodies = () => [...host.querySelectorAll('.chat-received .chat-body')].map(node => node.textContent);
const makeView = () => new ChatView(host, { onSubmit() {}, onKeys() {} });
const output = (text: string, preformatted = false) => {
  const transcript = new Transcript();
  transcript.fromAgent({kind: 'received', text: '', lines: text.split('\n').map(plainLine), preformatted, open: false}, 1);
  return transcript;
};
const write = (terminal: ChatTerminal, bytes: string | Uint8Array) => new Promise<void>(resolve => terminal.write(bytes, resolve));
const screen = (rows: readonly string[]) => '\x1b[2J\x1b[H' + rows.join('\r\n');

const cases: Record<string, () => Promise<unknown>> = {
  async review_preview() {
    const transcript = new Transcript(), view = makeView();
    const at = new Date('2026-10-02T12:00:00Z').getTime();
    transcript.noticed('Reading Claude Code as messages.', at);
    transcript.submitted('Show a Python example and the renderer checks.', at);
    for (const source of [
      '## Renderer checks\nCode and tables retain their formatting.',
      '```python\nif __name__ == "__main__":\n    print("**literal**")\n\n    print("ready")\n```',
      '| Check | Result |\n| --- | --- |\n| History and replay | Passed |\n| Desktop and mobile layout | Passed |',
    ]) transcript.fromAgent({kind: 'received', text: '', lines: source.split('\n').map(plainLine), open: false, preformatted: source.startsWith('```')}, at);
    view.setThinking(false);
    view.render(transcript.messages, transcript.revision);
    await tick();
    assert(host.querySelector('.md-heading') && host.querySelector('table') && host.querySelector('.md-pre code'), 'Review preview is missing rendered content');
    assert(document.documentElement.scrollWidth <= innerWidth, 'Review preview overflows the viewport');
  },
  async raw_code() {
    const source = '# Python source\nif __name__ == "__main__":\n    print("**literal**")';
    const transcript = output(source, true), view = makeView();
    view.render(transcript.messages, transcript.revision);
    assert([...host.querySelectorAll('.chat-line')].map(node => node.textContent).join('\n') === source,
      `Source changed: ${host.textContent}`);
    return { source };
  },
  async rich_metadata() {
    const transcript = output('## A title\n**Some text**'), view = makeView();
    view.render(transcript.messages, transcript.revision);
    const heading = host.querySelector('.md-heading');
    assert(heading, 'Initial heading missing');
    transcript.messages[0].revision++;
    view.render(transcript.messages, transcript.revision + 1);
    assert(host.querySelector('.md-heading') === heading, 'Metadata update destroyed the rich heading');
  },
  async rich_revision() {
    const transcript = output('## A title'), view = makeView();
    view.render(transcript.messages, transcript.revision);
    transcript.messages[0].lines = [plainLine('## Revised title')];
    transcript.messages[0].revision++;
    view.render(transcript.messages, transcript.revision + 1);
    assert(host.querySelector('.md-heading')?.textContent === 'Revised title', 'Revised content is stale or raw');
  },
  async orphan_pipe() {
    renderMarkdown(host, '## Output\n| not a table |\nfollowing text');
    assert(host.textContent?.includes('following text'), 'Text after pipe row is missing');
  },
  async standalone_table() {
    const transcript = output('| Name | Count |\n| --- | ---: |\n| alpha | 1 |'), view = makeView();
    view.render(transcript.messages, transcript.revision);
    assert(host.querySelectorAll('table th').length === 2 && host.querySelectorAll('table td').length === 2,
      'Standalone table was printed as raw rows');
  },
  async padded_table() {
    const transcript = output('Name | Count\n--- | ---:\n`left|right`   |  1\nescaped \\| pipe | 2', true), view = makeView();
    view.render(transcript.messages, transcript.revision);
    assert(host.querySelectorAll('table td').length === 4, 'Padded table lost its columns');
    assert(host.querySelector('td')?.textContent === 'left|right', 'Inline pipe split a cell');
    assert((host.querySelectorAll('td')[1] as HTMLElement).style.textAlign === 'right', 'Alignment lost');
  },
  async fenced_stream() {
    const terminal = new ChatTerminal({cols: 100, rows: 30}); terminal.open(host);
    const source = ['```python', 'if __name__ == "__main__":', '    print("**literal**")', '', '', '    print(42)', '```'];
    for (const row of source) await write(terminal, row + '\r\n');
    await pause(1000); await tick();
    assert(host.querySelector('.md-pre code')?.textContent === source.slice(1, -1).join('\n'),
      `Stream changed code: ${JSON.stringify(bodies())}`);
    terminal.dispose();
  },
  async blue_notice() {
    const transcript = new Transcript(), view = makeView();
    transcript.noticed('Reading Claude Code as messages.', 1);
    view.render(transcript.messages, transcript.revision);
    const chip = host.querySelector<HTMLElement>('[data-tone="info"] .chat-chip')!;
    const expected = document.createElement('span');
    expected.style.color = 'var(--blue-deep)'; expected.style.backgroundColor = 'var(--blue-wash)'; host.append(expected);
    const actual = getComputedStyle(chip), blue = getComputedStyle(expected);
    assert(actual.color === blue.color && actual.backgroundColor === blue.backgroundColor,
      `Notice colours: ${actual.color}, ${actual.backgroundColor}`);
  },
  async cache_arrival() {
    const session = crypto.randomUUID(), cache = new ChatHistory(session, 'repro-only-secret');
    cache.save(output('older cached answer').messages); await cache.flush();
    const load = ChatHistory.prototype.load;
    ChatHistory.prototype.load = async function () { await pause(150); return load.call(this); };
    const terminal = new ChatTerminal({cols: 80, rows: 24});
    try {
      terminal.rememberAs(session, 'repro-only-secret'); terminal.open(host);
      terminal.reset(); await write(terminal, 'new live answer\r\n\r\n');
      await pause(1000); await tick();
      assert(JSON.stringify(bodies()) === JSON.stringify(['older cached answer', 'new live answer']),
        `Fast output / slow history: ${JSON.stringify(bodies())}`);
    } finally { ChatHistory.prototype.load = load; terminal.dispose(); cache.dispose(); }
  },
  async recorded_frames() {
    const terminal = new ChatTerminal({cols: 80, rows: 40}); terminal.open(host);
    await write(terminal, '\x1b]0;Claude Code\x07\x1b[?1049h');
    for (const frame of CLAUDE_SESSION) { await write(terminal, screen(frame)); await tick(); }
    await pause(1600); await tick();
    const prompts = [...host.querySelectorAll('.chat-sent .chat-body')].map(node => node.textContent);
    const received = bodies();
    assert(prompts.length === 3 && received.length === 3,
      `Recorded sequence: ${JSON.stringify({prompts, received})}`);
    for (const noise of ['Jitterbugging', 'Ebbing', 'login expires', 'Tip:']) {
      assert(!received.join('\n').includes(noise), `UI furniture leaked: ${noise}`);
    }
    terminal.dispose();
    return {prompts, received};
  },
  async recorded_bytes() {
    const observed: Record<string, unknown> = {};
    for (const name of ['shell', 'claude', 'vim'] as const) {
      const terminal = new ChatTerminal({cols: 120, rows: 36}); terminal.open(host);
      const bytes = capture(name);
      // Prime-sized chunks cross ANSI/UTF-8 boundaries without modifying the recording.
      for (let at = 0; at < bytes.length; at += 137) await write(terminal, bytes.slice(at, at + 137));
      await pause(1600); await tick();
      const prompts = [...host.querySelectorAll('.chat-sent .chat-body')].map(node => node.textContent);
      observed[name] = {received: bodies(), prompts};
      assert(name === 'vim' || bodies().length > 0, `${name}: no output from actual recording`);
      if (name === 'vim') assert(host.textContent?.includes('Switch this session to the terminal renderer'), 'Unsupported fullscreen notice missing');
      if (name === 'claude') {
        assert(JSON.stringify(prompts) === JSON.stringify(['list the files in this directory, then explain in two sentences what a pseudo-terminal is']), `Actual recording duplicated/truncated its prompt: ${JSON.stringify(prompts)}`);
        assert((bodies().join('\n').match(/Listing 1 directory/gu) ?? []).length === 1, `Actual recording duplicated its progress heading: ${JSON.stringify(bodies())}`);
        assert((bodies().join('\n').match(/Listing files in current directory/gu) ?? []).length === 1, `Actual recording duplicated its blinking heading: ${JSON.stringify(bodies())}`);
        assert(bodies().join('\n').includes('when no physical terminal is attached.'), 'Actual recording lost the end of its answer');
      }
      terminal.dispose();
    }
    return observed;
  },
};

const name = new URLSearchParams(location.search).get('case')!;
Object.assign(window, {reproduction: {status: 'running', name}});
Promise.resolve().then(() => {
  // Keep URL input out of method dispatch, including inherited property names.
  switch (name) {
    case 'review_preview': return cases.review_preview();
    case 'raw_code': return cases.raw_code();
    case 'rich_metadata': return cases.rich_metadata();
    case 'rich_revision': return cases.rich_revision();
    case 'orphan_pipe': return cases.orphan_pipe();
    case 'standalone_table': return cases.standalone_table();
    case 'padded_table': return cases.padded_table();
    case 'fenced_stream': return cases.fenced_stream();
    case 'blue_notice': return cases.blue_notice();
    case 'cache_arrival': return cases.cache_arrival();
    case 'recorded_frames': return cases.recorded_frames();
    case 'recorded_bytes': return cases.recorded_bytes();
    default: throw new Error('Unknown reproduction case');
  }
}).then(
  details => Object.assign(window, {reproduction: {status: 'pass', name, details}}),
  error => Object.assign(window, {reproduction: {status: 'fail', name, error: String(error.message)}}),
);
