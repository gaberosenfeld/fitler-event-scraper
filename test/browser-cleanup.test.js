import test from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowserResources } from '../src/browser-cleanup.js';

test('browser teardown proceeds even if context close stalls', async () => {
  let closed = false;
  await closeBrowserResources({ close: async () => { closed = true; } }, { close: () => new Promise(() => {}) }, 10);
  assert.equal(closed, true);
});
test('unresponsive or rejected browser close fails closed within bounded cleanup', async () => {
  for (const close of [() => new Promise(() => {}), async () => { throw new Error('DO_NOT_LEAK'); }]) {
    await assert.rejects(closeBrowserResources({ close }, undefined, 10), error => error.code === 'BROWSER_ERROR' && error.status === 503 && error.phase === 'cleanup' && error.cleanupIncomplete === true && !error.message.includes('DO_NOT_LEAK'));
  }
});
