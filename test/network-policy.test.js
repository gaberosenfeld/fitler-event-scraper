import test from 'node:test';
import assert from 'node:assert/strict';
import { routeBrowserRequest, STRIPE_BOOTSTRAP_URL } from '../src/network-policy.js';
function mock(url, { type = 'script', method = 'GET', status = 200, mime = 'text/javascript; charset=utf-8', size = 20 } = {}) {
  const calls = [];
  return { calls, route: {
    request: () => ({ url: () => url, resourceType: () => type, method: () => method }),
    continue: async (...args) => calls.push(['continue', ...args]), abort: async (...args) => calls.push(['abort', ...args]),
    fetch: async options => { calls.push(['fetch', options]); return { status: () => status, headers: () => ({ 'content-type': mime, 'set-cookie': 'MUST_NOT_FORWARD' }), body: async () => Buffer.alloc(size), dispose: async () => calls.push(['dispose']) }; },
    fulfill: async options => calls.push(['fulfill', options])
  } };
}
test('only exact verified Stripe bootstrap GET script is fetched; credentials, redirects and response cookies excluded', async () => {
  const { route, calls } = mock(STRIPE_BOOTSTRAP_URL); await routeBrowserRequest(route);
  assert.deepEqual(calls.map(c => c[0]), ['fetch', 'fulfill', 'dispose']);
  assert.equal(calls[0][1].maxRedirects, 0); assert.equal(calls[0][1].timeout, 15000);
  for (const key of ['authorization', 'cookie', 'referer']) assert.equal(calls[0][1].headers[key], '');
  assert.equal(calls[1][1].status, 200); assert.equal(calls[1][1].headers['set-cookie'], undefined);
});
test('all other Stripe requests, queries, credentials, lookalikes, writes and resource types remain blocked', async () => {
  for (const [url, options] of [
    [STRIPE_BOOTSTRAP_URL+'?private=SECRET', {}], ['https://user:SECRET@js.stripe.com/dahlia/stripe.js', {}],
    ['https://js.stripe.com.evil.invalid/dahlia/stripe.js', {}], ['http://js.stripe.com/dahlia/stripe.js', {}],
    ['https://js.stripe.com/v3/controller.html', {type:'document'}], ['https://api.stripe.com/v1/payment_intents', {type:'fetch',method:'POST'}],
    ['https://m.stripe.network/6', {type:'fetch',method:'POST'}], ['https://hooks.stripe.com/redirect', {type:'document'}],
    [STRIPE_BOOTSTRAP_URL,{method:'POST'}], [STRIPE_BOOTSTRAP_URL,{method:'HEAD'}], [STRIPE_BOOTSTRAP_URL,{type:'fetch'}], [STRIPE_BOOTSTRAP_URL,{type:'document'}]
  ]) { const {route,calls}=mock(url,options);await routeBrowserRequest(route);assert.deepEqual(calls,[['abort','blockedbyclient']]); }
});
test('bootstrap redirects, non-script responses and oversized public assets fail closed', async () => {
  for (const options of [{status:302},{status:500},{mime:'text/html'},{size:2*1024*1024+1}]) {
    const {route,calls}=mock(STRIPE_BOOTSTRAP_URL,options);await routeBrowserRequest(route);assert.ok(calls.some(c=>c[0]==='abort'));assert.ok(!calls.some(c=>c[0]==='fulfill'));
  }
});
test('fixed member origin works; credential-free probe still blocks same-origin writes', async () => {
  const main=mock('https://member.fitlerclub.com/api/token',{type:'fetch',method:'POST'});await routeBrowserRequest(main.route);assert.equal(main.calls[0][0],'continue');
  const publicRun=mock('https://member.fitlerclub.com/api/token',{type:'fetch',method:'POST'});await routeBrowserRequest(publicRun.route,{publicOnly:true});assert.equal(publicRun.calls[0][0],'abort');
  const script=mock(STRIPE_BOOTSTRAP_URL);await routeBrowserRequest(script.route,{publicOnly:true});assert.equal(script.calls[1][0],'fulfill');
});
