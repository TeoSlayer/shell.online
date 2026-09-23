// Real account routes/providers, synthetic fetch/identity only. No account,
// relay, analytics, or user session is contacted. Screenshots live outside git.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { launchChromeTransport, launchSafariTransport } from '../../scripts/lib/browser-transport.mjs';
import { auditTextLayout } from '../../scripts/lib/text-layout-audit.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp('/tmp/shell-route-themes-');
const shots = await mkdtemp('/tmp/shell-route-theme-shots-');
const id = 'virtual:appearance-routes';
const source = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BrowserRouter,useNavigate} from 'react-router-dom';
import {SignedInApp} from '/src/App';
import {AuthContext} from '/src/auth/AuthProvider';
import {initializeAppearance} from '/src/lib/appearance';
${['tokens','base','auth','shell','terminal','chat','people','collab','audit','terms','vault','feedback'].map(s => `import '/src/styles/${s}.css';`).join('\n')}
window.fixture={errors:[],unknown:[],variant:'full'};
addEventListener('error',e=>fixture.errors.push(e.message));
addEventListener('unhandledrejection',e=>fixture.errors.push(String(e.reason)));
const you={uid:'qa-owner',orgId:'qa-org',email:'long-account-name-for-layout-verification@example.test',name:'Synthetic teammate '+('W'.repeat(64)),role:'owner',joinedAt:Date.now()};
const members=[you,...Array.from({length:6},(_,i)=>({...you,uid:'member-'+i,email:'teammate-'+i+'@example.test',name:'Teammate '+i,role:'member'}))];
const session={id:'route-test',uid:you.uid,ownerUid:you.uid,orgId:'qa-org',shareUrl:location.origin+'/s/'+'r'.repeat(32),command:'/opt/tools/long-terminal-process --synthetic --path=/workspace/'+('directory/'.repeat(35)),name:'A long session title '+('W'.repeat(64)),readOnly:false,encrypted:true,persistent:false,host:'Synthetic machine',startedAt:Date.now()-60000,mcpTeamAccess:false,dailyBriefingEnabled:false,dailyBriefingTeamAccess:false};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
globalThis.fetch=async(input,init={})=>{
  const u=new URL(typeof input==='string'?input:input.url,location.origin),p=u.pathname;
  if(u.origin!==location.origin){fixture.unknown.push('external');throw Error('External fetch forbidden');}
  if(fixture.variant==='error' && ['/api/sessions','/api/devices','/api/org','/api/audit'].includes(p))return json({error:'Synthetic request unavailable'},503);
  const empty=fixture.variant==='empty';
  if(p==='/api/vault')return json({vault:null});
  if(p==='/api/team-key')return json({teamKey:null,share:null,missing:[],you});
  if(p==='/api/org')return json({organization:{id:'qa-org',name:'Synthetic team',createdAt:Date.now()},you,members,invites:[]});
  if(p==='/api/notifications')return json({notifications:[],unread:0,unreadAssignments:0,members});
  if(p==='/api/sessions')return json({sessions:empty?[]:Array.from({length:8},(_,i)=>({...session,id:i?'session-'+i:'route-test',relayStatus:['connected','unknown','waiting','disconnected'][i%4],readOnly:i%2===1})),members,you});
  if(p==='/api/sessions/route-test')return json({session,members,you,comments:[{id:'comment',sessionId:session.id,authorUid:you.uid,body:'Synthetic comment with a long unbroken path /workspace/'+('directory/').repeat(12),at:Date.now(),mentions:[]}]});
  if(p.endsWith('/content'))return json({},404);
  if(p==='/api/devices')return json({devices:empty?[]:Array.from({length:4},(_,i)=>({id:'device-'+i,label:'A-long-machine-name-for-layout-'+i,createdAt:Date.now()-360000,lastSeenAt:Date.now(),agentSeenAt:Date.now(),harnesses:['codex','opencode']}))});
  if(p==='/api/audit')return json({events:[],total:0,page:1,limit:50});
  fixture.unknown.push(p);return json({},404);
};
globalThis.WebSocket=class extends EventTarget{readyState=0;send(){}close(){this.readyState=3;}};
navigator.sendBeacon=()=>{fixture.unknown.push('beacon');return false;};
initializeAppearance();
function Fixture(){
  const [signedIn,setSignedIn]=useState(true);fixture.signIn=setSignedIn;fixture.navigate=useNavigate();
  const auth={mode:'firebase',user:signedIn?{uid:you.uid,email:you.email,displayName:you.name,emailVerified:true,providerData:[]}:null,initializing:false,signIn:async()=>{},signUp:async()=>{},signInWithGoogle:async()=>{},signInWithProvider:async()=>{},resetPassword:async()=>{},resendVerification:async()=>{},signOutUser:async()=>{},deleteAccount:async()=>{}};
  return React.createElement(AuthContext.Provider,{value:auth},React.createElement(SignedInApp));
}
history.replaceState(null,'','/account');
createRoot(document.body.appendChild(document.createElement('div'))).render(React.createElement(BrowserRouter,null,React.createElement(Fixture)));
`;
const server = await createServer({
  // Other browser canaries use different module stubs/defines. Their optimizer
  // must not invalidate this fixture's imported chunks while it is running.
  root, cacheDir: join(temp,'vite-cache'), logLevel: 'error', server: {host:'127.0.0.1',port:0,hmr:false},
  define: {'import.meta.env.VITE_ACCOUNTS_URL':JSON.stringify('')},
  plugins: [{name:'appearance-routes',enforce:'pre',
    resolveId(specifier,importer){
      if(specifier===id)return '\0'+id+'.jsx';
      if(specifier==='./firebase' && importer?.endsWith('/src/lib/api.ts'))return join(root,'scripts/fixtures/firebase-stub.ts');
      return null;
    },
    load(specifier){if(specifier==='\0'+id+'.jsx')return source;},
  }],
});
let browser;
const until=async(expression,label)=>{for(let i=0;i<160;i++){if(await browser.evaluate(expression))return;await delay(50);}throw Error('Timeout: '+label);};
async function choose(theme){
  await browser.evaluate(`fixture.navigate('/account')`);
  await until(`!!document.querySelector('[aria-label="Color theme"]')`,'theme selector');
  await browser.call(value=>{
    const select=document.querySelector('[aria-label="Color theme"]');
    select.value=value;
    select.dispatchEvent(new Event('change',{bubbles:true}));
  },theme);
  await delay(80);
}
async function inspect(label,theme){
  await delay(160);
  const result=await browser.evaluate(`(()=>{
    const scale=innerWidth/document.documentElement.getBoundingClientRect().width;
    const c=document.querySelector('.shell-content')||document.body;
    const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left*scale,right:r.right*scale,top:r.top*scale,bottom:r.bottom*scale};};
    const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.checkVisibility({checkVisibilityCSS:true});};
    const controls=[...new Set([...c.querySelectorAll('button,input,select,textarea'),...document.querySelectorAll('[role="dialog"] button,[role="dialog"] input,[role="dialog"] textarea')])].filter(visible).map(e=>({...rect(e),name:(e.getAttribute('aria-label')||e.textContent||e.type).slice(0,80)}));
    return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,paper:getComputedStyle(document.body).backgroundColor,scheme:getComputedStyle(document.documentElement).colorScheme,shadowInk:getComputedStyle(document.documentElement).getPropertyValue('--shadow-ink').trim(),controls,errors:fixture.errors,unknown:fixture.unknown};
  })()`);
  const offscreen=result.controls.filter(r=>r.left < -2 || r.right > result.width+2);
  if(result.overflow || offscreen.length) {
    await writeFile(join(shots,'failure.png'),Buffer.from(await browser.screenshot(),'base64'));
    console.error(await browser.evaluate(`(()=>{const scale=innerWidth/document.documentElement.getBoundingClientRect().width;return [...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.right*scale>innerWidth+2}).slice(0,15).map(e=>({tag:e.tagName,className:e.getAttribute('class'),right:e.getBoundingClientRect().right*scale}));})()`));
  }
  assert(!result.overflow,label+' page overflow; screenshot '+shots);
  assert.deepEqual(offscreen,[],label+' controls fit horizontally; screenshot '+shots);
  assert.equal(result.scheme,theme,label+' color scheme');
  assert.equal(result.paper,theme==='dark'?'rgb(22, 25, 20)':'rgb(243, 241, 233)',label+' brand surface');
  assert.equal(result.shadowInk,theme==='dark'?'#000':'#1a1f16',label+' shadows stay dark, never text-colored glow');
  assert.deepEqual(result.errors,[],label+' browser errors');
  assert.deepEqual(result.unknown,[],label+' unexpected requests');
  const labels = await browser.call(auditTextLayout, {
    selectors: ['.topbar-title','.detail-name','.detail-status','.detail-command-full','.table-name','.table-status','.person-name','.member-name','.device-label','.role-badge','.status-badge','.account-pop-name','.picker-label','.comment-head b','.comment-head time'],
    groups: ['.detail-title','.detail-head','.comment-head'], complete: ['.detail-status','.role-badge','.status-badge'],
  });
  assert.deepEqual(labels,[],label+' label/badge bounds');
  console.log('PASS '+label+' '+result.width+'x'+result.height+' '+theme);
}
try{
  await server.listen();
  const origin='http://127.0.0.1:'+server.httpServer.address().port;
  browser=process.env.SHELL_BROWSER==='safari'?await launchSafariTransport():await launchChromeTransport({profile:join(temp,'profile')});
  const mount=async()=>{
    await browser.navigate(origin+'/scripts/fixtures/route-test.html');
    await until(`location.origin===${JSON.stringify(origin)} && document.readyState==='complete'`,'fixture page');
    const loaded = await browser.evaluate(`import('/@id/__x00__${id}.jsx').then(()=>true,e=>String(e))`);
    assert.equal(loaded,true,'local route fixture module: '+loaded);
    await until(`!!document.querySelector('[aria-label="Color theme"]')`,'real account');
  };
  await mount();
  for(const theme of ['light','dark']){
    await choose(theme);
    for(const [width,height] of [[1440,900],[1024,768],[901,700],[900,700],[761,700],[760,700],[640,700],[390,844],[320,640],[844,390],[667,375]]){
      await browser.setViewport({width,height,dpr:1,mobile:false});
      for(const [path,ready] of [['/account','.account-rows'],['/sessions','.table-subject'],['/sessions/route-test','.detail-name'],['/machines','.device-label'],['/team','.team-name'],['/audit','.filters']]){
        await browser.evaluate('fixture.navigate('+JSON.stringify(path)+')');
        await until(`location.pathname===${JSON.stringify(path)} && !!document.querySelector(${JSON.stringify(ready)})`,'route '+path);
        if(path==='/audit')await browser.evaluate(`document.querySelector('.audit-filter-more').open=true`);
        if(path==='/sessions/route-test')await browser.evaluate(`document.querySelector('.detail-command-details').open=true`);
        await inspect(path,theme);
        if(path==='/audit')assert(await browser.evaluate(`(()=>{const k=document.querySelector('.audit-reading-key');if(!k)return false;const r=k.getBoundingClientRect();return [...k.children].every(e=>e.getBoundingClientRect().bottom<=r.bottom+1);})()`),'Audit reading key contains its wrapped text');
      }
      await writeFile(join(shots,theme+'-'+width+'-'+height+'.png'),Buffer.from(await browser.screenshot(),'base64'));
    }
    for(const [width,height] of [[320,640],[390,844],[844,390],[1440,900]]){
      await browser.setViewport({width,height,dpr:1,mobile:false});
      await browser.evaluate(`fixture.navigate('/account')`);
      await until(`!!document.querySelector('.vault-panel-actions button')`,'vault setup action');
      await browser.evaluate(`document.querySelector('.vault-panel-actions button').click()`);
      await until(`!!document.querySelector('.vault-panel-unlock')`,'vault setup form');
      await inspect('vault form',theme);
      await browser.evaluate(`fixture.navigate('/feedback')`);
      await until(`!!document.querySelector('.feedback-sheet')`,'feedback dialog');
      await inspect('feedback dialog',theme);
      const dialog=await browser.evaluate(`(()=>{const d=document.querySelector('.feedback-sheet'),r=d.getBoundingClientRect(),scale=innerWidth/document.documentElement.getBoundingClientRect().width;return {left:r.left*scale,right:r.right*scale,top:r.top*scale,bottom:r.bottom*scale,width:innerWidth,height:innerHeight,focused:d.contains(document.activeElement)};})()`);
      await writeFile(join(shots,theme+'-feedback-'+width+'.png'),Buffer.from(await browser.screenshot(),'base64'));
      assert(dialog.left>=0&&dialog.right<=dialog.width+2&&dialog.top>=0&&dialog.bottom<=dialog.height+2,'Feedback fits the viewport: '+JSON.stringify(dialog)+' screenshots '+shots);
      assert(dialog.focused,'Feedback places keyboard focus inside the dialog');
      await browser.evaluate(`(()=>{const body=document.querySelector('.feedback-form');body.scrollTop=body.scrollHeight;})()`);
      await delay(80);
      assert(await browser.evaluate(`(()=>{const d=document.querySelector('.feedback-sheet').getBoundingClientRect(),b=document.querySelector('.feedback-sheet [type="submit"]').getBoundingClientRect();return b.bottom<=d.bottom+1&&b.top>=d.top;})()`),'Feedback send action remains reachable by scrolling');
      await browser.evaluate(`document.querySelector('.feedback-sheet [aria-label="Close"]').click()`);
      await until(`!document.querySelector('.feedback-sheet')`,'feedback dismissed');
      await browser.evaluate(`fixture.navigate('/sessions')`);
      await until(`!!document.querySelector('.new-session')`,'new session action');
      await browser.evaluate(`document.querySelector('.new-session').click()`);
      await until(`!!document.querySelector('[role="dialog"] .sheet-form')`,'new session form');
      await inspect('new session dialog',theme);
      assert(await browser.evaluate(`(()=>{const d=document.querySelector('[role="dialog"]'),r=d.getBoundingClientRect(),scale=innerWidth/document.documentElement.getBoundingClientRect().width;return r.top>=0&&r.bottom*scale<=innerHeight+2;})()`),'New session dialog fits');
      await browser.evaluate(`(()=>{const body=document.querySelector('[role="dialog"] .sheet-body');body.scrollTop=body.scrollHeight;})()`);
      await delay(80);
      assert(await browser.evaluate(`(()=>{const d=document.querySelector('[role="dialog"]').getBoundingClientRect(),b=document.querySelector('[role="dialog"] [type="submit"]').getBoundingClientRect();return b.bottom<=d.bottom+1&&b.top>=d.top;})()`),'Start action remains reachable without submitting');
      await browser.evaluate(`document.querySelector('[role="dialog"] .sheet-close').click()`);
      await until(`!document.querySelector('[role="dialog"]')`,'new session dismissed');
    }
    for(const variant of ['empty','error']){
      await browser.evaluate(`fixture.variant='${variant}'`);
      for(const path of ['/machines','/sessions','/team']){
        await browser.evaluate(`fixture.navigate('/account')`);await delay(60);
        await browser.evaluate('fixture.navigate('+JSON.stringify(path)+')');
        await inspect(variant+path,theme);
      }
    }
    await browser.evaluate(`fixture.variant='full'`);
    // Persistence is through the real preference, not a test-only CSS attribute.
    await mount();
    assert.equal(await browser.evaluate(`document.querySelector('[aria-label="Color theme"]').value`),theme);
    await inspect('restored preference',theme);
    await browser.evaluate(`(()=>{fixture.signIn(false);fixture.navigate('/login');})()`);
    await until(`!!document.querySelector('input[type="email"]')`,'login');
    await inspect('login',theme);
    await browser.evaluate(`fixture.navigate('/reset')`);await inspect('password reset',theme);
    await browser.evaluate(`fixture.navigate('/signup')`);await inspect('signup',theme);
    await browser.evaluate(`(()=>{fixture.signIn(true);fixture.navigate('/account');})()`);
  }
  await choose('system');
  if(browser.setEmulatedTheme){
    for(const theme of ['light','dark','light']){await browser.setEmulatedTheme(theme);await inspect('system follows '+theme,theme);}
  }else{
    const system=await browser.evaluate(`matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'`);
    await inspect('native system preference',system);
  }
  assert.deepEqual(await browser.evaluate('fixture.unknown'),[],'No unexpected API / external requests');
  console.log('Screenshots: '+shots);
}finally{await browser?.close();await server.close();await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
