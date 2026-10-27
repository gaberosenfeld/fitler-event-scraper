import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachEventCapture } from '../src/event-capture.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ SCRAPER_SHARED_SECRET: 'test-only-not-a-real-secret-00000000' });
const privateUrl = 'https://member.fitlerclub.com/api/events?group=events&pageSize=10';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const page = new EventEmitter(); let time = 0;
  page.waitForTimeout = async ms => { time += ms; await tick(); };
  const capture = attachEventCapture(page, { config, max: 500, now: () => time });
  const active = () => { if (capture.collector.error) throw capture.collector.error; };
  return { page, capture, active };
}
test('does not read login, foreign-origin, or public event response bodies', async () => {
  const { page, capture } = fixture(); let read = 0;
  for (const url of ['https://member.fitlerclub.com/api/login', 'https://unapproved.invalid/api/events?group=events', 'https://member.fitlerclub.com/api/public/events?group=events']) {
    page.emit('response', { url: () => url, body: async () => { read++; throw new Error('PRIVATE_LOGIN_BODY'); } });
  }
  await tick(); assert.equal(read, 0); assert.equal(capture.snapshot().publicResponses, 1);
  assert.equal(capture.collector.responses, 0); capture.detach();
  assert.equal(page.listenerCount('response'), 0);
});
test('drain waits for all pending body parsing and bounded response count applies before body reads', async () => {
  const { page, capture, active } = fixture(); let release;
  const response = { url: () => privateUrl, status: () => 200, ok: () => true, headerValue: async () => null, body: () => new Promise(resolve => { release = () => resolve(Buffer.from('[]')); }) };
  page.emit('response', response); await tick();
  let drained = false; const pending = capture.drain(active).then(() => { drained = true; });
  await tick(); assert.equal(drained, false); release(); await pending;
  assert.equal(capture.collector.finish().rawEvents.length, 0);
  let bodyReads = 0;
  for (let i = 0; i < config.maxApiResponses; i++) page.emit('response', { ...response, body: async () => { bodyReads++; return Buffer.from('[]'); } });
  await tick(); assert.equal(bodyReads, config.maxApiResponses - 1);
  assert.equal(capture.collector.error.code, 'PAGINATION_INCOMPLETE'); capture.detach();
});
test('failed private event request cannot be ignored as a complete empty catalog', () => {
  const { page, capture } = fixture(); const request = { url: () => privateUrl };
  page.emit('request', request); page.emit('requestfailed', request);
  assert.equal(capture.snapshot().failedRequests, 1);
  assert.throws(() => capture.collector.finish(), { code: 'UPSTREAM_ERROR' }); capture.detach();
});
