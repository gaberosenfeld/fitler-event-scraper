import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { scrapeEvents } from '../src/scraper.js';
import { loadConfig, EVENTS_URL } from '../src/config.js';
const config=loadConfig({SCRAPER_SHARED_SECRET:'test-only-not-a-real-secret-00000000'});
function mockBrowser({pages=[[{id:1,title:'Mock',start_date:'2026-10-27T18:00:00Z'}]],headers=[{totalCount:1,hasNextPage:false}],loginFail=false,noApi=false,status=200}={}){
 let time=0,current='',pageIndex=0,contextClosed=0,browserClosed=0;
 const page=new EventEmitter();
 page.url=()=>current;
 page.locator=()=>({filter(){return this},first(){return this},waitFor:async()=>{},fill:async()=>{},click:async()=>{}});
 page.waitForURL=async()=>{if(loginFail)throw new Error('bad secret');current='https://member.fitlerclub.com/';};
 async function emitPage(){
  if(noApi||pageIndex>=pages.length)return;
  const index=pageIndex++;const url=`https://member.fitlerclub.com/api/events?group=events&pageNumber=${index+1}`;
  const response={url:()=>url,status:()=>status,ok:()=>status===200,headerValue:async name=>name==='pagination'?JSON.stringify(headers[index]):null,body:async()=>Buffer.from(JSON.stringify(pages[index]))};
  page.emit('response',response);await new Promise(r=>setImmediate(r));
 }
 page.goto=async url=>{current=url;if(url===EVENTS_URL)await emitPage()};
 page.evaluate=async fn=>fn.toString().includes('atBottom')?{height:1000+pageIndex*100,atBottom:true}:undefined;
 page.waitForTimeout=async ms=>{time+=ms;await emitPage()};
 const context={setDefaultTimeout(){},setDefaultNavigationTimeout(){},route:async()=>{},routeWebSocket:async()=>{},newPage:async()=>page,close:async()=>{contextClosed++}};
 const browser={newContext:async()=>context,close:async()=>{browserClosed++}};
 return {browserType:{launch:async()=>browser},now:()=>time,closed:()=>({contextClosed,browserClosed})};
}
async function run(mock){return scrapeEvents({email:'mock@example.invalid',password:'TEST_ONLY',max:500,config,...mock})}
test('mock browser login + multi-page response capture + completed scroll + cleanup',async()=>{
 const mock=mockBrowser({pages:[[{id:1,title:'One'}],[{id:2,title:'Two'}]],headers:[{totalCount:2,hasNextPage:true},{totalCount:2,hasNextPage:false}]});
 const result=await run(mock);assert.equal(result.events.length,2);assert.equal(result.complete,true);assert.deepEqual(mock.closed(),{contextClosed:1,browserClosed:1});
});
test('genuine empty API response succeeds and closes browser',async()=>{
 const mock=mockBrowser({pages:[[]],headers:[{totalCount:0,hasNextPage:false}]});assert.equal((await run(mock)).events.length,0);assert.equal(mock.closed().browserClosed,1);
});
test('no API response, login failure, API authentication and partial pagination are distinct',async()=>{
 for(const [options,code] of [[{noApi:true},'NO_API_RESPONSES'],[{loginFail:true},'LOGIN_FAILED'],[{status:401},'UPSTREAM_AUTH'],[{headers:[{totalCount:2,hasNextPage:true}]},'PAGINATION_INCOMPLETE']]){
  const mock=mockBrowser(options);await assert.rejects(run(mock),{code});assert.equal(mock.closed().browserClosed,1);assert.equal(mock.closed().contextClosed,1);
 }
});
test('launch/context failures do not leak credentials and close acquired resources',async()=>{
 let closed=false;const mock={browserType:{launch:async()=>({newContext:async()=>{throw new Error('TEST_ONLY_PASSWORD')},close:async()=>{closed=true}})}};
 await assert.rejects(run(mock),error=>error.code==='BROWSER_CONTEXT_FAILED'&&!error.message.includes('TEST_ONLY_PASSWORD'));assert.equal(closed,true);
});
test('already aborted request never launches Chromium',async()=>{
 const controller=new AbortController();controller.abort();let launched=false;
 await assert.rejects(scrapeEvents({email:'x',password:'x',max:1,config,signal:controller.signal,browserType:{launch:async()=>{launched=true}}}),{code:'CANCELLED'});assert.equal(launched,false);
});
test('deadline during browser launch is reported as timeout and closes late browser',async()=>{
 let closed=false;
 await assert.rejects(scrapeEvents({email:'mock@example.invalid',password:'TEST_ONLY',max:1,config:{...config,timeoutMs:1},browserType:{launch:async()=>{await new Promise(r=>setTimeout(r,10));return {close:async()=>{closed=true}}}}}),{code:'TIMEOUT'});
 assert.equal(closed,true);
});
