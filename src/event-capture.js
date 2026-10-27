import { CatalogCollector, isEventsApi } from './catalog.js';
import { TARGET_ORIGIN } from './config.js';
import { ScrapeError, publicError } from './errors.js';

// The current member app uses this same-origin public fallback when it has no
// customer session. Observe its existence only; never read or collect its body.
function isPublicEventsApi(value) {
  try { const u = new URL(value); return u.origin === TARGET_ORIGIN && /^\/api\/public\/events\/?$/.test(u.pathname) && u.searchParams.get('group') === 'events'; } catch { return false; }
}

export function attachEventCapture(page, { config, max, now = Date.now }) {
  const collector = new CatalogCollector({ ...config, maxEvents: max });
  const pending = new Set(), inFlight = new Set();
  const counts = { privateRequests: 0, privateResponses: 0, parsedResponses: 0, publicResponses: 0, authDenied: 0, failedRequests: 0 };
  let lastActivity = now();
  const increment = key => { counts[key] = Math.min(counts[key] + 1, config.maxApiResponses + 1); };
  const request = value => {
    if (!isEventsApi(value.url())) return;
    increment('privateRequests');
    if (counts.privateRequests > config.maxApiResponses) { collector.error ||= new ScrapeError('PAGINATION_INCOMPLETE'); return; }
    inFlight.add(value); lastActivity = now();
  };
  const requestfinished = value => { inFlight.delete(value); };
  const requestfailed = value => {
    if (isEventsApi(value.url())) {
      increment('failedRequests'); lastActivity = now();
      collector.error ||= new ScrapeError('UPSTREAM_ERROR');
    }
    // Missing pages must not disappear into a superficially settled scroll.
    inFlight.delete(value);
  };
  const response = value => {
    if (isPublicEventsApi(value.url())) { increment('publicResponses'); return; }
    if (!isEventsApi(value.url())) return;
    increment('privateResponses'); lastActivity = now();
    if (counts.privateResponses > config.maxApiResponses) { collector.error ||= new ScrapeError('PAGINATION_INCOMPLETE'); return; }
    const task = (async () => {
      if ([401, 403].includes(value.status())) { increment('authDenied'); throw new ScrapeError('UPSTREAM_AUTH', 401); }
      if (!value.ok()) throw new ScrapeError('UPSTREAM_ERROR');
      const length = Number(await value.headerValue('content-length'));
      if (length > config.maxResponseBytes) throw new ScrapeError('RESPONSE_TOO_LARGE');
      const body = await value.body();
      if (body.length > config.maxResponseBytes) throw new ScrapeError('RESPONSE_TOO_LARGE');
      let data;
      try { data = JSON.parse(body.toString('utf8')); } catch { throw new ScrapeError('API_SCHEMA_CHANGED'); }
      const header = await value.headerValue('pagination');
      let pagination = null;
      if (header) {
        try { pagination = JSON.parse(header); } catch { throw new ScrapeError('API_SCHEMA_CHANGED'); }
        if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) throw new ScrapeError('API_SCHEMA_CHANGED');
      }
      collector.accept(data, value.url(), body.length, pagination);
      increment('parsedResponses');
    })().catch(error => { collector.error ||= publicError(error); }).finally(() => { pending.delete(task); lastActivity = now(); });
    pending.add(task);
  };
  const listeners = { request, requestfinished, requestfailed, response };
  for (const [name, listener] of Object.entries(listeners)) page.on(name, listener);
  return {
    collector,
    snapshot: () => ({ ...counts }),
    quiet: () => pending.size === 0 && inFlight.size === 0 && now() - lastActivity >= 1000,
    active: () => pending.size > 0 || inFlight.size > 0,
    // First response must be fully parsed, not merely requested or received.
    // Polling stays abortable through the page and the outer scrape deadline.
    async waitForFirst(assertActive, inspect = async () => {}) {
      const deadline = now() + config.firstResponseTimeoutMs;
      let nextInspection = now();
      while (counts.parsedResponses === 0) {
        assertActive();
        if (now() >= nextInspection) { await inspect(); nextInspection = now() + 10000; assertActive(); }
        if (now() >= deadline) {
          if (pending.size > 0) throw new ScrapeError('TIMEOUT', 504);
          if (counts.publicResponses > 0 && counts.privateResponses === 0) throw new ScrapeError('UPSTREAM_AUTH', 401);
          if (counts.failedRequests > 0 && counts.privateResponses === 0) throw new ScrapeError('UPSTREAM_ERROR');
          throw new ScrapeError('NO_API_RESPONSES');
        }
        await page.waitForTimeout(100);
      }
      assertActive();
    },
    async drain(assertActive) {
      // Do not finalize with body/header parsing still pending. The enclosing
      // deadline closes the page on cancellation, so no unbounded body wait.
      while (pending.size > 0) { assertActive(); await page.waitForTimeout(100); }
      assertActive();
    },
    detach() { for (const [name, listener] of Object.entries(listeners)) page.off(name, listener); }
  };
}
