import { ScrapeError } from './errors.js';

export async function closeBrowserResources(browser, context, timeoutMs = 10000) {
  // Start both closes; a stuck context must not prevent browser teardown.
  if (context) void context.close().catch(() => {});
  if (!browser) return;
  let timer;
  const closed = await Promise.race([
    browser.close().then(() => true, () => false),
    new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
  ]);
  clearTimeout(timer);
  if (closed) return;
  // Fail closed: the HTTP layer quarantines new browser work until restart.
  // Do not claim a fresh catalog or launch another browser beside this one.
  const error = new ScrapeError('BROWSER_ERROR', 503);
  error.phase = 'cleanup'; error.cleanupIncomplete = true;
  throw error;
}
