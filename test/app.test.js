import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ScrapeError } from '../src/errors.js';
const secret='test-only-not-a-real-secret-00000000';
const config={...loadConfig({SCRAPER_SHARED_SECRET:secret}),minIntervalMs:1000};
const good={events:[{id:1,title:'Mock'}],complete:true,timeZone:'America/New_York',meta:{truncated:false,totalCollected:1,returned:1}};
const body={email:'mock@example.invalid',password:'TEST_ONLY_PASSWORD'};
async function fixture(t,scrape=async()=>good,now=Date.now,logger){
 const {app}=createApp({config,scrape,now,logger});const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 return (path,options={})=>fetch(base+path,{...options,headers:{authorization:`Bearer ${secret}`,...options.headers}});
}
const post=(value=body)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
test('public health; auth, CORS and unsupported URL target fail closed',async t=>{
 let runs=0;const request=await fixture(t,async()=>{runs++;return good});
 assert.equal((await request('/health',{headers:{authorization:''}})).status,200);
 assert.equal((await request('/api/events',{headers:{authorization:''}})).status,401);
 assert.equal((await request('/api/events',{headers:{origin:'https://portal.example'}})).status,403);
 assert.equal((await request('/api/scrape',post({...body,baseUrl:'http://localhost'}))).status,400);
 assert.equal(runs,0);
});
test('JSON, body-size and input limits enforced with no credential echo',async t=>{
 const request=await fixture(t);
 for(const [options,status] of [[{method:'POST',body:'{}'},415],[post({email:'no',password:'x'}),400],[post({...body,max:501}),400],[post({...body,password:'x'.repeat(17000)}),413],[{method:'POST',headers:{'content-type':'application/json'},body:'{"password":"DO_NOT_ECHO"'},400]]){
  const r=await request('/api/scrape',options);assert.equal(r.status,status);assert.equal((await r.text()).includes('DO_NOT_ECHO'),false);
 }
});
test('successful scrape alone changes cache timestamp; failure preserves stale last success',async t=>{
 let time=1700000000000,calls=0;
 const request=await fixture(t,async()=>{if(++calls===1)return good;throw new ScrapeError('LOGIN_FAILED',401)},()=>time);
 assert.equal((await request('/api/events')).status,404);
 const fresh=await (await request('/api/scrape',post())).json();assert.equal(fresh.ok,true);assert.equal(fresh.cached,false);
 time+=2000;
 const r=await request('/api/scrape',post());assert.equal(r.status,401);const failed=await r.json();
 assert.equal(failed.ok,false);assert.equal(failed.cached,true);assert.equal(failed.stale,true);assert.equal(failed.fetchedAt,fresh.fetchedAt);
 const cached=await (await request('/api/events')).json();assert.equal(cached.fetchedAt,fresh.fetchedAt);
});
test('single-flight and per-scrape cooldown prevent duplicate login attempts',async t=>{
 let release;const request=await fixture(t,()=>new Promise(r=>{release=r}));
 const pending=request('/api/scrape',post());while(!release)await new Promise(r=>setTimeout(r,5));
 assert.equal((await request('/api/scrape',post())).status,409);release(good);assert.equal((await pending).status,200);
 assert.equal((await request('/api/scrape',post())).status,429);
});
test('unexpected browser error text and partial results never escape or create cache',async t=>{
 const request=await fixture(t,async()=>{throw new Error('LEAK mock@example.invalid TEST_ONLY_PASSWORD')});
 const r=await request('/api/scrape',post());assert.equal(r.status,502);assert.equal((await r.text()).includes('LEAK'),false);
 assert.equal((await request('/api/events')).status,404);
});
test('partial scraper adapter output is rejected',async t=>{
 const request=await fixture(t,async()=>({...good,complete:false}));
 assert.equal((await request('/api/scrape',post())).status,502);assert.equal((await request('/api/events')).status,404);
});
test('normal POST completion does not cancel running scrape; caught missing API emits JSON and finish metadata',async t=>{
 const lines=[];let cancelled=false;
 const request=await fixture(t,async({signal,observeCapture})=>{
  signal.addEventListener('abort',()=>{cancelled=true});
  await new Promise(resolve=>setTimeout(resolve,50));
  observeCapture({privateResponses:0,publicResponses:1,password:'DO_NOT_LOG'});
  throw new ScrapeError('NO_API_RESPONSES');
 },Date.now,line=>lines.push(line));
 const response=await request('/api/scrape',post());
 assert.equal(response.status,502);assert.match(response.headers.get('content-type'),/^application\/json/);
 assert.equal((await response.json()).error.code,'NO_API_RESPONSES');assert.equal(cancelled,false);
 const logs=lines.map(JSON.parse);const finish=logs.find(row=>row.event==='response_finish');
 assert.equal(finish.httpStatus,502);assert.equal(finish.contentType,'json');assert.equal(finish.responseFinished,true);assert.equal(finish.responseEnded,true);
 assert.ok(logs.some(row=>row.event==='response_close'&&row.responseFinished));
 assert.equal(logs.find(row=>row.event==='event_capture').publicResponses,1);
 for(const privateText of ['DO_NOT_LOG','TEST_ONLY_PASSWORD','mock@example.invalid',secret])assert.equal(lines.join('\n').includes(privateText),false);
});
test('actual client disconnect cancels scrape and logs unfinished response without secrets',async t=>{
 const lines=[];let start,cancelled=false;
 const started=new Promise(resolve=>{start=resolve});
 const request=await fixture(t,async({signal})=>new Promise((_resolve,reject)=>{
  signal.addEventListener('abort',()=>{cancelled=true;reject(new ScrapeError('CANCELLED',499))},{once:true});start();
 }),Date.now,line=>lines.push(line));
 const controller=new AbortController();const pending=request('/api/scrape',{...post(),signal:controller.signal});
 await started;controller.abort();await assert.rejects(pending,{name:'AbortError'});
 for(let i=0;i<100&&!cancelled;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(cancelled,true);const close=lines.map(JSON.parse).find(row=>row.event==='response_close');
 assert.equal(close.responseFinished,false);assert.equal(close.responseDestroyed,true);assert.equal(close.contentType,'none');
});
test('cleanup timeout quarantines new browser work and never writes fresh cache',async t=>{
 let runs=0;
 const request=await fixture(t,async()=>{runs++;const error=new ScrapeError('BROWSER_ERROR',503);error.cleanupIncomplete=true;error.phase='cleanup';throw error;});
 assert.equal((await request('/api/scrape',post())).status,503);
 assert.equal((await request('/api/scrape',post())).status,503);
 assert.equal((await request('/api/diagnostics/browser',post({}))).status,503);
 assert.equal((await request('/api/events')).status,404);
 const health=await request('/health',{headers:{authorization:''}});assert.equal(health.status,503);assert.equal((await health.json()).ok,false);assert.equal(runs,1);
});
