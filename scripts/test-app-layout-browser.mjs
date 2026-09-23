// Actual AppShell + TerminalPane + xterm, synthetic transport and identity only.
// No live account, session, model, or analytics traffic. Screenshots stay outside source.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { launchChromeTransport, launchSafariTransport } from "./lib/browser-transport.mjs";
import { auditTextLayout } from "./lib/text-layout-audit.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp("/tmp/shell-app-layout-");
const shots = process.env.APP_LAYOUT_SHOTS ? resolve(process.env.APP_LAYOUT_SHOTS) : null;
if (shots) {
  assert(!shots.startsWith(root), "Keep screenshots outside the source checkout");
  await mkdir(shots, { recursive: true });
}
const built = await build({
  absWorkingDir: join(root, "app"), bundle: true, write: false, outdir: temp,
  format: "esm", platform: "browser", jsx: "automatic",
  define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
  external: ["/fonts/*"],
  stdin: { resolveDir: join(root, "app"), sourcefile: "fixture.jsx", loader: "jsx", contents: `
    import React,{useRef,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {BrowserRouter} from 'react-router-dom';
    import {Plus} from '@phosphor-icons/react';
    import {AppShell} from './src/components/AppShell';
    import {TerminalPane} from './src/terminal/TerminalPane';
    import {useKeyboardInset} from './src/terminal/keyboard-inset';
    import {AuthContext} from './src/auth/AuthProvider';
    import {VaultProvider} from './src/vault/VaultProvider';
    import {TeamKeyProvider} from './src/vault/TeamKeyProvider';
    import {initializeAppearance,setAppearance} from './src/lib/appearance';
    ${["tokens", "base", "auth", "shell", "terminal", "chat", "people", "collab", "audit", "terms", "vault", "feedback"].map(s => `import './src/styles/${s}.css';`).join("\n")}
    initializeAppearance();window.layoutTheme=setAppearance;
    const auth={user:{uid:'layout-fixture',email:'fixture@example.test',displayName:'Layout Test'},initializing:false,signOutUser:async()=>{}};
    function Fixture(){
      const panes=useRef(null),[mode,setMode]=useState('terminal');
      window.layoutMode=setMode;
      useKeyboardInset(panes,mode==='terminal');
      return <AppShell title="Sessions" aside={<button className="new-session"><Plus size={16} weight="bold"/>Session</button>}>
        {mode==='terminal' ? <>
          <div className="terminal-bar"><div className="tabs"><button className="tab">All sessions</button>{Array.from({length:8},(_,i)=><div className="tab is-active" key={i}><button className="tab-label">Synthetic agent {i+1} {'W'.repeat(64)}</button><button className="tab-close" aria-label="Close tab">×</button></div>)}</div><label className="tab-renderer"><span>Renderer</span><select><option>xterm.js</option></select></label></div>
          <div className="panes" ref={panes}><TerminalPane shareUrl={location.origin+'/s/00000000000000000000000000000000'} renderer="xterm" active canType={false} pulseAllowed={false}/></div>
        </> : <div>{Array.from({length:mode==='long'?65:1},(_,i)=><p key={i} style={{padding:'12px 0'}}>Synthetic session row {i+1}</p>)}<button id="last-row">Last row</button></div>}
      </AppShell>;
    }
    createRoot(document.getElementById('root')).render(<BrowserRouter><AuthContext.Provider value={auth}><VaultProvider><TeamKeyProvider><Fixture/></TeamKeyProvider></VaultProvider></AuthContext.Provider></BrowserRouter>);
  ` },
  plugins: [{ name: "synthetic-terminal-transport", setup(b) {
    b.onResolve({ filter: /game\/GameRoute$/ }, () => ({ path: "game", namespace: "fixture" }));
    b.onResolve({ filter: /^\.\/connection$/ }, args => args.importer.endsWith("TerminalPane.tsx") ? { path: "transport", namespace: "fixture" } : null);
    b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "js", contents: args.path === "game" ? "export default function Game(){return null}" : `
      export class TerminalConnection {
        constructor({events}){this.events=events;this.needsPassword=false;window.layoutGrid=grid=>events.onGrid(grid);}
        async start(){this.events.onGrid({cols:120,rows:36});this.events.onStatus('connected');this.events.onHostState({presence:'connected'});this.events.onMcpAuthorization(true);this.events.onReadOnly(true);this.events.onData(new TextEncoder().encode(Array.from({length:36},(_,i)=>String(i+1).padStart(2,'0')+' '+(i===0?'SYNTHETIC TERMINAL — RESPONSIVE LAYOUT':'Working on a fixture. No real session or credentials.')).join('\\r\\n')),true);}
        sendFrame(){} send(){} sendBinary(){} requestSnapshot(){} close(){} async submitPassword(){}
      }
    ` }));
  } }],
});
const js = built.outputFiles.find(f => f.path.endsWith(".js")).contents;
const css = built.outputFiles.find(f => f.path.endsWith(".css")).contents;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(js); }
  if (path === "/fixture.css") { res.setHeader("Content-Type", "text/css"); return res.end(css); }
  if (path === "/diagnostic.js") { res.setHeader("Content-Type", "text/javascript"); return res.end("window.fixtureErrors=[];addEventListener('error',e=>fixtureErrors.push(e.message));addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));"); }
  if (path === "/fonts/uncut-sans-variable.woff2") { res.setHeader("Content-Type", "font/woff2"); return res.end(await readFile(join(root, "public", path))); }
  if (path === "/sessions") {
    res.setHeader("Content-Type", "text/html");
    // No network destination except this isolated fixture, including from a lazy module.
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'self';");
    return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/diagnostic.js"></script><script type="module" src="/fixture.js"></script>');
  }
  res.writeHead(404).end();
});
let browser;
const until = async (expression, label) => {
  for (let i = 0; i < 120; i++) { if (await browser.evaluate(expression)) return; await delay(50); }
  console.error(await browser.evaluate("JSON.stringify({errors:window.fixtureErrors,body:document.body.innerText.slice(0,300)})"));
  throw Error(`Timed out: ${label}`);
};
try {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  browser = process.env.APP_LAYOUT_BROWSER === "safari"
    ? await launchSafariTransport()
    : await launchChromeTransport({ profile: join(temp, "profile") });
  const origin = `http://127.0.0.1:${server.address().port}/sessions`;
  await browser.navigate(origin);
  // Prove the geometry oracle rejects overflow, accepts intentional name
  // ellipsis, and still rejects clipping a required status/permission badge.
  await browser.evaluate(`(()=>{const p=document.createElement('div');p.id='text-audit-fixture';p.style.cssText='position:fixed;top:0;left:0;width:20px';const e=document.createElement('span');e.className='text-audit-label';e.style.cssText='display:block;width:20px;white-space:nowrap';e.textContent='W'.repeat(64);p.append(e);document.body.append(p);})()`);
  assert((await browser.call(auditTextLayout,{selectors:['.text-audit-label']})).includes('.text-audit-label: text overflows'),'Oracle catches unbounded text');
  await browser.evaluate(`Object.assign(document.querySelector('.text-audit-label').style,{overflow:'hidden',textOverflow:'ellipsis'})`);
  assert.deepEqual(await browser.call(auditTextLayout,{selectors:['.text-audit-label']}),[],'Names may deliberately ellipsize');
  assert((await browser.call(auditTextLayout,{selectors:['.text-audit-label'],complete:['.text-audit-label']})).includes('.text-audit-label: required badge text clipped'),'Required badge cannot hide behind ellipsis');
  await browser.evaluate(`document.getElementById('text-audit-fixture').remove()`);
  await until("!!document.querySelector('.xterm-screen') && document.fonts.status==='loaded'", "real terminal mounted");
  // Resize one mounted app across both sides of each breakpoint, including returning.
  for (const theme of ['light','dark']) {
  await browser.evaluate(`window.layoutTheme('${theme}')`);
  for (const [width, height] of [[845,676],[900,768],[901,768],[1440,900],[1920,1080],[1024,768],[761,700],[760,700],[641,700],[640,700],[561,700],[560,700],[390,844],[320,640],[600,480],[850,480],[844,390],[667,375],[1024,480],[845,900],[1440,900]]) {
    if (process.env.APP_LAYOUT_ONLY && String(width) !== process.env.APP_LAYOUT_ONLY) continue;
    await browser.setViewport({ width, height, dpr: 1, mobile: false });
    // Explicit synthetic relay announcements: a handset uses the portrait grid,
    // a desktop/tablet uses the wide grid. CSS must not change the PTY geometry.
    await browser.evaluate("window.layoutGrid(innerWidth<=760?{cols:80,rows:40}:{cols:120,rows:36})");
    await delay(220);
    const state = await browser.evaluate(`(() => {
      // Safari reports root-zoomed DOMRects in unzoomed units. Normalize to
      // viewport pixels using the root, not a browser-name assumption.
      const scale=innerWidth/document.documentElement.getBoundingClientRect().width;
      const rect=s=>{const r=(typeof s==='string'?document.querySelector(s):s).getBoundingClientRect();return {x:r.x*scale,y:r.y*scale,w:r.width*scale,h:r.height*scale,b:r.bottom*scale,right:r.right*scale}};
      return {width:innerWidth,height:innerHeight,rail:rect('.rail'),nav:rect('.rail-nav'),main:rect('.shell-main'),content:rect('.shell-content'),panes:rect('.panes'),screen:rect('.xterm-screen'),tabs:rect('.tabs'),overflow:document.documentElement.scrollWidth>innerWidth+1,bodyHeight:document.documentElement.scrollHeight,links:[...document.querySelectorAll('.rail-link')].map(rect),errors:window.fixtureErrors};
    })()`);
    console.log(`LAYOUT ${state.width}x${state.height}: navigation ${Math.round(state.rail.h)}px, pane ${Math.round(state.panes.w)}x${Math.round(state.panes.h)}, terminal ${Math.round(state.screen.w)}x${Math.round(state.screen.h)}`);
    if (shots) await writeFile(join(shots, `${theme}-${Math.round(state.width)}-${Math.round(state.height)}.png`), Buffer.from(await browser.screenshot(), "base64"));
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.xterm-screen').parentElement).backgroundColor`),theme==='dark'?'rgb(22, 25, 20)':'rgb(243, 241, 233)','Mounted terminal follows app theme');
    assert(!state.overflow, "No horizontal document overflow");
    assert.deepEqual(state.errors, [], "No browser rendering errors");
    if (state.width > 760 && state.width <= 900) {
      assert(state.rail.h <= 125, "Tablet navigation must stay content-sized, not stretch into an empty row");
      assert(state.nav.h <= 50, "Tablet nav only reserves its actual links");
      assert(state.panes.h >= state.height - 260, "Tablet gives remaining vertical space to the terminal");
      assert(state.screen.w >= Math.min(state.panes.w * 0.75, state.screen.h * 1.4), "Real xterm is not needlessly squeezed");
    }
    assert(state.panes.b <= state.height + 2 && state.main.b <= state.height + 2, "Workspace and terminal pane fit the viewport");
    if (state.width <= 760) {
      const shortLandscape=state.height<=450&&state.width/state.height>=4/3;
      if(shortLandscape)assert(state.rail.w<=70&&state.main.x>=state.rail.right-1,"Short landscape moves navigation beside the terminal");
      else assert(Math.abs(state.rail.b - state.height) <= 2, "Phone navigation stays at the bottom");
    }
    assert(state.screen.right <= state.panes.right + 2, "Terminal columns fit");
    assert(state.screen.b <= state.panes.b + 2, "All terminal rows fit, including short landscape windows");
    assert(state.links.every(l => l.w > 35 && l.h >= 40), "Navigation remains usable");
    assert.deepEqual(await browser.call(auditTextLayout,{selectors:['.tab-label','.pane-mcp-disclosure'],groups:['.tab','.pane-tools'],complete:['.pane-mcp-disclosure']}),[],"Tab names and complete MCP disclosure fit without overlap");
    await browser.evaluate(`(() => {const strip=document.querySelector('.tabs');strip.scrollLeft=strip.scrollWidth;})()`);
    await delay(80); // Safari applies native scrolling on the next rendering frame.
    const tabs = await browser.evaluate(`(() => {
      const strip=document.querySelector('.tabs');
      const last=strip.lastElementChild.getBoundingClientRect(),box=strip.getBoundingClientRect();
      return {reachable:last.right<=box.right+2,visible:last.left>=box.left-2,lastWidth:last.width,stripWidth:box.width,lastRight:last.right,stripRight:box.right};
    })()`);
    assert(tabs.reachable && tabs.visible, `Overflow tabs remain reachable without widening the page: ${JSON.stringify(tabs)}`);
    for (const [trigger, popup] of [[".account-chip", ".account-pop"], [".inbox-trigger", ".inbox-pop"]]) {
      await browser.evaluate(`(() => {const button=[...document.querySelectorAll('${trigger}')].find(b=>b.getBoundingClientRect().width>0);button.scrollIntoView({block:'nearest'});button.click();})()`);
      await delay(100);
      const menu = await browser.evaluate(`(() => {const r=document.querySelector('${popup}').getBoundingClientRect(),scale=innerWidth/document.documentElement.getBoundingClientRect().width;return {left:r.left*scale,right:r.right*scale,top:r.top*scale,bottom:r.bottom*scale,width:innerWidth,height:innerHeight};})()`);
      assert(menu.left >= -1 && menu.right <= menu.width + 2 && menu.top >= -1 && menu.bottom <= menu.height + 2, `${popup} stays inside the viewport: ${JSON.stringify(menu)}`);
      await browser.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await browser.evaluate(`(() => {const button=[...document.querySelectorAll('${trigger}')].find(b=>b.getBoundingClientRect().width>0);if(button.getAttribute('aria-expanded')==='true')button.click();})()`);
    }
    // Short documents must not grow navigation; long ones remain scrollable to their end.
    for (const mode of ["short", "long"]) {
      await browser.evaluate(`window.layoutMode('${mode}')`); await delay(100);
      const doc = await browser.evaluate(`(() => {const c=document.querySelector('.shell-content'),r=document.querySelector('.rail').getBoundingClientRect(),scale=innerWidth/document.documentElement.getBoundingClientRect().width;c.scrollTop=c.scrollHeight;document.querySelector('#last-row').scrollIntoView();return {railHeight:r.height*scale,button:document.querySelector('#last-row').getBoundingClientRect().bottom*scale,height:innerHeight};})()`);
      if (state.width > 760 && state.width <= 900) assert(doc.railHeight <= 125, "Short/long document nav remains compact");
      assert(doc.button <= doc.height + 2, "Last document control is reachable");
    }
    await browser.evaluate("(window.layoutMode('terminal'),window.scrollTo(0,0))");
    await until("!!document.querySelector('.xterm-screen')", "terminal remount");
  }
  }
  console.log("PASS actual app shell and terminal across tablet/phone/desktop boundaries; document scrolling and resize transitions");
} finally {
  await browser?.close();
  await new Promise(r => server.close(r));
  // Linux Chrome helpers can finish profile writes just after the main process
  // exits. Retry only this fixture-owned tree; persistent cleanup failure fails.
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
