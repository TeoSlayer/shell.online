// The session summary card opens from anywhere on a list row or board card,
// with real mouse and touch input in Chrome. Actual SessionSummaryHover and
// app styles; the vault is a stub and there is no network traffic.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { launchChromeTransport, removeProfile } from "./lib/browser-transport.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp("/tmp/shell-summary-hover-");

// The hover only needs to know who is signed in and that the vault is open.
const vaultStub = {
  name: "vault-stub",
  setup(builder) {
    builder.onResolve({ filter: /vault\/VaultProvider$/ }, () => ({ path: "vault-stub", namespace: "stub" }));
    builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export const useVault = () => ({ uid: 'owner', status: 'unlocked' });",
      loader: "js",
    }));
  },
};

const built = await build({
  absWorkingDir: join(root, "app"), bundle: true, write: false, outdir: temp,
  format: "esm", platform: "browser", jsx: "automatic",
  define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
  external: ["/fonts/*"],
  plugins: [vaultStub],
  stdin: { resolveDir: join(root, "app"), sourcefile: "fixture.jsx", loader: "jsx", contents: `
    import {createRoot} from 'react-dom/client';
    import {SessionSummaryHover} from './src/components/SessionSummaryHover';
    ${["tokens", "base", "auth", "people"].map((s) => `import './src/styles/${s}.css';`).join("\n")}
    window.opens = 0;
    const session = (id) => ({ id, uid: 'owner', ownerUid: 'owner', summariesEnabled: true, command: 'claude', startedAt: 1 });
    const summary = { version: 1, title: 'Refactor parser', summary: 'Parser refactored; all tests pass.', state: 'waiting_for_input', source: 'claude-code', observedAt: Date.now() - 60000 };
    const open = () => { window.opens += 1; };
    function Fixture() {
      return <main style={{ padding: 24 }}>
        <table style={{ width: 900, borderCollapse: 'collapse' }}><tbody>
          <SessionSummaryHover session={session('row')} summary={summary} now={Date.now()}>
            {(hover) => <tr {...hover} id="row" className="table-row-linked" onClick={open} style={{ height: 48 }}>
              <td style={{ width: 300 }}><a href="#name" id="row-name">Session name</a></td>
              <td style={{ width: 300 }}>Host</td>
              <td id="row-far" style={{ width: 300 }}>Started</td>
            </tr>}
          </SessionSummaryHover>
        </tbody></table>
        {/* A scrolling column that would clip an absolutely positioned card. */}
        <div id="column" style={{ marginTop: 32, width: 280, height: 140, overflow: 'hidden', border: '1px solid #ccc' }}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 8 }}>
            <SessionSummaryHover session={session('card')} summary={summary} now={Date.now()}>
              {(hover) => <li {...hover} id="card" className="board-card" onClick={open} style={{ height: 110 }}>
                <a href="#card-name">Card name</a><p id="card-foot" style={{ marginTop: 60 }}>footer</p>
              </li>}
            </SessionSummaryHover>
          </ul>
        </div>
        <div id="away" style={{ marginTop: 300, height: 40 }}>elsewhere</div>
      </main>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  ` },
});
const js = built.outputFiles.find((file) => file.path.endsWith(".js")).text;
const css = built.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://fixture").pathname;
  if (path === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(js); }
  if (path === "/fixture.css") { res.setHeader("Content-Type", "text/css"); return res.end(css); }
  if (path === "/") {
    res.setHeader("Content-Type", "text/html");
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'");
    return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');
  }
  res.writeHead(404).end();
});

