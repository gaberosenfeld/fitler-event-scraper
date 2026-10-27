import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ScrapeError } from '../src/errors.js';
import { JobRegistry, JOB_TTL_MS, MAX_JOB_RESULTS, MAX_JOB_KEYS, isJobId } from '../src/jobs.js';

const secret = 'test-only-not-a-real-secret-00000000';
const config = { ...loadConfig({ SCRAPER_SHARED_SECRET: secret }), minIntervalMs: 1000 };
const credentials = { email: 'mock@example.invalid', password: 'TEST_ONLY_PASSWORD' };
const good = { events: [{ id: 1, title: 'Fixture' }], complete: true, timeZone: 'America/New_York', meta: { truncated: false, totalCollected: 1, returned: 1 } };
const tick = () => new Promise(resolve => setImmediate(resolve));
const post = (id, body = credentials) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...(id ? { 'idempotency-key': id } : {}) }, body: JSON.stringify(body) });
async function fixture(t, scrape, now = Date.now) {
  const lines = [];
  const { app, cancelActive } = createApp({ config, scrape, now, logger: line => lines.push(line) });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { cancelActive(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(base + path, { ...options, headers: { authorization: `Bearer ${secret}`, ...options.headers } });
  return { request, lines, cancelActive };
}
async function terminal(request, id) {
  for (let i = 0; i < 50; i++) {
    const response = await request('/api/scrape/jobs/' + id); const body = await response.json();
    if (body.status !== 'running') return { response, body };
    await tick();
  }
  throw new Error('Fixture job did not settle');
}
test('job IDs are canonical UUIDv4 and registry TTL/tombstones/capacity are bounded', t => {
  assert.equal(isJobId(randomUUID()), true);
  for (const id of ['../secret', 'SECRET', '00000000-0000-0000-0000-000000000000', randomUUID().toUpperCase()]) assert.equal(isJobId(id), false);
  let time = 1000; const registry = new JobRegistry(() => time); const ids = [];
  t.after(() => registry.close());
  for (let i = 0; i < MAX_JOB_KEYS; i++) {
    const id = randomUUID(); ids.push(id); const job = registry.create(id);
    job.status = 'succeeded'; registry.finish(job); time++;
  }
  assert.equal(registry.jobs.size, MAX_JOB_RESULTS); assert.equal(registry.keys.size, MAX_JOB_KEYS);
  assert.equal(registry.find(ids[0]), undefined); assert.equal(registry.seen(ids[0]), true);
  assert.equal(registry.hasCapacity(), false); assert.throws(() => registry.create(randomUUID()));
  assert.throws(() => registry.create(ids.at(-1)));
  time += JOB_TTL_MS; assert.equal(registry.hasCapacity(), true); assert.equal(registry.jobs.size, 0); assert.equal(registry.keys.size, 0);
});
test('running job is not evicted or expired while its browser operation remains active', t => {
  let time = 1000; const registry = new JobRegistry(() => time); const running = registry.create(randomUUID());
  t.after(() => registry.close());
  for (let i = 0; i < MAX_JOB_RESULTS + 2; i++) { const job = registry.create(randomUUID()); job.status = 'failed'; registry.finish(job); }
  assert.equal(registry.find(running.jobId), running);
  time += JOB_TTL_MS * 2; assert.equal(registry.find(running.jobId), running); assert.equal(registry.jobs.size, 1);
});
test('idle registry expires payloads without requests using one unref timer; running jobs survive', () => {
  let time = 1000, unrefs = 0; const timers = new Set();
  const registry = new JobRegistry(() => time, {
    setTimer(callback, delay) { const timer = { callback, delay, unref() { unrefs++; } }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); }
  });
  const running = registry.create(randomUUID()); const first = registry.create(randomUUID());
  first.status = 'succeeded'; first.result = { events: ['PRIVATE_FIXTURE'] }; registry.finish(first);
  assert.equal(timers.size, 1); assert.equal([...timers][0].delay, JOB_TTL_MS);
  time += 100; const second = registry.create(randomUUID()); second.status = 'failed'; registry.finish(second);
  assert.equal(timers.size, 1); assert.equal([...timers][0].delay, JOB_TTL_MS - 100); assert.equal(unrefs, 2);
  time = first.finishedMs + JOB_TTL_MS;
  const timer = [...timers][0]; timers.delete(timer); timer.callback();
  // Direct map inspection is deliberate: no lookup/request is allowed to prune.
  assert.equal(registry.jobs.has(first.jobId), false); assert.equal(registry.keys.has(first.jobId), false);
  assert.equal(registry.jobs.has(running.jobId), true); assert.equal(registry.jobs.has(second.jobId), true);
  assert.equal(timers.size, 1); assert.equal([...timers][0].delay, 100);
  time += 100; const last = [...timers][0]; timers.delete(last); last.callback();
  assert.equal(registry.jobs.size, 1); assert.equal(registry.jobs.has(running.jobId), true); assert.equal(timers.size, 0);
  registry.close(); assert.equal(timers.size, 0);
});
test('expiry timer is unreferenced and shutdown prevents late completion timer leaks', () => {
  const registry = new JobRegistry(); const job = registry.create(randomUUID()); job.status = 'succeeded'; registry.finish(job);
  assert.equal(registry.timer.hasRef(), false); registry.close(); assert.equal(registry.timer, null);
  registry.finish(job); assert.equal(registry.timer, null);
});
test('metadata includes only a valid safe operation UUID for log correlation', () => {
  const registry = new JobRegistry(); const job = registry.create(randomUUID());
  job.requestId = 'PASSWORD_SECRET'; assert.equal(Object.hasOwn(registry.metadata(job), 'requestId'), false);
  job.requestId = randomUUID(); assert.equal(registry.metadata(job).requestId, job.requestId); registry.close();
});
test('async endpoints require bearer, server origin, UUID key and strict credential body', async t => {
  let runs = 0; const { request } = await fixture(t, async () => { runs++; return good; }); const id = randomUUID();
  const health = await (await request('/health', { headers: { authorization: '' } })).json(); assert.equal(health.capabilities.asyncScrapeJobs, true);
  assert.equal((await request('/api/scrape/jobs', { ...post(id), headers: { ...post(id).headers, authorization: '' } })).status, 401);
  assert.equal((await request('/api/scrape/jobs', { ...post(id), headers: { ...post(id).headers, origin: 'https://unapproved.invalid' } })).status, 403);
  assert.equal((await request('/api/scrape/jobs', post())).status, 400);
  assert.equal((await request('/api/scrape/jobs', post('not-a-uuid'))).status, 400);
  assert.equal((await request('/api/scrape/jobs', post(id, { ...credentials, url: 'https://unapproved.invalid' }))).status, 400);
  assert.equal((await request('/api/scrape/jobs', post(id, { ...credentials, password: 'x'.repeat(17000) }))).status, 413);
  assert.equal((await request('/api/scrape/jobs/' + id, { headers: { authorization: '' } })).status, 401);
  assert.equal((await request('/api/scrape/jobs/' + id)).status, 404); assert.equal(runs, 0);
});
test('202 returns before scrape finishes; duplicate keys and recovery GET never start another browser', async t => {
  let release, runs = 0, aborted = false;
  const { request, lines } = await fixture(t, ({ signal, observe }) => {
    runs++; signal.addEventListener('abort', () => { aborted = true; }); observe('collect_events');
    return new Promise(resolve => { release = resolve; });
  }); const id = randomUUID();
  const response = await request('/api/scrape/jobs', post(id)); assert.equal(response.status, 202);
  const started = await response.json(); assert.equal(started.jobId, id); assert.equal(started.status, 'running'); assert.equal(started.phase, 'accepted');
  assert.equal(isJobId(started.requestId), true); assert.equal(started.requestId, response.headers.get('x-scraper-request-id'));
  while (!release) await tick();
  const duplicate = await request('/api/scrape/jobs', post(id, { ...credentials, password: 'DIFFERENT_TEST_PASSWORD' })); assert.equal(duplicate.status, 202); assert.equal((await duplicate.json()).jobId, id); assert.equal(runs, 1);
  const progress = await (await request('/api/scrape/jobs/' + id)).json(); assert.equal(progress.status, 'running'); assert.equal(progress.phase, 'collect_events'); assert.equal(aborted, false);
  assert.equal(progress.requestId, started.requestId);
  assert.equal((await request('/api/scrape/jobs', post(randomUUID()))).status, 409);
  assert.equal((await request('/api/scrape', { ...post(id), headers: { 'content-type': 'application/json' } })).status, 409);
  assert.equal((await request('/api/diagnostics/browser', post(id, {}))).status, 409);
  release(good); const done = await terminal(request, id); assert.equal(done.response.status, 200); assert.equal(done.body.status, 'succeeded'); assert.equal(done.body.result.ok, true); assert.equal(done.body.result.stale, false); assert.ok(done.body.finishedAt);
  assert.equal((await request('/api/scrape/jobs', post(id))).status, 202); assert.equal(runs, 1);
  assert.equal((await request('/api/scrape/jobs', post(randomUUID()))).status, 429);
  for (const value of [secret, credentials.email, credentials.password, 'DIFFERENT_TEST_PASSWORD']) assert.equal(lines.join('\n').includes(value), false);
});
test('POST connection closure does not cancel a job; explicit shutdown does', async t => {
  let aborts = 0, running;
  const { request, cancelActive } = await fixture(t, ({ signal }) => new Promise((_resolve, reject) => {
    running = true; signal.addEventListener('abort', () => { aborts++; reject(new ScrapeError('CANCELLED', 499)); }, { once: true });
  })); const id = randomUUID();
  const controller = new AbortController(); const started = await request('/api/scrape/jobs', { ...post(id), signal: controller.signal }); assert.equal(started.status, 202);
  await started.json(); controller.abort(); while (!running) await tick(); await tick(); assert.equal(aborts, 0);
  assert.equal((await (await request('/api/scrape/jobs/' + id)).json()).status, 'running');
  cancelActive(); const done = await terminal(request, id); assert.equal(done.response.status, 499); assert.equal(done.body.status, 'failed'); assert.equal(done.body.error.code, 'CANCELLED'); assert.equal(aborts, 1);
});
test('shutdown returns a completion promise that waits for detached-job cleanup', async t => {
  let started = false, cleanupFinished = false;
  const { request, cancelActive } = await fixture(t, ({ signal }) => new Promise((_resolve, reject) => {
    started = true;
    signal.addEventListener('abort', () => setTimeout(() => { cleanupFinished = true; reject(new ScrapeError('CANCELLED', 499)); }, 20), { once: true });
  }));
  const id = randomUUID(); await request('/api/scrape/jobs', post(id)); while (!started) await tick();
  let settled = false; const completion = cancelActive().then(() => { settled = true; });
  await tick(); assert.equal(settled, false); assert.equal(cleanupFinished, false);
  await completion; assert.equal(cleanupFinished, true); assert.equal(settled, true);
  const done = await terminal(request, id); assert.equal(done.body.status, 'failed'); assert.equal(done.body.error.code, 'CANCELLED');
  await cancelActive();
});
test('terminal failure preserves non-2xx status and stale cache timestamp; partial success rejected', async t => {
  let time = 1700000000000, calls = 0;
  const { request } = await fixture(t, async () => {
    if (++calls === 1) return good;
    if (calls === 2) throw new ScrapeError('UPSTREAM_AUTH', 401);
    return { ...good, complete: false };
  }, () => time);
  const first = randomUUID(); await request('/api/scrape/jobs', post(first)); const success = await terminal(request, first);
  time += 2000; const second = randomUUID(); await request('/api/scrape/jobs', post(second)); const failure = await terminal(request, second);
  assert.equal(failure.response.status, 401); assert.equal(failure.body.ok, false); assert.equal(failure.body.error.code, 'UPSTREAM_AUTH');
  assert.equal(failure.body.result.ok, false); assert.equal(failure.body.result.stale, true); assert.equal(failure.body.result.fetchedAt, success.body.result.fetchedAt);
  time += 2000; const third = randomUUID(); await request('/api/scrape/jobs', post(third)); const partial = await terminal(request, third); assert.equal(partial.response.status, 502);
  assert.equal((await (await request('/api/events')).json()).fetchedAt, success.body.result.fetchedAt);
});
test('result eviction keeps a tombstone; expiry and restart are unknown without automatic retry', async t => {
  let time = 1700000000000, runs = 0;
  const { request } = await fixture(t, async () => { runs++; return good; }, () => time); const ids = [];
  for (let i = 0; i < 11; i++) { const id = randomUUID(); ids.push(id); await request('/api/scrape/jobs', post(id)); await terminal(request, id); time += 2000; }
  const unknown = await request('/api/scrape/jobs/' + ids[0]); assert.equal(unknown.status, 404); assert.equal((await unknown.json()).error.code, 'JOB_NOT_FOUND');
  const duplicate = await request('/api/scrape/jobs', post(ids[0])); assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).error.code, 'JOB_EXPIRED'); assert.equal(runs, 11);
  time += JOB_TTL_MS; assert.equal((await request('/api/scrape/jobs/' + ids.at(-1))).status, 404);
  const freshProcess = await fixture(t, async () => { throw new Error('MUST_NOT_RUN'); }); assert.equal((await freshProcess.request('/api/scrape/jobs/' + ids.at(-1))).status, 404);
});
test('async cleanup failure quarantines all new browser work and cannot create fresh cache', async t => {
  const { request } = await fixture(t, async () => { const error = new ScrapeError('BROWSER_ERROR', 503); error.phase = 'cleanup'; error.cleanupIncomplete = true; throw error; });
  const id = randomUUID(); await request('/api/scrape/jobs', post(id)); const done = await terminal(request, id); assert.equal(done.response.status, 503); assert.equal(done.body.phase, 'cleanup');
  assert.equal((await request('/api/scrape/jobs', post(randomUUID()))).status, 503); assert.equal((await request('/api/diagnostics/browser', post(id, {}))).status, 503);
  assert.equal((await request('/api/events')).status, 404); assert.equal((await request('/health')).status, 503);
});
