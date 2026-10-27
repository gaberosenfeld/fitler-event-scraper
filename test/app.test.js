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
async function fixture(t,scrape=async()=>good,now=Date.now){
 const {app}=createApp({config,scrape,now});const server=app.listen(0,'127.0.0.1');await once(server,'listening');
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
