import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { checkPublicEventsBootstrap } from '../src/public-events-diagnostic.js';
import { loadConfig, EVENTS_URL } from '../src/config.js';

const config=loadConfig({SCRAPER_SHARED_SECRET:'test-only-not-a-real-secret-00000000'});
function fixture({withEvent=false}={}){
 let time=0,contextClosed=0,browserClosed=0,routeHandler,wsHandler;
 const navigation=[];const page=new EventEmitter();page.url=()=>EVENTS_URL;
 page.goto=async url=>{navigation.push(url);if(withEvent)page.emit('request',{url:()=> 'https://member.fitlerclub.com/api/public/events?group=events',resourceType:()=> 'fetch',method:()=> 'GET'});};
 page.evaluate=async()=>({readyState:'complete',rootChildren:1,preloadElements:993,snapshotAvailable:true});
 page.waitForTimeout=async ms=>{time+=ms;};
 const context={setDefaultTimeout(){},setDefaultNavigationTimeout(){},route:async(_,fn)=>{routeHandler=fn},routeWebSocket:async(_,fn)=>{wsHandler=fn},newPage:async()=>page,close:async()=>{contextClosed++}};
 const browser={newContext:async()=>context,close:async()=>{browserClosed++}};
 return{browserType:{launch:async()=>browser},now:()=>time,state:()=>({time,contextClosed,browserClosed,navigation,routeHandler,wsHandler})};
}
test('credential-free public bootstrap visits only fixed events page and returns structural evidence, not catalog',async()=>{
 const f=fixture({withEvent:true});const result=await checkPublicEventsBootstrap({config,...f});
 assert.equal(result.diagnostic,'public-events-bootstrap');assert.equal(result.page.matchedPublicEventRequests,1);assert.equal(result.events,undefined);
 assert.deepEqual(f.state().navigation,[EVENTS_URL]);assert.equal(f.state().contextClosed,1);assert.equal(f.state().browserClosed,1);
 for(const [url,method,type,expected] of [['https://member.fitlerclub.com/assets/app.js','GET','script','continue'],['https://member.fitlerclub.com/api/token','POST','xhr','abort'],['https://unapproved.invalid/script.js','GET','script','abort'],['https://member.fitlerclub.com/image.png','GET','image','abort']]){
  let action;await f.state().routeHandler({request:()=>({url:()=>url,method:()=>method,resourceType:()=>type}),continue:()=>{action='continue'},abort:()=>{action='abort'}});assert.equal(action,expected);
 }
});
test('no event requests yields bounded observation, not fabricated empty-catalog success',async()=>{
 const f=fixture();const result=await checkPublicEventsBootstrap({config,...f});assert.equal(result.page.matchedPublicEventRequests,0);assert.equal(result.events,undefined);assert.equal(f.state().time,30000);
});
test('already cancelled public bootstrap never launches browser',async()=>{
 const controller=new AbortController();controller.abort();let launched=false;
 await assert.rejects(checkPublicEventsBootstrap({config,signal:controller.signal,browserType:{launch:async()=>{launched=true}}}),{code:'CANCELLED'});assert.equal(launched,false);
});
