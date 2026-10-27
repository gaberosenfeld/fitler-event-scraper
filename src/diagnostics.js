import { randomUUID } from 'node:crypto';
import { ScrapeError } from './errors.js';
import { TIME_ZONE } from './config.js';
import { browserEvidence, sanitizeBrowserEvidence, browserEvidenceSummary } from './browser-evidence.js';
import { closeBrowserResources } from './browser-cleanup.js';
import { sanitizePageEvidence } from './page-evidence.js';

export const SERVICE_VERSION = '1.0.4';
const PHASES = new Set(['accepted', 'browser_import', 'browser_launch', 'context_create', 'page_create', 'browser_probe', 'login_page', 'login_form', 'login_submit', 'events_page', 'collect_events', 'normalize_events', 'cleanup', 'complete']);
const CODES = new Set(['OK', 'BROWSER_SANDBOX_UNAVAILABLE', 'BROWSER_BINARY_MISSING', 'BROWSER_DEPENDENCIES_MISSING', 'BROWSER_HOST_RESTRICTION', 'BROWSER_LAUNCH_FAILED', 'BROWSER_CONTEXT_FAILED', 'BROWSER_PAGE_FAILED', 'BROWSER_PROBE_FAILED', 'BROWSER_ERROR', 'TIMEOUT', 'CANCELLED', 'LOGIN_FAILED', 'LOGIN_CHANGED', 'NO_API_RESPONSES', 'UPSTREAM_AUTH', 'UPSTREAM_ERROR', 'API_SCHEMA_CHANGED', 'RESPONSE_TOO_LARGE', 'EVENT_LIMIT', 'PAGINATION_INCOMPLETE', 'TARGET_BLOCKED', 'INVALID_EVENT']);

// Log only our enums/numbers/generated ID. Never serialize Error, input, URLs,
// Playwright call logs, headers, page contents, credentials, or arbitrary strings.
export function createOperationLog(kind, write = value => console.info(value), now = Date.now) {
  const requestId = randomUUID();
  const started = now();
  let phase = 'accepted';
  const emit = (event, code, evidence, fields = {}) => {
    try { write(JSON.stringify({ service: 'fitler-events-scraper', version: SERVICE_VERSION, requestId, operation: ['browser_diagnostic', 'public_events_diagnostic'].includes(kind) ? kind : 'scrape', event, phase, elapsedMs: Math.max(0, now() - started), ...(code ? { code: CODES.has(code) ? code : 'BROWSER_ERROR' } : {}), ...(kind === 'browser_diagnostic' && evidence ? { evidence: sanitizeBrowserEvidence(evidence), message: browserEvidenceSummary(evidence) } : {}), ...fields })); } catch { /* Logging must not affect the request. */ }
  };
  return {
    requestId,
    phase(value) { if (PHASES.has(value)) { phase = value; emit('phase'); } },
    finish(code = 'OK', failedPhase, evidence) { if (PHASES.has(failedPhase)) phase = failedPhase; emit(code === 'OK' ? 'succeeded' : 'failed', code, evidence); },
    capture(value) {
      const counts = {};
      for (const key of ['privateRequests', 'privateResponses', 'parsedResponses', 'publicResponses', 'authDenied', 'failedRequests']) {
        const n = value?.[key]; counts[key] = Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 121) : 0;
      }
      emit('event_capture', null, null, { ...counts, ...(value?.page ? { page: sanitizePageEvidence(value.page) } : {}) });
    },
    transport(event, value) {
      if (!['response_finish', 'response_close'].includes(event)) return;
      const status = value?.httpStatus;
      emit(event, null, null, {
        httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0,
        contentType: ['json', 'text', 'other', 'none'].includes(value?.contentType) ? value.contentType : 'other',
        responseFinished: value?.responseFinished === true,
        responseEnded: value?.responseEnded === true,
        responseDestroyed: value?.responseDestroyed === true
      });
    },
    currentPhase: () => phase
  };
}

