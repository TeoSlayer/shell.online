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
  absWorkingDir:join(base,'app'),bundle:true,write:false,format:'esm',platform:'browser',
  stdin:{contents:`
    import React,{StrictMode,useState} from 'react'; import {createRoot} from 'react-dom/client';
    import {BrowserRouter} from 'react-router-dom';
    import {ProductAnalytics} from './src/components/ProductAnalytics';
    import {trackAppAction} from '../web/posthog';
    window.fixtureUser={uid:'${marker}',email:'${marker}@example.test'};
    function Fixture(){const [n,setN]=useState(0); window.renderIdentity=u=>{window.fixtureUser=u;setN(n+1)};
      return React.createElement(BrowserRouter,null,React.createElement(ProductAnalytics));}
    window.fixtureAction=()=>trackAppAction('/api/sessions/${marker}/automation?password=${marker}','PATCH',true);
    createRoot(document.getElementById('root')).render(React.createElement(StrictMode,null,React.createElement(Fixture)));
  `,resolveDir:join(base,'app'),sourcefile:'posthog-fixture.jsx'},
  plugins:[{name:'auth-test-only',setup(b){b.onResolve({filter:/auth\/AuthProvider$/},()=>({path:'test-auth',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export function useAuth(){return {user:window.fixtureUser,initializing:false}}',loader:'js'}));}}],
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
  const port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  socket.onmessage=({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error('CDP error')):p.resolve(m.result);}if(m.method==='Fetch.requestPaused')void handler(m.params).catch(e=>errors.push(e.message));};
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  await cdp('Page.enable');
  await cdp('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  phase='landing'; expectedAgents.set(phase, await browser.evaluate('navigator.userAgent')); await browser.navigate(`https://shell.online/?utm_source=x&utm_campaign=${marker}&twclid=${marker}`);
  await wait(()=>events.some(e=>e.phase===phase&&e.payload.event==='$pageview'),'landing capture');
  await browser.call(async()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}});document.querySelector('[data-copy=install]').click();document.querySelector('[data-cta=start_hero]').click();});
  await wait(()=>events.filter(e=>e.phase===phase).length>=3,'copy and CTA');
  await delay(250); await browser.navigate('about:blank');await delay(150);
  const landing=events.filter(e=>e.phase==='landing');
  assert.equal(landing.filter(e=>e.payload.event==='$pageview').length,1);
  for(const event of ['command_copy','landing_cta','$pageleave'])assert(landing.some(e=>e.payload.event===event));
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
    assert.equal(e.payload.properties.instrumentation_version,2);
    assert.equal(e.payload.properties.user_agent_status,'present');
    assert.equal(typeof e.payload.properties.browser_automation,'boolean');
    const expected=expectedAgents.get(e.phase)??expectedAgents.get('landing');
    assert.equal(e.payload.properties.$user_agent,expected);
  }
  assert(!thirdParty.some(h=>h.includes('posthog')),'unexpected SDK/replay request');
  assert.deepEqual(errors,[]);
  const result={mode:live?'live':'candidate',passed:reports,events:events.length,secretLeak:false,syntheticEventsSent:0};
  console.log(JSON.stringify(result,null,2));
}finally{socket?.close();await browser?.close();await rm(profile,{recursive:true,force:true});}
