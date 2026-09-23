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
    import {VaultProvider,useVault} from './src/vault/VaultProvider';
    import {TeamKeyProvider} from './src/vault/TeamKeyProvider';
    import {initializeAppearance,setAppearance} from './src/lib/appearance';
    import {forgetAll} from './src/lib/session-passwords';
    ${["tokens", "base", "auth", "shell", "terminal", "chat", "people", "collab", "audit", "terms", "vault", "feedback"].map(s => `import './src/styles/${s}.css';`).join("\n")}
    initializeAppearance();window.layoutTheme=setAppearance;window.layoutForgetPasswords=forgetAll;
    const auth={user:{uid:'layout-fixture',email:'fixture@example.test',displayName:'Layout Test'},initializing:false,signOutUser:async()=>{}};
    let remoteVault=null;
    const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
    globalThis.fetch=async(input,init={})=>{
      const url=new URL(typeof input==='string'?input:input.url,location.origin);
      if(url.origin!==location.origin)throw Error('Unexpected external fixture API request');
      const path=url.pathname;
      if(path==='/api/vault'){
        if(init.method==='POST'){const b=JSON.parse(init.body);remoteVault={publicKey:b.public_key,encryptedPrivateKey:b.encrypted_private_key,recoveryWrap:b.recovery_wrap,version:1,createdAt:Date.now(),updatedAt:Date.now()};}
        return json({vault:remoteVault});
      }
      if(path==='/api/team-key')return json({teamKey:null,share:null,missing:[]});
      if(path==='/api/org')return json({organization:{id:'layout-org',name:'Fixture'},you:{uid:'layout-fixture',role:'owner'},members:[],invites:[]});
      if(path==='/api/sessions')return json({sessions:[]});
      if(path.endsWith('/keys'))return json({shared:1});
      if(path==='/api/notifications')return json({notifications:[],unread:0,unreadAssignments:0,members:[]});
      window.fixtureErrors.push('Unexpected fixture API request');throw Error('Unexpected fixture API request');
    };
    function VaultProbe(){window.layoutVault=useVault();return null;}
    function Fixture(){
      const panes=useRef(null),[mode,setMode]=useState('terminal'),[share,setShare]=useState(),[renderer,setRenderer]=useState('xterm');
      window.layoutSetShare=setShare;
      window.layoutMode=setMode;
      window.layoutRenderer=setRenderer;
      useKeyboardInset(panes,mode==='terminal');
      return <AppShell title="Sessions" aside={<button className="new-session" aria-label="New session"><Plus size={16} weight="bold"/><span className="new-session-label">Session</span></button>}>
        {mode==='terminal' ? <>
          <div className="terminal-bar"><div className="tabs"><button className="tab">All sessions</button>{Array.from({length:8},(_,i)=><div className="tab is-active" key={i}><button className="tab-label">Synthetic agent {i+1} {'W'.repeat(64)}</button><button className="tab-close" aria-label="Close tab">×</button></div>)}</div><label className="tab-renderer"><span>Renderer</span><select><option>xterm.js</option></select></label></div>
          <div className="panes" ref={panes}><TerminalPane shareUrl={location.origin+'/s/00000000000000000000000000000000'} keyShare={share} renderer={renderer} active canType={false} pulseAllowed={false} host={'Synthetic-MacBook-'+ 'W'.repeat(64)}/></div>
        </> : <div>{Array.from({length:mode==='long'?65:1},(_,i)=><p key={i} style={{padding:'12px 0'}}>Synthetic session row {i+1}</p>)}<button id="last-row">Last row</button></div>}
      </AppShell>;
    }
    createRoot(document.getElementById('root')).render(<BrowserRouter><AuthContext.Provider value={auth}><VaultProvider><VaultProbe/><TeamKeyProvider><Fixture/></TeamKeyProvider></VaultProvider></AuthContext.Provider></BrowserRouter>);
  ` },
  plugins: [{ name: "synthetic-terminal-transport", setup(b) {
    b.onResolve({filter:/^\.\/firebase$/},args=>args.importer.endsWith('/lib/api.ts')?{path:join(root,'app/scripts/fixtures/firebase-stub.ts')}:null);
    b.onResolve({ filter: /game\/GameRoute$/ }, () => ({ path: "game", namespace: "fixture" }));
    b.onResolve({ filter: /^\.\/connection$/ }, args => args.importer.endsWith("TerminalPane.tsx") ? { path: "transport", namespace: "fixture" } : null);
    b.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ loader: "js", contents: args.path === "game" ? "export default function Game(){return null}" : `
      export class TerminalConnection {
        constructor({events}){this.events=events;this.needsPassword=!!window.layoutStartLocked;window.layoutConnections=(window.layoutConnections||0)+1;window.layoutGrid=grid=>events.onGrid(grid);window.layoutStatus=(status,detail)=>events.onStatus(status,detail);}
        async start(){this.events.onGrid({cols:120,rows:36});this.events.onStatus(this.needsPassword?'needs-password':'connected');this.events.onHostState({presence:'connected'});this.events.onMcpAuthorization(true);this.events.onReadOnly(true);if(!this.needsPassword)this.events.onData(new TextEncoder().encode(Array.from({length:36},(_,i)=>String(i+1).padStart(2,'0')+' '+(i===0?'SYNTHETIC TERMINAL — RESPONSIVE LAYOUT':'Working on a fixture. No real session or credentials.')).join('\\r\\n')),true);}
        sendFrame(){} send(){} sendBinary(){} requestSnapshot(){} close(){}
        async submitPassword(value){(window.layoutSubmitted??=[]).push(value);if(value==='synthetic-session-password'){this.needsPassword=false;this.events.onUnlocked();this.events.onStatus('connected');}else this.events.onStatus('needs-password','Synthetic wrong session password');}
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
  for (const theme of process.env.APP_LAYOUT_GATE_ONLY ? [] : ['light','dark']) {
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
  // A locked/failed session has a document over the fixed terminal, not terminal
  // scrollback. Its own scroller must reach every control without moving the grid.
  for (const theme of ['light','dark']) {
    await browser.call(theme=>window.layoutTheme(theme),theme);
    for(const [width,height] of [[393,650],[320,568],[390,360],[844,320],[1024,500],[1440,900]]) {
      await browser.setViewport({width,height,dpr:1,mobile:width<=393});
      await delay(150);
      for(const status of ['needs-password','error']) {
        await browser.call(status=>window.layoutStatus(status,status==='error'?'Synthetic error '+ 'Long error detail. '.repeat(35):undefined),status);
        await until("!!document.querySelector('.pane-gate-card')",'session gate');
        await delay(100);
        if(status==='needs-password') {
          assert(await browser.call(()=>document.querySelector('.pane-gate').scrollTop===0),
            'Opening the password form must not auto-scroll past its heading and unlock choices');
        }
        const start=await browser.call(()=>{
          const gate=document.querySelector('.pane-gate'),card=gate.querySelector('.pane-gate-card');
          gate.scrollTop=0;
          return {overflow:getComputedStyle(gate).overflowY,client:gate.clientHeight,total:gate.scrollHeight,horizontal:card.scrollWidth>card.clientWidth+1};
        });
        assert(['auto','scroll'].includes(start.overflow),'Session gate owns user scrolling, rather than clipping under navigation');
        assert(!start.horizontal,'Long host/error text fits the gate');
        assert(await browser.call(()=>{const g=document.querySelector('.pane-gate').getBoundingClientRect();return !!document.elementFromPoint(g.left+g.width/2,g.top+30)?.closest('.pane-gate');}),'Terminal badges/tools cannot cover the unlock controls');
        if(browser.swipe && width<=393 && start.total>start.client+1) {
          const point=await browser.call(()=>{const r=document.querySelector('.pane-gate').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height*0.8,deltaY:-r.height*0.5};});
          await browser.swipe(point);
          assert(await browser.call(()=>document.querySelector('.pane-gate').scrollTop>0),'A real touch swipe scrolls the gate');
        }
        await browser.call(()=>{const gate=document.querySelector('.pane-gate');gate.scrollTop=gate.scrollHeight;});
        await delay(80);
        const end=await browser.call(()=>{
          const gate=document.querySelector('.pane-gate'),r=gate.getBoundingClientRect();
          const card=gate.querySelector('.pane-password-form')||gate.querySelector('.pane-gate-card');
          const last=card.lastElementChild.getBoundingClientRect();
          return {scroll:gate.scrollTop,reachable:last.bottom<=r.bottom+1&&last.top>=r.top-1};
        });
        assert(end.reachable,'Help remains reachable above the bottom navigation');
        if(start.total>start.client+1)assert(end.scroll>0,'Overflowing gate actually scrolls');
        if(status==='needs-password') {
          await browser.call(()=>document.querySelector('.pane-gate button[type="submit"]').scrollIntoView({block:'center'}));
          await delay(80);
          assert(await browser.call(()=>{const g=document.querySelector('.pane-gate').getBoundingClientRect(),b=document.querySelector('.pane-gate button[type="submit"]').getBoundingClientRect();return b.top>=g.top&&b.bottom<=g.bottom;}),'Submit independently reachable even in short windows');
        }
        const scrollReset=await browser.call(()=>{const gate=document.querySelector('.pane-gate');gate.scrollTop=0;return gate.scrollTop;});
        await delay(80);
        const heading=await browser.call(()=>{const gate=document.querySelector('.pane-gate'),g=gate.getBoundingClientRect(),h=document.querySelector('.pane-gate h2').getBoundingClientRect();return {gateTop:g.top,gateBottom:g.bottom,headingTop:h.top,headingBottom:h.bottom,scroll:gate.scrollTop,width:innerWidth,height:innerHeight,focused:document.activeElement?.tagName,viewport:visualViewport?.height,offsetTop:visualViewport?.offsetTop};});
        if(shots && heading.headingTop<heading.gateTop)await writeFile(join(shots,'gate-heading-failure.png'),Buffer.from(await browser.screenshot(),'base64'));
        assert(heading.headingTop>=heading.gateTop,'Oversized card never centers its heading above the scroll origin: '+JSON.stringify({scrollReset,...heading}));
        await browser.call(()=>document.querySelector('.pane-gate h2').scrollIntoView({block:'center'}));
        await delay(80);
        assert(await browser.call(()=>{const g=document.querySelector('.pane-gate').getBoundingClientRect(),h=document.querySelector('.pane-gate h2').getBoundingClientRect();return h.top>=g.top-1&&h.bottom<=g.bottom+1;}),'Heading is fully reachable, including when the viewport is shorter than its decorative header');
        if(shots)await writeFile(join(shots,`gate-${theme}-${status}-${width}-${height}.png`),Buffer.from(await browser.screenshot(),'base64'));
        const actual=await browser.call(()=>({width:innerWidth,height:innerHeight}));
        console.log(`PASS session gate ${browser.name} ${theme} ${status} ${actual.width}x${actual.height} (requested ${width}x${height}): heading, scroll, submit and help`);
        await browser.call(()=>window.layoutStatus('connected'));
        await until("!document.querySelector('.pane-gate')",'gate dismissed');
      }
    }
  }
  // Real VaultProvider + vault crypto + real form handlers, only network and
  // terminal transport are fixtures. Prove opening a locked vault retries the
  // existing sealed share, without reconnecting or forwarding the vault secret.
  await browser.setViewport({width:393,height:650,dpr:1,mobile:true});
  await until("layoutVault.status==='setup'",'synthetic vault setup');
  await browser.call(async()=>{
    const prepared=await layoutVault.prepare(false,'synthetic-vault-password');
    await layoutVault.commit(prepared);
  });
  await until("layoutVault.status==='unlocked'",'vault created');
  await browser.call(async()=>{
    const share=await layoutVault.sealTo({uid:'layout-fixture',accountKey:layoutVault.publicKey},'0'.repeat(32),'synthetic-session-password');
    layoutSetShare(share);await layoutVault.lock();layoutMode('short');layoutForgetPasswords();window.layoutStartLocked=true;
  });
  await until("layoutVault.status==='locked' && !document.querySelector('.pane')",'vault locked and terminal unmounted');
  await browser.call(()=>{window.layoutSubmitted=[];layoutMode('terminal');});
  await until("!!document.querySelector('.pane-gate .vault-form')",'inline vault choice');
  const connectionCount=await browser.call(()=>layoutConnections);
  assert(await browser.call(()=>document.querySelectorAll('[aria-label="Session unlock method"] button').length===2),'Vault and session password are both offered');
  if(shots)await writeFile(join(shots,'inline-vault-choice.png'),Buffer.from(await browser.screenshot(),'base64'));
  const typeInto=async(selector,value)=>{
    await browser.call((selector,value)=>{const input=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));},selector,value);
    await delay(50);
  };
  await typeInto('.pane-gate .vault-form input','wrong-vault-password');
  await browser.call(()=>document.querySelector('.pane-gate .vault-form button[type="submit"]').click());
  await until("!!document.querySelector('.pane-gate .alert')",'wrong vault password remains actionable');
  assert(await browser.call(()=>layoutVault.status==='locked'&&layoutSubmitted.length===0),'Vault password never reaches terminal transport');
  await typeInto('.pane-gate .vault-form input','synthetic-vault-password');
  await browser.call(()=>document.querySelector('.pane-gate .vault-form button[type="submit"]').click());
  await until("!document.querySelector('.pane-gate')",'vault unlock opens the existing terminal');
  assert(await browser.call(count=>layoutConnections===count&&layoutSubmitted.length===1&&layoutSubmitted[0]==='synthetic-session-password',connectionCount),'Saved share retried once without reconnect; only session password submitted');
  console.log('PASS real inline vault unlock: wrong password, successful crypto unlock, saved-share retry and no reconnect');
  await browser.call(async()=>{layoutMode('short');layoutForgetPasswords();await layoutVault.lock();});
  await until("!document.querySelector('.pane') && layoutVault.status==='locked'",'direct-password fixture ready');
  await browser.call(()=>{window.layoutSubmitted=[];layoutMode('terminal');});
  await until("!!document.querySelector('.pane-gate .vault-form')",'locked vault prompt again');
  await browser.call(()=>document.querySelectorAll('[aria-label="Session unlock method"] button')[1].click());
  await until("!!document.querySelector('.pane-password-form')",'session password choice');
  if(shots)await writeFile(join(shots,'inline-password-choice.png'),Buffer.from(await browser.screenshot(),'base64'));
  if(browser.name==='chrome') {
    // Exercise the real viewport listener with a synthetic keyboard-sized
    // visual viewport. This is not a claim of attached-iPhone keyboard testing.
    const before=await browser.call(()=>document.querySelector('.xterm-screen').getBoundingClientRect().height);
    await browser.call(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:350});visualViewport.dispatchEvent(new Event('resize'));});
    await until("document.documentElement.dataset.keyboard==='open'",'keyboard viewport update');
    await delay(150);
    await browser.call(()=>document.querySelector('.pane-password-form button[type="submit"]').scrollIntoView({block:'center'}));
    await delay(80);
    assert(await browser.call(()=>{const r=document.querySelector('.pane-gate').getBoundingClientRect(),b=document.querySelector('.pane-password-form button[type="submit"]').getBoundingClientRect();return r.bottom<=visualViewport.height+visualViewport.offsetTop+1&&b.top>=r.top&&b.bottom<=r.bottom;}),'Unlock submit clears the keyboard, even below the terminal minimum height');
    assert.equal(await browser.call(()=>document.querySelector('.xterm-screen').getBoundingClientRect().height),before,'Keyboard does not shrink terminal rendering');
    await browser.call(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});
    await until("!document.documentElement.hasAttribute('data-keyboard')",'keyboard dismissed');
    console.log('PASS synthetic keyboard viewport: form scrolls, submit reachable, terminal size unchanged');
  }
  await typeInto('.pane-password-form input','wrong-session-password');
  await browser.call(()=>document.querySelector('.pane-password-form button[type="submit"]').click());
  await until("!!document.querySelector('.pane-password-form .alert')",'wrong session password error');
  await typeInto('.pane-password-form input','synthetic-session-password');
  await browser.call(()=>document.querySelector('.pane-password-form button[type="submit"]').click());
  await until("!document.querySelector('.pane-gate')",'direct session password opens terminal');
  assert(await browser.call(()=>layoutVault.status==='locked'&&layoutSubmitted.length===2&&layoutSubmitted[1]==='synthetic-session-password'),'Direct password does not require or unlock the vault');
  assert(await browser.call(()=>document.querySelector('.new-session').getBoundingClientRect().width<65),'New session action is compact on phones');
  assert.deepEqual(await browser.call(()=>fixtureErrors),[],'No browser or unexpected API errors');
  console.log('PASS direct session password: wrong/correct password, vault remains locked, compact new-session action');
  await browser.call(()=>{layoutMode('short');layoutForgetPasswords();layoutSetShare(undefined);});
  await until("!document.querySelector('.pane')",'no-saved-share fixture ready');
  await browser.call(()=>{window.layoutSubmitted=[];layoutMode('terminal');});
  await until("!!document.querySelector('.pane-gate .vault-form')",'vault choice without saved share');
  await typeInto('.pane-gate .vault-form input','synthetic-vault-password');
  await browser.call(()=>document.querySelector('.pane-gate .vault-form button[type="submit"]').click());
  await until("layoutVault.status==='unlocked' && !!document.querySelector('.pane-password-form')",'missing saved share falls back to session password');
  assert.equal(await browser.call(()=>layoutSubmitted.length),0,'No invented password after vault unlock');
  await typeInto('.pane-password-form input','synthetic-session-password');
  await browser.call(()=>document.querySelector('.pane-password-form button[type="submit"]').click());
  await until("!document.querySelector('.pane-gate')",'missing-share fallback opens terminal');
  assert.deepEqual(await browser.call(()=>fixtureErrors),[],'No browser or unexpected API errors after fallback');
  console.log('PASS unlocked vault without saved session password: direct-password fallback works');
  if(browser.name==='chrome') {
    for(const theme of ['light','dark']) for(const renderer of ['xterm','chat']) {
      await browser.setViewport({width:390,height:844,dpr:2,mobile:true});
      await browser.call(({theme,renderer})=>{
        layoutTheme(theme);layoutMode('short');layoutRenderer(renderer);window.layoutStartLocked=false;
      },{theme,renderer});
      await until("!document.querySelector('.pane')",'typing fixture reset');
      await browser.call(()=>layoutMode('terminal'));
      await until("!!document.querySelector('.pane') && !document.querySelector('.pane-gate')",'typing fixture mounted');
      await delay(150);
      /*
       * What must not move is the terminal's own rendering; the pane around it
       * is supposed to get smaller.
       *
       * This used to hold the pane's height still and keep the bar drawn in
       * the layout with `visibility: hidden`, from an approach where the shell
       * stayed screen-height under an open keyboard. A bar that keeps its row
       * while the page scrolls is a bar that scrolls into the middle of the
       * canvas, which is what somebody typing in a session actually saw. The
       * shell is the visible viewport now, the bar leaves the flow, and the
       * pane shrinks with it -- while the terminal holds the grid and the type
       * size it had, because a font re-fitting under a thumb mid-sentence is
       * the thing freezing the pane was really protecting against.
       */
      const measure=()=>({
        pane:document.querySelector('.panes').getBoundingClientRect().height,
        rail:document.querySelector('.rail').getBoundingClientRect().height,
        gone:getComputedStyle(document.querySelector('.rail')).display==='none',
        /* The emulator's own box, which is what a re-fit would change. */
        screen:(()=>{const s=document.querySelector('.xterm-screen');return s?s.getBoundingClientRect().height:0;})(),
        font:(()=>{const s=document.querySelector('.xterm');return s?getComputedStyle(s).fontSize:'';})(),
        /* Nothing may be left underneath the keyboard. */
        foot:document.querySelector('.shell').getBoundingClientRect().bottom,
      });
      const before=await browser.call(measure);
      await browser.call(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,value:400});visualViewport.dispatchEvent(new Event('resize'));});
      await until("document.documentElement.dataset.keyboard==='open'",'typing keyboard open');
      await delay(150);
      const during=await browser.call(measure);
      assert.equal(during.screen,before.screen,`${renderer}/${theme}: keyboard must not refit the terminal`);
      assert.equal(during.font,before.font,`${renderer}/${theme}: keyboard must not resize the terminal's type`);
      assert(during.pane<before.pane,`${renderer}/${theme}: the pane must give up the keyboard's room`);
      assert(during.foot<=401,`${renderer}/${theme}: nothing may be left under the keyboard`);
      assert(during.gone&&during.rail===0,'Navigation leaves the flow rather than keeping a blank row');
      await browser.call(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});
      await until("!document.documentElement.hasAttribute('data-keyboard')",'typing keyboard closed');
      await delay(150);
      const after=await browser.call(measure);
      assert(!after.gone&&Math.abs(after.rail-before.rail)<1,'Navigation returns after typing');
      assert(Math.abs(after.pane-before.pane)<1,'Pane returns to exactly the original height');
      assert.equal(after.screen,before.screen,'Terminal returns to exactly the original rendering');
      console.log(`PASS ${renderer}/${theme}: synthetic keyboard shrinks the pane, holds the terminal and hides/restores navigation`);
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
