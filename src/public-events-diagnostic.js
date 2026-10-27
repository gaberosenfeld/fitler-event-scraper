import { EVENTS_URL, TARGET_ORIGIN, TIME_ZONE } from './config.js';
import { ScrapeError } from './errors.js';
import { browserFailure, launchOptions } from './diagnostics.js';
import { closeBrowserResources } from './browser-cleanup.js';
import { attachPageEvidence } from './page-evidence.js';

export async function checkPublicEventsBootstrap({ config, signal, browserType, now = Date.now, observe = () => {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ScrapeError('TIMEOUT', 504)), 60000);
  const cancel = () => controller.abort(new ScrapeError('CANCELLED', 499));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let browser, context, evidence, phase = 'browser_import';
  const setPhase = value => { phase = value; observe(value); };
  const closeOnAbort = () => { void browser?.close().catch(() => {}); };
  controller.signal.addEventListener('abort', closeOnAbort, { once: true });
  const active = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  try {
    active(); setPhase('browser_import');
    const chromium = browserType || (await import('playwright')).chromium;
    setPhase('browser_launch'); browser = await chromium.launch(launchOptions(config));
    active(); setPhase('context_create');
    context = await browser.newContext({ timezoneId: TIME_ZONE, acceptDownloads: false, serviceWorkers: 'block' });
    context.setDefaultTimeout(5000); context.setDefaultNavigationTimeout(20000);
    // No staff credentials, storage/cookie reads, login submissions, or API-body
    // collection. Navigation is one fixed public page; only GET/HEAD can pass.
    await context.route('**/*', route => {
      const req = route.request(); let allowed = false;
      try { allowed = new URL(req.url()).origin === TARGET_ORIGIN && ['GET', 'HEAD'].includes(req.method()) && !['image', 'font', 'media'].includes(req.resourceType()); } catch {}
      return allowed ? route.continue() : route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    setPhase('page_create'); const page = await context.newPage();
    page.on('popup', popup => { void popup.close().catch(() => {}); });
    evidence = attachPageEvidence(page);
    setPhase('events_page'); await page.goto(EVENTS_URL, { waitUntil: 'domcontentloaded' });
    active(); setPhase('browser_probe');
    const deadline = now() + 30000;
    while (now() < deadline) {
      active(); await evidence.inspect();
      const current = evidence.snapshot();
      if (current.route === 'outside_origin') throw new ScrapeError('TARGET_BLOCKED');
      // An API request proves only that the public component tried to load data,
      // not that login, private events, pagination, or catalog freshness work.
      if (current.matchedPrivateEventRequests || current.matchedPublicEventRequests) break;
      await page.waitForTimeout(1000);
    }
    active(); await evidence.inspect();
    return { diagnostic: 'public-events-bootstrap', page: evidence.snapshot() };
  } catch (error) {
    const safe = browserFailure(controller.signal.aborted ? controller.signal.reason : error, phase);
    if (evidence) safe.pageEvidence = evidence.snapshot();
    throw safe;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', closeOnAbort); evidence?.detach();
    setPhase('cleanup'); await closeBrowserResources(browser, context, config.cleanupTimeoutMs);
  }
}
