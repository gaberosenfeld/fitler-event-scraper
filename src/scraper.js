import { selectors } from './selectors.js';
import { attachEventCapture } from './event-capture.js';
import { LOGIN_URL, EVENTS_URL, TARGET_ORIGIN, TIME_ZONE } from './config.js';
import { mapEvent } from './events.js';
import { ScrapeError } from './errors.js';
import { browserFailure, launchOptions } from './diagnostics.js';
import { closeBrowserResources } from './browser-cleanup.js';
import { attachPageEvidence } from './page-evidence.js';
import { routeBrowserRequest } from './network-policy.js';

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

export async function scrapeEvents({ email, password, max, config, signal, browserType, now = Date.now, observe = () => {}, observeCapture = () => {} }) {
  let phase = 'browser_import';
  const setPhase = value => { phase = value; observe(value); };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new ScrapeError('TIMEOUT', 504)), config.timeoutMs);
  const onExternalAbort = () => controller.abort(new ScrapeError('CANCELLED', 499));
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (signal?.aborted) onExternalAbort();
  let browser, context, page, collector, capture, pageEvidence;
  const abortBrowser = () => { void browser?.close().catch(() => {}); };
  controller.signal.addEventListener('abort', abortBrowser, { once: true });
  const assertActive = () => { if (controller.signal.aborted) throw controller.signal.reason; if (collector?.error) throw collector.error; };
  try {
    assertActive();
    setPhase('browser_import');
    const chromium = browserType || (await import('playwright')).chromium;
    setPhase('browser_launch');
    browser = await chromium.launch(launchOptions(config));
    assertActive();
    setPhase('context_create');
    context = await browser.newContext({ timezoneId: TIME_ZONE, acceptDownloads: false, serviceWorkers: 'block' });
    context.setDefaultTimeout(8000);
    context.setDefaultNavigationTimeout(20000);
    // Fixed member origin plus one verified public bootstrap script; no general
    // external requests, Stripe data endpoints, payments or arbitrary URL proxy.
    await context.route('**/*', route => routeBrowserRequest(route));
    await context.routeWebSocket('**/*', socket => socket.close());
    setPhase('page_create');
    page = await context.newPage();
    pageEvidence = attachPageEvidence(page);
    page.on('popup', popup => { void popup.close().catch(() => {}); });
    // Attach before sign-in, as in the uploaded build: redirects can fetch the
    // first authenticated event page before waitForURL resolves. Only the exact
    // approved event endpoint is parsed; login response bodies are never read.
    capture = attachEventCapture(page, { config, max, now });
    collector = capture.collector;
    // Login uses the uploaded build's two-step form and selector fallbacks.
    setPhase('login_page');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    try {
      setPhase('login_form');
      await (await firstVisible(page, selectors.login.emailInput)).fill(email);
      await (await firstVisible(page, selectors.login.emailNextButton)).click();
      await (await firstVisible(page, selectors.login.passwordInput)).fill(password);
    } catch { assertActive(); throw new ScrapeError('LOGIN_CHANGED'); }
    // Do not retain credentials in scraper locals after they enter the isolated page.
    email = undefined; password = undefined;
    try {
      setPhase('login_submit');
      await (await firstVisible(page, selectors.login.loginButton)).click();
      await page.waitForURL(url => url.origin === TARGET_ORIGIN && !/^\/login(?:\/|$)/i.test(url.pathname), { timeout: 15000 });
    } catch { assertActive(); throw new ScrapeError('LOGIN_FAILED', 401); }
    checkTarget(page);

    setPhase('events_page');
    await page.goto(EVENTS_URL, { waitUntil: 'domcontentloaded' });
    checkTarget(page);
    setPhase('collect_events');
    await capture.waitForFirst(() => { assertActive(); checkTarget(page); }, pageEvidence.inspect);
    checkTarget(page);
    let previousSignature = '', stable = 0, reachedEnd = false;
    for (let i = 0; i < config.maxScrolls; i++) {
      assertActive();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(1200);
      assertActive(); checkTarget(page);
      const state = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, atBottom: window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 5 }));
      const signature = `${state.height}:${collector.events.size}:${collector.responses}`;
      const quiet = capture.quiet();
      stable = state.atBottom && quiet && signature === previousSignature ? stable + 1 : 0;
      previousSignature = signature;
      // A slow next page is not the end: keep waiting/scrolling until the
      // captured API pagination proves completeness or a bound is reached.
      if (stable >= 3 && collector.hasCompleteCatalog()) { reachedEnd = true; break; }
    }
    assertActive();
    await capture.drain(assertActive);
    if (!reachedEnd || capture.active()) throw new ScrapeError('PAGINATION_INCOMPLETE');
    setPhase('normalize_events');
    const result = collector.finish();
    await pageEvidence.inspect();
    const events = result.rawEvents.map(mapEvent).sort((a, b) => (a.startISO || '9999').localeCompare(b.startISO || '9999'));
    return { events, complete: true, timeZone: TIME_ZONE, meta: result.meta };
  } catch (error) {
    if (controller.signal.aborted) throw browserFailure(controller.signal.reason, phase);
    throw browserFailure(error, phase);
  } finally {
    email = undefined; password = undefined;
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onExternalAbort);
    controller.signal.removeEventListener('abort', abortBrowser);
    // No storageState, screenshots, tracing, downloads, or password logs.
    if (capture) {
      capture.detach();
      pageEvidence?.detach();
      try { observeCapture({ ...capture.snapshot(), page: pageEvidence?.snapshot() }); } catch {}
    }
    setPhase('cleanup');
    await closeBrowserResources(browser, context, config.cleanupTimeoutMs);
  }
}
