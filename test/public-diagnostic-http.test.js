import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ScrapeError } from '../src/errors.js';

const secret = 'test-only-not-a-real-secret-00000000';
const config = { ...loadConfig({ SCRAPER_SHARED_SECRET: secret }), minIntervalMs: 1000 };
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function fixture(t, publicDiagnostic, now = Date.now) {
  const lines = [];
  const { app, cancelActive } = createApp({ config, publicDiagnostic, now, logger: line => lines.push(line) });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { cancelActive(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { lines, request: (path, options = {}) => fetch(base + path, { ...options, headers: { authorization: `Bearer ${secret}`, ...options.headers } }) };
}
test('public-page diagnostic rejects credentials, shares browser lock/cooldown, and never writes a catalog', async t => {
  let release, runs = 0;
  const { request } = await fixture(t, () => { runs++; return new Promise(resolve => { release = resolve; }); });
  assert.equal((await request('/api/diagnostics/events', { ...post({}), headers: { ...post({}).headers, authorization: '' } })).status, 401);
  assert.equal((await request('/api/diagnostics/events', post({ email: 'mock@example.invalid', password: 'PRIVATE_PASSWORD' }))).status, 400); assert.equal(runs, 0);
  const health = await (await request('/health')).json(); assert.equal(health.capabilities.publicEventsDiagnostic, true);
  const pending = request('/api/diagnostics/events', post({})); while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request('/api/diagnostics/browser', post({}))).status, 409);
  const body = { email: 'mock@example.invalid', password: 'PRIVATE_PASSWORD' };
  assert.equal((await request('/api/scrape', post(body))).status, 409);
  assert.equal((await request('/api/scrape/jobs', { ...post(body), headers: { ...post(body).headers, 'idempotency-key': randomUUID() } })).status, 409);
  release({ diagnostic: 'public-events-bootstrap', page: { route: 'events', readyState: 'complete', snapshotAvailable: true } });
  assert.equal((await pending).status, 200); assert.equal((await request('/api/events')).status, 404);
  assert.equal((await request('/api/diagnostics/events', post({}))).status, 429); assert.equal(runs, 1);
});
test('public-page diagnostic returns and logs only allowlisted structural evidence on success and failure', async t => {
  let time = 1700000000000, runs = 0;
  const hostile = { route: 'events', readyState: 'complete', scriptRequests: 99999, documentStatus: 200, snapshotAvailable: true, title: 'PRIVATE_TITLE', password: 'PRIVATE_PASSWORD', url: 'https://PRIVATE_URL' };
  const { request, lines } = await fixture(t, async ({ observe }) => {
    observe('events_page');
    if (++runs === 1) return { diagnostic: 'PRIVATE_DIAGNOSTIC', page: hostile, privateText: 'PRIVATE_EXTRA' };
    const error = new ScrapeError('NO_API_RESPONSES'); error.phase = 'events_page'; error.pageEvidence = { ...hostile, route: 'PRIVATE_ROUTE' }; throw error;
  }, () => time);
  const response = await request('/api/diagnostics/events', post({})); const success = await response.json();
  assert.equal(response.status, 200); assert.equal(success.diagnostic, 'public-events-bootstrap'); assert.equal(success.page.scriptRequests, 10000);
  assert.equal(success.page.route, 'events'); assert.equal(success.requestId, response.headers.get('x-scraper-request-id')); assert.ok(success.checkedAt);
  time += 2000; const failedResponse = await request('/api/diagnostics/events', post({})); const failure = await failedResponse.json();
  assert.equal(failedResponse.status, 502); assert.equal(failure.error.code, 'NO_API_RESPONSES'); assert.equal(failure.page.route, 'unknown');
  const all = JSON.stringify([success, failure, lines]); assert.equal(all.includes('PRIVATE_'), false);
  assert.equal((await request('/api/events')).status, 404);
});