let browser;
// Values go through CDP's argument channel, never into JavaScript source.
function pointIn(selector, dx, dy) {
  const r = document.querySelector(selector).getBoundingClientRect();
  return { x: r.left + r.width * dx, y: r.top + r.height * dy };
}
const centre = (selector, dx = 0.5, dy = 0.5) => browser.call(pointIn, selector, dx, dy);
const cardOpen = () => browser.evaluate("!!document.querySelector('.summary-card')");
const until = async (expression, label) => {
  for (let i = 0; i < 60; i++) { if (await browser.evaluate(expression)) return; await delay(50); }
  throw Error(`Timed out: ${label}`);
};

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await launchChromeTransport({ profile: join(temp, "profile") });
  await browser.setViewport({ width: 1280, height: 800, dpr: 1, mobile: false });
  await browser.navigate(`http://127.0.0.1:${server.address().port}/`);
  await until("!!document.getElementById('row') && !!document.getElementById('card')", "fixture rendered");

  assert.equal(await browser.evaluate("document.querySelectorAll('button').length"), 0, "No info button on rows or cards");

  // List row: hovering a cell far from the name opens it.
  await browser.mouse("mouseMoved", await centre("#away"));
  await browser.mouse("mouseMoved", await centre("#row-far"));
  await until("!!document.querySelector('.summary-card')", "card opens from anywhere on the row");
  assert.equal(await browser.evaluate("document.querySelector('.summary-card-title').textContent"), "Refactor parser");
  assert.equal(await browser.evaluate("document.getElementById('row').getAttribute('aria-describedby')"),
    await browser.evaluate("document.querySelector('.summary-card').id"), "Row is described by its summary");

  // Moving onto the card keeps it open, so it can be read.
  await browser.mouse("mouseMoved", await centre(".summary-card"));
  await delay(400);
  assert(await cardOpen(), "Card stays open while the pointer is on it");

  await browser.mouse("mouseMoved", await centre("#away"));
  await until("!document.querySelector('.summary-card')", "card closes when the pointer leaves");

  // Board card inside a clipping column: opens from its footer, and floats unclipped.
  await browser.mouse("mouseMoved", await centre("#card-foot"));
  await until("!!document.querySelector('.summary-card')", "card opens from anywhere on the board card");
  const visible = await browser.evaluate(`(()=>{const c=document.querySelector('.summary-card');const r=c.getBoundingClientRect();
    const hit=document.elementFromPoint(r.left+r.width/2,r.bottom-4);
    return getComputedStyle(c).position==='fixed'&&c.contains(hit)&&r.right<=innerWidth&&r.bottom<=innerHeight})()`);
  assert(visible, "Card floats above the clipping column, inside the viewport");
  await browser.mouse("mouseMoved", await centre("#away"));
  await until("!document.querySelector('.summary-card')", "board card closes");

  // A click still opens the session as before.
  const far = await centre("#row-far");
  await browser.mouse("mousePressed", far);
  await browser.mouse("mouseReleased", far);
  assert.equal(await browser.evaluate("window.opens"), 1, "Clicking the row still opens it");
  await browser.mouse("mouseMoved", await centre("#away"));
  await until("!document.querySelector('.summary-card')", "closed before touch");

  // Touch: a long press anywhere opens it, and that press does not open the session.
  await browser.setViewport({ width: 390, height: 844, dpr: 2, mobile: true });
  await delay(200);
  const opensBefore = await browser.evaluate("window.opens");
  const press = await centre("#card-foot");
  await browser.touch("touchStart", [press]);
  await delay(700);
  await browser.touch("touchEnd", []);
  await until("!!document.querySelector('.summary-card')", "long press opens the card");
  await delay(300);
  assert.equal(await browser.evaluate("window.opens"), opensBefore, "The long press did not open the session");

  // A tap elsewhere closes it; a quick tap on the card opens the session, not the summary.
  await browser.touch("touchStart", [await centre("#away")]);
  await browser.touch("touchEnd", []);
  await until("!document.querySelector('.summary-card')", "tap elsewhere closes the card");
  const tap = await centre("#card-foot");
  await browser.touch("touchStart", [tap]);
  await delay(60);
  await browser.touch("touchEnd", []);
  let opens = opensBefore;
  for (let i = 0; i < 60 && opens === opensBefore; i++) { await delay(50); opens = await browser.evaluate("window.opens"); }
  assert.equal(opens, opensBefore + 1, "A quick tap still opens the session");
  assert(!(await cardOpen()), "A quick tap does not show the summary");

  console.log("summary hover browser gate: passed");
} finally {
  await browser?.close();
  server.close();
  await removeProfile(join(temp, "profile"));
}
