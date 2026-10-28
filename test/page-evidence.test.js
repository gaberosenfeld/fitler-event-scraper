import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachPageEvidence, sanitizePageEvidence, routeCategory } from '../src/page-evidence.js';
import { createOperationLog } from '../src/diagnostics.js';

test('page evidence allowlists enums and capped counts, never arbitrary DOM/network/error data', () => {
  const safe = sanitizePageEvidence({ route:'SECRET_URL',readyState:'SECRET_STATE',documentStatus:'SECRET_STATUS',requests:99999,apiRequests:-3,pageErrors:'SECRET_ERROR',snapshotAvailable:'SECRET',password:'SECRET' });
  assert.equal(safe.requests,10000); assert.equal(safe.apiRequests,0); assert.equal(safe.snapshotAvailable,false); assert.equal(safe.documentStatus,0);
  assert.equal(JSON.stringify(safe).includes('SECRET'),false);
  assert.equal(routeCategory('https://member.fitlerclub.com/events?private=SECRET'),'events');
  assert.equal(routeCategory('https://member.fitlerclub.com/verify-email/SECRET'),'other_same_origin');
  assert.equal(routeCategory('https://unapproved.invalid/SECRET'),'outside_origin');
});
test('safe structural/network evidence distinguishes wrong group, script failure and app/auth responses without reading bodies',async()=>{
  const page=new EventEmitter();page.url=()=> 'https://member.fitlerclub.com/events?private=SECRET';
  page.evaluate=async()=>({readyState:'complete',rootChildren:1,preloadElements:993,visiblePasswordInputs:1,snapshotAvailable:true,rawText:'SECRET'});
  const evidence=attachPageEvidence(page);
  const request=(url,type='fetch',method='GET')=>({url:()=>url,resourceType:()=>type,method:()=>method});
  for(const req of [request('https://member.fitlerclub.com/api/events?group=events'),request('https://member.fitlerclub.com/api/public/events?group=events'),request('https://member.fitlerclub.com/api/events?group=SECRET'),request('https://member.fitlerclub.com/api/events'),request('https://unapproved.invalid/SECRET','script'),request('https://member.fitlerclub.com/api/login','xhr','POST')])page.emit('request',req);
  page.emit('requestfailed',request('https://member.fitlerclub.com/assets/SECRET.js','script'));
  page.emit('response',{url:()=> 'https://member.fitlerclub.com/api/account',status:()=>401,request:()=>request('','fetch'),body:()=>{throw new Error('MUST_NOT_READ')}});
  page.emit('pageerror',new Error('Failed to fetch dynamically imported module SECRET'));
  await evidence.inspect();const snapshot=evidence.snapshot();
  assert.equal(snapshot.matchedPrivateEventRequests,1);assert.equal(snapshot.matchedPublicEventRequests,1);assert.equal(snapshot.eventEndpointsOtherGroup,1);assert.equal(snapshot.eventEndpointsMissingGroup,1);
  assert.equal(snapshot.blockedExternalScripts,1);assert.equal(snapshot.scriptFailures,1);assert.equal(snapshot.apiAuthDenied,1);assert.equal(snapshot.nonGetRequests,1);assert.equal(snapshot.moduleErrors,1);assert.equal(snapshot.preloadElements,993);
  const lines=[];createOperationLog('scrape',line=>lines.push(line)).capture({page:snapshot});assert.equal(lines.join('\n').includes('SECRET'),false);
  evidence.detach();assert.equal(page.listenerCount('request'),0);assert.equal(page.listenerCount('pageerror'),0);
});

test('runtime errors are capped, bootstrap failure category is visible, and stuck DOM inspection is bounded',async()=>{
  const page=new EventEmitter();page.url=()=> 'https://member.fitlerclub.com/events';page.evaluate=()=>new Promise(()=>{});
  const evidence=attachPageEvidence(page,{inspectTimeoutMs:5});
  const req={url:()=> 'https://js.stripe.com/dahlia/stripe.js',resourceType:()=> 'script',method:()=> 'GET'};
  page.emit('request',req);page.emit('requestfailed',req);
  for(let i=0;i<10;i++)page.emit('pageerror',new Error('Failed to load Stripe.js PRIVATE_TEXT'));
  await evidence.inspect();const snapshot=evidence.snapshot();
  assert.equal(snapshot.stripeScriptRequests,1);assert.equal(snapshot.stripeScriptFailures,1);assert.equal(snapshot.blockedExternalScripts,0);
  assert.equal(snapshot.runtimeErrors.length,5);assert.equal(snapshot.runtimeErrors[0].signature,'stripe_load_failed');assert.equal(snapshot.snapshotAvailable,false);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_TEXT'),false);evidence.detach();
});
