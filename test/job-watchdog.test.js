import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ScrapeError } from '../src/errors.js';

const secret = 'test-only-not-a-real-secret-00000000';
const config = { ...loadConfig({ SCRAPER_SHARED_SECRET: secret }), timeoutMs: 100, cleanupTimeoutMs: 50, minIntervalMs: 1 };
const credentials = { email: 'mock@example.invalid', password: 'TEST_ONLY_PASSWORD' };
const good = { events: [{ id: 1, title: 'Fixture' }], complete: true, timeZone: 'America/New_York', meta: { truncated: false, totalCollected: 1, returned: 1 } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, scrape, now = Date.now) {
  const lines = []; const { app, cancelActive } = createApp({ config, scrape, now, logger: line => lines.push(line) });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { void cancelActive(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(base + path, { ...options, headers: { authorization: `Bearer ${secret}`, ...options.headers } });
  const start = async (id = randomUUID()) => {
    const response = await request('/api/scrape/jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': id }, body: JSON.stringify(credentials) });
    return { id, response, body: await response.json() };
  };
  const poll = async id => { const response = await request('/api/scrape/jobs/' + id); return { response, body: await response.json() }; };
  return { request, start, poll, lines, cancelActive };
}
test('unsettled scrape becomes terminal TIMEOUT and quarantines all new browser work', async t => {
  let aborted = false, runs = 0;
  const f = await fixture(t, ({ signal, observe }) => { runs++; observe('collect_events'); signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); });
  const started = await f.start(); assert.equal(started.response.status, 202);
  await sleep(config.timeoutMs + config.cleanupTimeoutMs + 40);
  const done = await f.poll(started.id); assert.equal(done.response.status, 200); assert.equal(done.body.error.httpStatus, 504); assert.equal(done.body.status, 'failed'); assert.equal(done.body.error.code, 'TIMEOUT'); assert.equal(done.body.phase, 'collect_events'); assert.equal(aborted, true);
  assert.ok(done.body.finishedAt); assert.equal((await f.request('/health')).status, 503);
  assert.equal((await f.start()).response.status, 503);
  assert.equal((await f.request('/api/diagnostics/browser', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503);
  assert.equal((await f.request('/api/events')).status, 404); assert.equal(runs, 1);
  let settled = false; void f.cancelActive().then(() => { settled = true; }); await sleep(10); assert.equal(settled, false);
  for (const value of [credentials.email, credentials.password, secret]) assert.equal(f.lines.join('\n').includes(value), false);
});
test('late success and late progress cannot mutate cache, terminal status, timestamp or logs', async t => {
  let runs = 0, release, lateObserve, lateCapture;
  const f = await fixture(t, ({ observe, observeCapture }) => {
    if (++runs === 1) return Promise.resolve(good);
    observe('collect_events'); lateObserve = observe; lateCapture = observeCapture;
    return new Promise(resolve => { release = resolve; });
  });
  const first = await f.start(); await sleep(10); const fresh = (await f.poll(first.id)).body.result; assert.equal(fresh.ok, true);
  const second = await f.start(); await sleep(config.timeoutMs + config.cleanupTimeoutMs + 40);
  const failed = (await f.poll(second.id)).body; const logCount = f.lines.length;
  lateObserve('complete'); lateCapture({ privateResponses: 12 }); release({ ...good, events: [{ id: 999, title: 'LATE_RESULT' }] });
  await sleep(10); const after = (await f.poll(second.id)).body;
  assert.equal(after.status, 'failed'); assert.equal(after.finishedAt, failed.finishedAt); assert.equal(after.phase, failed.phase); assert.equal(f.lines.length, logCount);
  const cached = await (await f.request('/api/events')).json(); assert.equal(cached.fetchedAt, fresh.fetchedAt); assert.deepEqual(cached.events, fresh.events);
  assert.equal((await f.request('/health')).status, 503); assert.equal((await f.start()).response.status, 503);
});
test('cooperative deadline abort reports TIMEOUT rather than CANCELLED without unnecessary quarantine', async t => {
  const f = await fixture(t, ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new ScrapeError('CANCELLED', 499)), { once: true })));
  const started = await f.start(); await sleep(config.timeoutMs + 20); const done = await f.poll(started.id);
  assert.equal(done.response.status, 200); assert.equal(done.body.error.httpStatus, 504); assert.equal(done.body.error.code, 'TIMEOUT'); assert.equal((await f.request('/health')).status, 200);
  assert.equal((await f.request('/api/events')).status, 404);
});
test('success after deadline but within cleanup grace is still failure and never fresh', async t => {
  const f = await fixture(t, ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => setTimeout(() => resolve(good), 5), { once: true })));
  const started = await f.start(); await sleep(config.timeoutMs + 25); const done = await f.poll(started.id);
  assert.equal(done.response.status, 200); assert.equal(done.body.error.httpStatus, 504); assert.equal(done.body.error.code, 'TIMEOUT'); assert.equal((await f.request('/api/events')).status, 404);
  assert.equal((await f.request('/health')).status, 200);
});
test('ordinary success clears watchdog timers and is not changed afterward', async t => {
  const f = await fixture(t, async () => good); const started = await f.start(); await sleep(10); const done = await f.poll(started.id);
  assert.equal(done.body.status, 'succeeded'); const logCount = f.lines.length;
  await sleep(config.timeoutMs + config.cleanupTimeoutMs + 20);
  const unchanged = await f.poll(started.id); assert.equal(unchanged.body.status, 'succeeded'); assert.equal(unchanged.body.finishedAt, done.body.finishedAt); assert.equal(f.lines.length, logCount); assert.equal((await f.request('/health')).status, 200);
});
test('elapsed deadline is enforced even if task settles before a delayed timer callback', async t => {
  let time = 1000, release;
  const f = await fixture(t, () => new Promise(resolve => { release = resolve; }), () => time);
  const started = await f.start(); while (!release) await sleep(1);
  time += config.timeoutMs + 1; release(good); await sleep(1);
  const done = await f.poll(started.id); assert.equal(done.response.status, 200); assert.equal(done.body.error.httpStatus, 504); assert.equal(done.body.error.code, 'TIMEOUT'); assert.equal((await f.request('/api/events')).status, 404);
});