// Inspect the exception locally to assign a fixed category; never return its text.
export function browserFailure(error, phase = 'browser_launch') {
  const atPhase = result => { if (PHASES.has(phase)) result.phase = phase; return result; };
  if (error instanceof ScrapeError) return atPhase(error);
  const evidence = browserEvidence(error);
  if (evidence.signatures.some(value => ['sandbox_credentials_permission_failure', 'namespace_permission_failure', 'no_usable_sandbox', 'root_without_sandbox', 'setuid_sandbox_failure'].includes(value))) return atPhase(new ScrapeError('BROWSER_SANDBOX_UNAVAILABLE', 503));
  if (evidence.signatures.includes('browser_executable_missing')) return atPhase(new ScrapeError('BROWSER_BINARY_MISSING', 503));
  if (evidence.signatures.includes('shared_library_missing')) return atPhase(new ScrapeError('BROWSER_DEPENDENCIES_MISSING', 503));
  if (evidence.errno.some(value => value === 'EACCES' || value === 'EPERM')) return atPhase(new ScrapeError('BROWSER_HOST_RESTRICTION', 503));
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/No usable sandbox|SUID sandbox|Running as root without --no-sandbox|(?:namespace|zygote)[\s\S]{0,500}Operation not permitted/i.test(message)) return atPhase(new ScrapeError('BROWSER_SANDBOX_UNAVAILABLE', 503));
  if (/Executable doesn't exist|executable[^\n]*(?:not found|does not exist)|spawn[^\n]*ENOENT/i.test(message)) return atPhase(new ScrapeError('BROWSER_BINARY_MISSING', 503));
  if (/error while loading shared libraries|Host system is missing dependencies|cannot open shared object file/i.test(message)) return atPhase(new ScrapeError('BROWSER_DEPENDENCIES_MISSING', 503));
  if (/Operation not permitted|Permission denied/i.test(message)) return atPhase(new ScrapeError('BROWSER_HOST_RESTRICTION', 503));
  if (error?.name === 'TimeoutError') return atPhase(new ScrapeError('TIMEOUT', 504));
  const code = ({ browser_import: 'BROWSER_BINARY_MISSING', browser_launch: 'BROWSER_LAUNCH_FAILED', context_create: 'BROWSER_CONTEXT_FAILED', page_create: 'BROWSER_PAGE_FAILED', browser_probe: 'BROWSER_PROBE_FAILED' })[phase];
  return atPhase(new ScrapeError(code || 'BROWSER_ERROR', code ? 503 : 502));
}

export function launchOptions(config) {
  return { headless: config.headless, chromiumSandbox: config.chromiumSandbox, timeout: 15000, args: ['--disable-dev-shm-usage'] };
}

export async function checkBrowserStartup({ config, signal, browserType, observe = () => {} }) {
  let browser, context, phase = 'browser_import';
  const controller = new AbortController();
  const setPhase = value => { phase = value; observe(value); };
  const closeOnAbort = () => { void browser?.close().catch(() => {}); };
  controller.signal.addEventListener('abort', closeOnAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new ScrapeError('TIMEOUT', 504)), 20000);
  const cancel = () => controller.abort(new ScrapeError('CANCELLED', 499));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const assertActive = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  try {
    assertActive(); setPhase('browser_import');
    const chromium = browserType || (await import('playwright')).chromium;
    setPhase('browser_launch'); browser = await chromium.launch(launchOptions(config));
    assertActive(); setPhase('context_create');
    context = await browser.newContext({ timezoneId: TIME_ZONE, acceptDownloads: false, serviceWorkers: 'block' });
    context.setDefaultTimeout(5000);
    // No target URL, credentials, requests, login, or catalog/cache writes.
    await context.route('**/*', route => route.abort('blockedbyclient'));
    await context.routeWebSocket('**/*', socket => socket.close());
    setPhase('page_create'); const page = await context.newPage();
    setPhase('browser_probe');
    assertActive();
    if (await page.evaluate(() => 1 + 1) !== 2) throw new ScrapeError('BROWSER_PROBE_FAILED', 503);
    const version = browser.version();
    return { diagnostic: 'browser-startup', browser: { launched: true, contextCreated: true, pageEvaluated: true, sandboxEnabled: config.chromiumSandbox, version: /^\d+(?:\.\d+){0,3}$/.test(version) ? version : 'unknown' } };
  } catch (error) {
    const safe = browserFailure(controller.signal.aborted ? controller.signal.reason : error, phase);
    // Only this no-login diagnostic exposes enum evidence; real scrapes do not.
    safe.evidence = browserEvidence(error);
    safe.message += ` ${browserEvidenceSummary(safe.evidence)}`;
    throw safe;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', closeOnAbort);
    setPhase('cleanup');
    // Start both closes, so a context teardown cannot prevent browser teardown.
    await closeBrowserResources(browser, context, config.cleanupTimeoutMs);
  }
}
