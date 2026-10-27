import { selectors } from './selectors.js';
import { CatalogCollector, isEventsApi } from './catalog.js';
import { LOGIN_URL, EVENTS_URL, TARGET_ORIGIN, TIME_ZONE } from './config.js';
import { mapEvent } from './events.js';
import { ScrapeError, publicError } from './errors.js';

async function firstVisible(page, candidates, timeout = 8000) {
  // Combined locator races alternatives instead of multiplying per-selector timeouts.
  const locator = page.locator(candidates.join(', ')).filter({ visible: true }).first();
  await locator.waitFor({ state: 'visible', timeout });
  return locator;
}
function checkTarget(page) {
  const u = new URL(page.url());
  if (u.origin !== TARGET_ORIGIN) throw new ScrapeError('TARGET_BLOCKED');
  if (/^\/login(?:\/|$)/i.test(u.pathname)) throw new ScrapeError('LOGIN_FAILED', 401);
}

export async function scrapeEvents({ email, password, max, config, signal, browserType, now = Date.now }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new ScrapeError('TIMEOUT', 504)), config.timeoutMs);
  const onExternalAbort = () => controller.abort(new ScrapeError('CANCELLED', 499));
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (signal?.aborted) onExternalAbort();
  let browser, context, page, collector;
  const abortBrowser = () => { void browser?.close().catch(() => {}); };
  controller.signal.addEventListener('abort', abortBrowser, { once: true });
  const assertActive = () => { if (controller.signal.aborted) throw controller.signal.reason; if (collector?.error) throw collector.error; };
  try {
    assertActive();
    const chromium = browserType || (await import('playwright')).chromium;
    browser = await chromium.launch({ headless: config.headless, chromiumSandbox: config.chromiumSandbox, timeout: 15000, args: ['--disable-dev-shm-usage'] });
    assertActive();
    context = await browser.newContext({ timezoneId: TIME_ZONE, acceptDownloads: false, serviceWorkers: 'block' });
    context.setDefaultTimeout(8000);
    context.setDefaultNavigationTimeout(20000);
    // Fixed origin, not an arbitrary URL proxy. Images/fonts/media are unnecessary.
    await context.route('**/*', route => {
      const request = route.request();
      let allowed = false;
      try { allowed = new URL(request.url()).origin === TARGET_ORIGIN && !['image', 'font', 'media'].includes(request.resourceType()); } catch {}
      return allowed ? route.continue() : route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    page = await context.newPage();
    page.on('popup', popup => { void popup.close(); });
    // Login uses the uploaded build's two-step form and selector fallbacks.
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    try {
      await (await firstVisible(page, selectors.login.emailInput)).fill(email);
      await (await firstVisible(page, selectors.login.emailNextButton)).click();
      await (await firstVisible(page, selectors.login.passwordInput)).fill(password);
    } catch { assertActive(); throw new ScrapeError('LOGIN_CHANGED'); }
    // Do not retain credentials in scraper locals after they enter the isolated page.
    email = undefined; password = undefined;
    try {
      await (await firstVisible(page, selectors.login.loginButton)).click();
      await page.waitForURL(url => url.origin === TARGET_ORIGIN && !/^\/login(?:\/|$)/i.test(url.pathname), { timeout: 15000 });
    } catch { assertActive(); throw new ScrapeError('LOGIN_FAILED', 401); }
    checkTarget(page);

    collector = new CatalogCollector({ ...config, maxEvents: max });
    const pending = new Set(), inFlight = new Set();
    let lastActivity = now();
    page.on('request', request => { if (isEventsApi(request.url())) { inFlight.add(request); lastActivity = now(); } });
    page.on('requestfinished', request => { inFlight.delete(request); });
    page.on('requestfailed', request => {
      if (isEventsApi(request.url())) collector.error ||= new ScrapeError('UPSTREAM_ERROR');
      inFlight.delete(request);
    });
    page.on('response', response => {
      if (!isEventsApi(response.url())) return;
      lastActivity = now();
      const task = (async () => {
        if ([401, 403].includes(response.status())) throw new ScrapeError('UPSTREAM_AUTH', 401);
        if (!response.ok()) throw new ScrapeError('UPSTREAM_ERROR');
        const length = Number(await response.headerValue('content-length'));
        if (length > config.maxResponseBytes) throw new ScrapeError('RESPONSE_TOO_LARGE');
        const body = await response.body();
        if (body.length > config.maxResponseBytes) throw new ScrapeError('RESPONSE_TOO_LARGE');
        let data;
        try { data = JSON.parse(body.toString('utf8')); } catch { throw new ScrapeError('API_SCHEMA_CHANGED'); }
        const header = await response.headerValue('pagination');
        let pagination = null;
        if (header) {
          try { pagination = JSON.parse(header); } catch { throw new ScrapeError('API_SCHEMA_CHANGED'); }
          if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) throw new ScrapeError('API_SCHEMA_CHANGED');
        }
        collector.accept(data, response.url(), body.length, pagination);
      })().catch(error => { collector.error ||= publicError(error); }).finally(() => { pending.delete(task); lastActivity = now(); });
      pending.add(task);
    });
    await page.goto(EVENTS_URL, { waitUntil: 'domcontentloaded' });
    checkTarget(page);
    let previousSignature = '', stable = 0, reachedEnd = false;
    for (let i = 0; i < config.maxScrolls; i++) {
      assertActive();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(1200);
      assertActive(); checkTarget(page);
      const state = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, atBottom: window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 5 }));
      const signature = `${state.height}:${collector.events.size}:${collector.responses}`;
      const quiet = pending.size === 0 && inFlight.size === 0 && now() - lastActivity >= 1000;
      stable = state.atBottom && quiet && signature === previousSignature ? stable + 1 : 0;
      previousSignature = signature;
      if (stable >= 3) { reachedEnd = true; break; }
    }
    assertActive();
    if (!reachedEnd || pending.size || inFlight.size) throw new ScrapeError('PAGINATION_INCOMPLETE');
    const result = collector.finish();
    const events = result.rawEvents.map(mapEvent).sort((a, b) => (a.startISO || '9999').localeCompare(b.startISO || '9999'));
    return { events, complete: true, timeZone: TIME_ZONE, meta: result.meta };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw publicError(error);
  } finally {
    email = undefined; password = undefined;
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
    controller.signal.removeEventListener('abort', abortBrowser);
    // No storageState, screenshots, tracing, downloads, or password logs.
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
