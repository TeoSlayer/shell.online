// Independent oracle: Go's real host snapshot must reconstruct a continuously
// fed xterm.js, not another copy of the same truncated replay.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import headless from '@xterm/headless';
const { Terminal } = headless;
const fixtures = JSON.parse(execFileSync('go', ['run', './internal/ringbuffer/testdata/terminal-snapshot'], {
  cwd: new URL('..', import.meta.url), maxBuffer: 8 * 1024 * 1024,
}));
const create = () => new Terminal({cols:80, rows:24, allowProposedApi:true});
const write = (term, bytes) => new Promise(resolve => term.write(bytes, resolve));
const decode = value => Buffer.from(value, 'base64');
function screen(term) {
  const buffer = term.buffer.active;
  const rows = Array.from({length:24}, (_,y) => Array.from({length:80}, (_,x) => {
    const c = buffer.getLine(buffer.baseY+y).getCell(x);
    return [c.getChars(), c.getWidth(), c.getFgColor(), c.getBgColor(), c.isBold(), c.isInverse()];
  }));
  return {rows, x:buffer.cursorX, y:buffer.cursorY, type:buffer.type};
}
for (const fixture of fixtures) {
  const live=create(), joined=create();
  try {
    await write(live, decode(fixture.Before));
    await write(joined, decode(fixture.Snapshot));
    assert.deepEqual(screen(joined), screen(live), fixture.Name+' initial snapshot');
    await write(live, decode(fixture.After));
    await write(joined, decode(fixture.After));
    assert.deepEqual(screen(joined), screen(live), fixture.Name+' subsequent output');
    if (fixture.Name === 'incremental-overflow') {
      const broken=create();
      try {
        await write(broken, decode(fixture.Tail));
        assert.notDeepEqual(screen(broken), screen(joined), 'raw-tail negative control must reproduce corruption');
      } finally { broken.dispose(); }
    }
    console.log('PASS '+fixture.Name);
  } finally { live.dispose(); joined.dispose(); }
}
