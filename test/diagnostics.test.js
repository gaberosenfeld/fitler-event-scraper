import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { checkBrowserStartup, browserFailure, createOperationLog } from '../src/diagnostics.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
const secret='test-only-not-a-real-secret-00000000';
const config=loadConfig({SCRAPER_SHARED_SECRET:secret});
function fixture({contextError,pageError,probeError}={}) {
 let closes=0,contextCloses=0,networkHandler,wsHandler,launchOptions;
 const page={evaluate:async fn=>{if(probeError)throw probeError;return fn()}};
 const context={setDefaultTimeout(){},route:async(_,handler)=>{networkHandler=handler},routeWebSocket:async(_,handler)=>{wsHandler=handler},newPage:async()=>{if(pageError)throw pageError;return page},close:async()=>{contextCloses++}};
 const browser={newContext:async()=>{if(contextError)throw contextError;return context},version:()=>'156.0.8078.4',close:async()=>{closes++}};
 return {browserType:{launch:async options=>{launchOptions=options;return browser}},check:()=>({closes,contextCloses,launchOptions}),handlers:()=>({networkHandler,wsHandler})};
}
test('classifies known startup failures without returning raw messages',()=>{
 for(const [message,code] of [
  ['No usable sandbox! SECRET_PASSWORD','BROWSER_SANDBOX_UNAVAILABLE'],
  ['Failed to move to new namespace: Operation not permitted SECRET_PASSWORD','BROWSER_SANDBOX_UNAVAILABLE'],
  ["Executable doesn't exist at /private/path SECRET_PASSWORD",'BROWSER_BINARY_MISSING'],
  ['error while loading shared libraries: libnss3.so SECRET_PASSWORD','BROWSER_DEPENDENCIES_MISSING'],
  ['socket() failed: Operation not permitted SECRET_PASSWORD','BROWSER_HOST_RESTRICTION'],
  ['Target page, context or browser has been closed SECRET_PASSWORD','BROWSER_LAUNCH_FAILED']]){
   const error=browserFailure(new Error(message),'browser_launch');assert.equal(error.code,code);assert.equal(error.status,503);assert.equal(error.phase,'browser_launch');assert.equal(error.message.includes('SECRET_PASSWORD'),false);
 }
});
test('credential-free probe starts isolated browser, evaluates blank page, blocks network and closes',async()=>{
 const f=fixture();const phases=[];const result=await checkBrowserStartup({config,browserType:f.browserType,observe:p=>phases.push(p)});
 assert.equal(result.browser.pageEvaluated,true);assert.equal(result.browser.sandboxEnabled,true);assert.equal(f.check().launchOptions.chromiumSandbox,true);
 assert.equal(f.check().closes,1);assert.equal(f.check().contextCloses,1);
 let blocked=false;await f.handlers().networkHandler({abort:()=>{blocked=true}});assert.equal(blocked,true);
 let closed=false;f.handlers().wsHandler({close:()=>{closed=true}});assert.equal(closed,true);
 assert.deepEqual(phases,['browser_import','browser_launch','context_create','page_create','browser_probe','cleanup']);
});
test('context and page failures close acquired browser resources',async()=>{
 for(const [options,code,contexts] of [[{contextError:new Error('RAW_SECRET')},'BROWSER_CONTEXT_FAILED',0],[{pageError:new Error('RAW_SECRET')},'BROWSER_PAGE_FAILED',1],[{probeError:new Error('RAW_SECRET')},'BROWSER_PROBE_FAILED',1]]){
  const f=fixture(options);await assert.rejects(checkBrowserStartup({config,browserType:f.browserType}),{code});assert.equal(f.check().closes,1);assert.equal(f.check().contextCloses,contexts);
 }
});
test('probe cancellation before launch never launches',async()=>{
 const controller=new AbortController();controller.abort();let launched=false;
 await assert.rejects(checkBrowserStartup({config,signal:controller.signal,browserType:{launch:async()=>{launched=true}}}),{code:'CANCELLED'});assert.equal(launched,false);
});
test('safe logging ignores arbitrary phase and replaces arbitrary code',()=>{
 const lines=[];const log=createOperationLog('RAW_SECRET',line=>lines.push(line),()=>100);
 log.phase('browser_launch');log.phase('PASSWORD_FROM_PAGE');log.finish('RAW_SECRET');
 assert.equal(lines.length,2);assert.ok(lines.every(line=>!line.includes('RAW_SECRET')&&!line.includes('PASSWORD_FROM_PAGE')));
 assert.equal(JSON.parse(lines[1]).code,'BROWSER_ERROR');
});
test('HTTP diagnostic is authenticated, rejects credentials, returns JSON 503 and does not create catalog',async t=>{
 const lines=[];let runs=0;
 const {app}=createApp({config,logger:line=>lines.push(line),diagnostic:async({observe})=>{runs++;observe('browser_launch');throw browserFailure(new Error('No usable sandbox! RAW_SECRET'),'browser_launch')}});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(body,auth=secret)=>fetch(base+'/api/diagnostics/browser',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${auth}`},body:JSON.stringify(body)});
 assert.equal((await post({},'bad')).status,401);assert.equal((await post({email:'fake@example.invalid',password:'RAW_SECRET'})).status,400);assert.equal(runs,0);
 const response=await post({});assert.equal(response.status,503);assert.match(response.headers.get('content-type'),/application\/json/);
 const result=await response.json();assert.equal(result.error.code,'BROWSER_SANDBOX_UNAVAILABLE');assert.equal(result.error.phase,'browser_launch');assert.equal(result.version,'1.0.1');assert.equal(response.headers.get('x-scraper-request-id'),result.requestId);
 assert.equal(lines.join('\n').includes('RAW_SECRET'),false);assert.equal(lines.join('\n').includes('fake@example.invalid'),false);
 assert.equal((await fetch(base+'/api/events',{headers:{authorization:`Bearer ${secret}`}})).status,404);
});
test('diagnostic shares single-flight lock and cooldown with real scrape',async t=>{
 let release;
 const {app}=createApp({config,logger:()=>{},diagnostic:()=>new Promise(r=>{release=r})});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const post=(path,body)=>fetch(`http://127.0.0.1:${server.address().port}`+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${secret}`},body:JSON.stringify(body)});
 const pending=post('/api/diagnostics/browser',{});while(!release)await new Promise(r=>setTimeout(r,5));
 assert.equal((await post('/api/scrape',{email:'mock@example.invalid',password:'TEST_ONLY'})).status,409);
 release({diagnostic:'browser-startup',browser:{launched:true}});assert.equal((await pending).status,200);
 assert.equal((await post('/api/diagnostics/browser',{})).status,429);
});
