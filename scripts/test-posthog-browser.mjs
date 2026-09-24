import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { launchChromeTransport } from './lib/browser-transport.mjs';

const live = process.env.POSTHOG_LIVE === '1';
const base = resolve(import.meta.dirname, '..');
const roots = { 'shell.online': join(base,'dist'), 'app.shell.online': join(base,'app/dist') };
const marker='SYNTHETIC_PRIVATE_POSTHOG_MARKER';
const expectedAgents = new Map();
const profile=await mkdtemp(join(tmpdir(),'shell-posthog-test-'));
let browser,socket,sequence=0,phase='startup';
const pending=new Map(), events=[], errors=[], reports=[], thirdParty=[];
const cdp=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout'));},15000);
  pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});
  socket.send(JSON.stringify({id,method,params}));
});
const wait=async(check,label)=>{const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await delay(60);}throw Error('Timeout: '+label);};
const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.json':'application/json'};
const built=await build({
  absWorkingDir:join(base,'app'),bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',
  stdin:{contents:`
    import React,{StrictMode,useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {BrowserRouter} from 'react-router-dom';
    import {ProductAnalytics} from './src/components/ProductAnalytics';
    import {trackAppAction} from '../web/posthog';
    import {VaultProvider,useVault} from './src/vault/VaultProvider';
    window.fixtureUser={uid:'${marker}',email:'${marker}@example.test'};
    window.fixtureInitializing=location.pathname==='/sessions/loading';
    function VaultFixture(){window.fixtureVault=useVault();return null;}
    function Fixture(){const [n,setN]=useState(0); window.renderIdentity=u=>{window.fixtureUser=u;setN(n+1)};
      window.fixtureReady=()=>{window.fixtureInitializing=false;setN(n+1)};
      return React.createElement(BrowserRouter,null,React.createElement(ProductAnalytics),location.pathname==='/account' ? React.createElement(VaultProvider,null,React.createElement(VaultFixture)) : null);}
    window.fixtureAction=()=>trackAppAction('/api/sessions/${marker}/automation?password=${marker}','PATCH',true);
    createRoot(document.getElementById('root')).render(React.createElement(StrictMode,null,React.createElement(Fixture)));
  `,resolveDir:join(base,'app'),sourcefile:'posthog-fixture.jsx'},
  plugins:[{name:'auth-test-only',setup(b){
    b.onResolve({filter:/auth\/AuthProvider$/},()=>({path:'test-auth',namespace:'fixture'}));
    b.onResolve({filter:/lib\/api$/},()=>({path:'vault-api',namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='test-auth'
      ? 'export function useAuth(){return {user:window.fixtureUser,initializing:window.fixtureInitializing}}'
      : `let vault=null;export async function fetchVault(){return {vault}};export async function saveVault(bundle){vault={...bundle,version:1,createdAt:Date.now(),updatedAt:Date.now()};return {vault}};export async function fetchSessions(){return {sessions:[]}};export async function shareSessionKeys(){};export async function updateVaultUnlocks(){return {vault}};`,loader:'js'}));
  }}],
});
async function handler({requestId,request}){
  const url=new URL(request.url);
  const reply=(body='',type='text/plain',status=200,extra=[])=>cdp('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:type},{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Allow-Headers',value:'content-type'},...extra],body:Buffer.from(body).toString('base64')});
  if(url.hostname==='us.i.posthog.com'){
    if(request.method==='POST') events.push({phase,payload:JSON.parse(request.postData),headers:request.headers});
    return reply('1'); // Never send synthetic events to the live project.
  }
  if(url.pathname==='/__posthog-fixture.js') return reply(built.outputFiles[0].contents,'text/javascript');
  if(phase.startsWith('fixture') && url.hostname==='app.shell.online' && !url.pathname.startsWith('/assets/')) return reply(`<html><body><div id="root"></div><input type="password" value="${marker}"><div>${marker}</div><script type="module" src="/__posthog-fixture.js"></script></body></html>`,'text/html');
  if(url.hostname==='shell.online' && url.pathname==='/api/events')return reply('', 'text/plain',204);
  if(url.pathname.startsWith('/api/') || url.pathname==='/ws')return reply('{}','application/json',404);
  const root=roots[url.hostname];
  if(root){
    if(live) return cdp('Fetch.continueRequest',{requestId,headers:[...Object.entries(request.headers).map(([name,value])=>({name,value:String(value)})),{name:'Purpose',value:'prefetch'}]});
    let path=resolve(root,'.'+decodeURIComponent(url.pathname));assert(path===root||path.startsWith(root+sep));
    if(url.pathname==='/' || url.pathname.startsWith('/s/') || (url.hostname==='app.shell.online'&&!url.pathname.startsWith('/assets/')))path=join(root,'index.html');
    else if(url.pathname.endsWith('/'))path=join(path,'index.html');
    try{return reply(await readFile(path),mime[extname(path)]??'application/octet-stream');}catch{return reply('not found','text/plain',404);}
  }
  thirdParty.push(url.hostname);
  return cdp('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});
}
try{
  browser=await launchChromeTransport({profile});
  const port=browser.debuggingPort;
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  socket.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error('CDP error')):p.resolve(m.result);}if(m.method==='Fetch.requestPaused')void handler(m.params).catch(e=>errors.push(e.message));};
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  await cdp('Page.enable');
  await cdp('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  phase='landing'; expectedAgents.set(phase, await browser.evaluate('navigator.userAgent')); await browser.navigate(`https://shell.online/?utm_source=x&utm_campaign=${marker}&twclid=${marker}`);
  await wait(()=>events.some(e=>e.phase===phase&&e.payload.event==='$pageview'),'landing capture');
  await browser.call(async()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}});document.querySelector('[data-copy=install]').click();document.querySelector('[data-cta=start_hero]').click();});
  // Engagement/focus events can arrive before the async clipboard result. Wait
  // for the actual interactions, not a total that unrelated events can satisfy.
  await wait(()=>['command_copy','landing_cta'].every(event=>events.some(e=>e.phase==='landing'&&e.payload.event===event)),'copy and CTA');
  await browser.navigate('about:blank');
  await wait(()=>events.some(e=>e.phase==='landing'&&e.payload.event==='$pageleave'),'landing pageleave');
  const landing=events.filter(e=>e.phase==='landing');
  assert.equal(landing.filter(e=>e.payload.event==='$pageview').length,1);
  for(const event of ['command_copy','landing_cta','$pageleave'])assert(landing.some(e=>e.payload.event===event), `landing captured ${event}`);
  assert(landing.every(e=>e.payload.properties.source==='x'));
  reports.push('landing + copy + CTA + pageleave + X attribution');
  phase='docs'; await browser.navigate('https://shell.online/cli/');
  await wait(()=>events.some(e=>e.phase===phase&&e.payload.properties.surface==='docs'),'docs capture');
  assert.equal(events.find(e=>e.phase===phase).payload.distinct_id,landing[0].payload.distinct_id);
  reports.push('docs + same-origin anonymous continuity');
  phase='terminal';await browser.navigate(`https://shell.online/s/abcdefghijklmnopqrstuvwxyz012345#salt=${marker}`);
  await wait(()=>events.some(e=>e.phase===phase&&e.payload.properties.route==='terminal'),'terminal template');
  if (process.env.POSTHOG_SITE_ONLY !== '1') {
  phase='app';await browser.navigate('https://app.shell.online/login');
  await wait(()=>events.some(e=>e.phase===phase&&e.payload.properties.route==='login'),'app production bundle');
  assert.notEqual(events.find(e=>e.phase==='app'&&e.payload.event==='$pageview').payload.distinct_id,landing[0].payload.distinct_id);
  reports.push('terminal + real app login bundle + host-only identities');
  }
  phase='fixture-session';await browser.navigate(`https://app.shell.online/sessions/${marker}?secret=${marker}`);
  await wait(()=>events.some(e=>e.phase===phase&&e.payload.event==='$pageview'),'real React analytics component');
  await delay(50);
  assert.equal(events.filter(e=>e.phase===phase&&e.payload.event==='$pageview').length,1,'StrictMode double counting');
  await browser.evaluate('fixtureAction()');
  await wait(()=>events.some(e=>e.phase===phase&&e.payload.event==='app_action'),'mutation');
  const before=events.length;
  await browser.evaluate("history.pushState({},'', '/game');dispatchEvent(new PopStateEvent('popstate'))");
  await wait(()=>events.slice(before).some(e=>e.payload.event==='$pageview'&&e.payload.properties.surface==='game'),'SPA game navigation');
  assert(events.slice(before).some(e=>e.payload.event==='$pageleave'&&e.payload.properties.route==='session'));
  await browser.evaluate('renderIdentity(null)');
  await wait(()=>events.some(e=>e.phase===phase&&e.payload.event==='signed_out'),'sign out');
  reports.push('StrictMode + private route + game SPA + mutation + logout');
  await browser.navigate('about:blank');await delay(150);
  phase='fixture-loading';await browser.navigate('https://app.shell.online/sessions/loading');
  await wait(()=>browser.evaluate('typeof window.fixtureReady === "function"'),'auth hydration fixture');
  await delay(80);
  assert.equal(events.filter(e=>e.phase===phase&&e.payload.event==='$pageview').length,0,'no transient auth-loading visit');
  await browser.evaluate('fixtureReady()');
  await wait(()=>events.some(e=>e.phase===phase&&e.payload.event==='$pageview'),'hydrated view');
  await browser.evaluate('fixtureReady()');await delay(80);
  assert.equal(events.filter(e=>e.phase===phase&&e.payload.event==='$pageview').length,1,'auth restore counts once');
  reports.push('initial login restoration is not a duplicate visit');
  await browser.navigate('about:blank'); await delay(150);
  phase='fixture-vault'; await browser.navigate('https://app.shell.online/account');
  await wait(()=>browser.evaluate('window.fixtureVault?.status === "setup"'),'real vault provider ready');
  await browser.evaluate('window.fixtureTask = fixtureVault.prepare(false,"SYNTHETIC_PRIVATE_POSTHOG_MARKER").then(p => fixtureVault.commit(p)); void 0');
  await wait(()=>browser.evaluate('window.fixtureVault?.status === "unlocked"'),'real crypto vault creation');
  await browser.evaluate('window.fixtureTask = fixtureVault.lock(); void 0');
  await wait(()=>browser.evaluate('window.fixtureVault?.status === "locked"'),'vault lock');
  await browser.evaluate('window.fixtureTask = fixtureVault.unlockWithPassword("wrong-secret").catch(()=>{}); void 0');
  await wait(()=>events.some(e=>e.phase===phase&&e.payload.properties.operation==='vault_unlock_password'&&e.payload.properties.outcome==='failed'),'wrong password measured without content');
  await browser.evaluate('window.fixtureTask = fixtureVault.unlockWithPassword("SYNTHETIC_PRIVATE_POSTHOG_MARKER"); void 0');
  await wait(()=>browser.evaluate('window.fixtureVault?.status === "unlocked"'),'correct password unlock');
  await wait(()=>events.some(e=>e.phase===phase&&e.payload.properties.operation==='vault_unlock_password'&&e.payload.properties.outcome==='ok'),'actual unlock completion');
  const vaultResults=events.filter(e=>e.phase===phase&&e.payload.event==='feature_result');
  assert.deepEqual(vaultResults.map(e=>[e.payload.properties.operation,e.payload.properties.outcome]),[
    ['vault_create','ok'],['vault_lock','ok'],['vault_unlock_password','failed'],['vault_unlock_password','ok'],
  ]);
  assert.equal(events.filter(e=>e.phase===phase&&e.payload.event==='feature_attempt').length,4);
  reports.push('actual VaultProvider + WebCrypto + IndexedDB: create, lock, wrong/right password, four exact redacted outcomes');
  // Literal scripts only: no input or serialized strings interpolated into code.
  for (const [label, source] of [
    ['safari-ua', "Object.defineProperty(navigator,'userAgent',{get:()=> 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1'});"],
    ['x-browser-ua', "Object.defineProperty(navigator,'userAgent',{get:()=> 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.0'});"],
    ['crawler-ua', "Object.defineProperty(navigator,'userAgent',{get:()=> 'Googlebot/2.1 (+http://www.google.com/bot.html)'});"],
  ]) {
    await browser.navigate('about:blank'); await delay(100);
    phase=label;
    const override=await cdp('Page.addScriptToEvaluateOnNewDocument', { source });
    await browser.navigate('https://shell.online/');
    const userAgent=await browser.evaluate('navigator.userAgent');
    expectedAgents.set(phase, userAgent);
    await wait(()=>events.some(e=>e.phase===phase&&e.payload.event==='$pageview'), label);
    assert.equal(events.filter(e=>e.phase===phase&&e.payload.event==='$pageview').length,1);
    assert.equal(events.find(e=>e.phase===phase&&e.payload.event==='$pageview').payload.properties.$user_agent,userAgent);
    await cdp('Page.removeScriptToEvaluateOnNewDocument',{identifier:override.identifier});
  }
  reports.push('actual Chrome + emulated Safari/X/crawler user agents preserved, one pageview each');
  await browser.navigate('about:blank'); await delay(150);
  phase='optout';
  await cdp('Network.setCookie',{name:'shell_analytics_opt_out',value:'1',url:'https://shell.online/',path:'/',secure:true});
  await browser.navigate('https://shell.online/'); await delay(600);
  assert.equal(events.filter(e=>e.phase===phase&&e.payload.event==='$pageview').length,0);
  await browser.navigate('about:blank'); await delay(150);
  await cdp('Network.deleteCookies',{name:'shell_analytics_opt_out',url:'https://shell.online/'});
  reports.push('saved opt-out blocks browser capture independently of GPC');
  phase='gpc';await cdp('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'globalPrivacyControl',{get:()=>true});"});
  await browser.navigate('https://shell.online/');await delay(600);
  assert.equal(await browser.evaluate('navigator.globalPrivacyControl'),true,'GPC fixture installed before page scripts');
  assert.equal(events.filter(e=>e.phase===phase&&e.payload.event==='$pageview').length,0);
  reports.push('GPC blocks browser capture');
  for(const e of events){assert(!JSON.stringify(e).includes(marker));assert(!e.headers.Referer&&!e.headers.Cookie);assert.equal(e.payload.properties.$process_person_profile,false);
    assert.equal(e.payload.properties.capture_source,'browser');
    assert.equal(e.payload.properties.instrumentation_version,3);
    assert.match(e.payload.properties.$session_id,/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    const sessionStart=Number.parseInt(e.payload.properties.$session_id.replaceAll('-','').slice(0,12),16);
    assert(Date.parse(e.payload.timestamp)>=sessionStart&&Date.parse(e.payload.timestamp)<sessionStart+86400000,'session aggregation timestamp range');
    assert.equal(e.payload.properties.user_agent_status,'present');
    assert.equal(typeof e.payload.properties.browser_automation,'boolean');
    const expected=expectedAgents.get(e.phase)??expectedAgents.get('landing');
    assert.equal(e.payload.properties.$user_agent,expected);
  }
  assert(!thirdParty.some(h=>h.includes('posthog')),'unexpected SDK/replay request');
  assert.deepEqual(errors,[]);
  const result={mode:live?'live':'candidate',passed:reports,events:events.length,secretLeak:false,syntheticEventsSent:0};
  console.log(JSON.stringify(result,null,2));
}finally{
  socket?.close();
  await browser?.close();
  // Chrome helpers can briefly finish profile writes after the parent exits.
  // Retry only this fixture-owned directory; persistent cleanup failure fails.
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
