import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { scrapeEvents } from './scraper.js';
import { publicError, ScrapeError } from './errors.js';
import { checkBrowserStartup, createOperationLog, SERVICE_VERSION } from './diagnostics.js';
import { sanitizeBrowserEvidence } from './browser-evidence.js';
import { JobRegistry, isJobId } from './jobs.js';
import { checkPublicEventsBootstrap } from './public-events-diagnostic.js';
import { sanitizePageEvidence } from './page-evidence.js';

function authenticated(value, secret) {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const given = Buffer.from(value.slice(7)), expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
function watchResponse(res, operation) {
  const report = event => {
    const type = String(res.getHeader('content-type') || '').split(';')[0].toLowerCase();
    operation.transport(event, {
      httpStatus: res.statusCode,
      contentType: !type ? 'none' : type === 'application/json' ? 'json' : type === 'text/plain' ? 'text' : 'other',
      responseFinished: res.writableFinished,
      responseEnded: res.writableEnded,
      responseDestroyed: res.destroyed
    });
  };
  res.once('finish', () => report('response_finish'));
  res.once('close', () => report('response_close'));
}
export function createApp({ config, scrape = scrapeEvents, diagnostic = checkBrowserStartup, publicDiagnostic = checkPublicEventsBootstrap, now = Date.now, logger } = {}) {
  if (!config?.secret) throw new Error('Secret configuration is required');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  let busy = false, browserUnavailable = false, lastAttempt = null, lastSuccess = null, activeController = null;
  let activeJobCompletion = null;
  const jobs = new JobRegistry(now);
  let rateWindow = now(), authenticatedRequests = 0;
  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    next();
  });
  app.get(['/health', '/api/health'], (_req, res) => res.status(browserUnavailable ? 503 : 200).json({ ok: !browserUnavailable, service: 'fitler-events-scraper', version: SERVICE_VERSION, capabilities: { browserDiagnostics: true, asyncScrapeJobs: true, publicEventsDiagnostic: true }, limits: { totalTimeoutMs: config.timeoutMs, firstResponseWaitMs: Math.min(config.firstResponseTimeoutMs, config.timeoutMs), cleanupTimeoutMs: config.cleanupTimeoutMs } }));
  app.use((req, res, next) => {
    // The browser calls its own authenticated portal backend, never this service.
    // No wildcard CORS and no cross-origin credentials. Block Origin even if bearer is valid.
    if (req.get('origin')) return res.status(403).json({ ok: false, error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Use the portal server proxy.' } });
    if (!authenticated(req.get('authorization'), config.secret)) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Service authentication required.' } });
    if (now() - rateWindow >= 60000) { rateWindow = now(); authenticatedRequests = 0; }
    if (++authenticatedRequests > 60) { res.set('Retry-After', '60'); return res.status(429).json({ ok: false, error: { code: 'RATE_LIMIT', message: 'Too many service requests.' } }); }
    next();
  });
  app.get('/api/events', (_req, res) => {
    if (!lastSuccess) return res.status(404).json({ ok: false, error: { code: 'NO_CACHE', message: 'No successful scrape is cached.' } });
    return res.json({ ok: true, ...lastSuccess, cached: true, stale: true });
  });
  async function runJob(job, credentials, max, controller, operation) {
    const clear = () => { credentials.email = undefined; credentials.password = undefined; };
    const observe = phase => { operation.phase(phase); job.phase = operation.currentPhase(); };
    try {
      if (controller.signal.aborted) throw new ScrapeError('CANCELLED', 499);
      const task = scrape({ ...credentials, max, config, signal: controller.signal, observe, observeCapture: operation.capture });
      clear();
      const result = await task;
      if (controller.signal.aborted) throw new ScrapeError('CANCELLED', 499);
      if (result.complete !== true || result.meta?.truncated !== false || !Array.isArray(result.events)) throw new Error('Incomplete result');
      lastSuccess = { ...result, fetchedAt: new Date(now()).toISOString() };
      observe('complete'); operation.finish();
      job.status = 'succeeded'; job.httpStatus = 200;
      job.result = { ok: true, ...lastSuccess, cached: false, stale: false };
    } catch (error) {
      const safe = publicError(error);
      if (safe.cleanupIncomplete === true) browserUnavailable = true;
      operation.finish(safe.code, safe.phase);
      job.phase = operation.currentPhase(); job.status = 'failed'; job.httpStatus = safe.status;
      job.error = { code: safe.code, message: safe.message, phase: job.phase };
      if (lastSuccess) job.result = { ok: false, ...lastSuccess, cached: true, stale: true };
    } finally {
      clear(); jobs.finish(job); busy = false;
      if (activeController === controller) activeController = null;
    }
  }
  app.get('/api/scrape/jobs/:jobId', (req, res) => {
    const job = isJobId(req.params.jobId) ? jobs.find(req.params.jobId) : null;
    if (!job) return res.status(404).json({ ok: false, error: { code: 'JOB_NOT_FOUND', message: 'This job is unknown, expired, or was lost when the service restarted. Do not automatically resend credentials.' } });
    const metadata = jobs.metadata(job);
    if (job.status === 'failed') return res.status(job.httpStatus).json({ ok: false, ...metadata, error: job.error, ...(job.result ? { result: job.result } : {}) });
    return res.json({ ok: true, ...metadata, ...(job.status === 'succeeded' ? { result: job.result } : {}) });
  });
  app.post('/api/scrape/jobs', (req, res, next) => {
    if (!req.is('application/json')) return res.status(415).json({ ok: false, error: { code: 'CONTENT_TYPE', message: 'Send application/json.' } });
    next();
  }, express.json({ limit: '16kb', strict: true, inflate: false }), (req, res) => {
    const body = req.body, jobId = req.get('idempotency-key');
    if (!isJobId(jobId)) {
      if (body && typeof body === 'object') { delete body.password; delete body.email; }
      req.body = undefined;
      return res.status(400).json({ ok: false, error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send a new canonical UUID v4 Idempotency-Key for one explicit run.' } });
    }
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['email', 'password', 'max'].includes(key)) || typeof body.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || body.email.length > 254 || typeof body.password !== 'string' || !body.password.length || body.password.length > 1024 || (body.max !== undefined && (!Number.isInteger(body.max) || body.max < 1 || body.max > config.maxEvents))) {
      if (body && typeof body === 'object') { delete body.password; delete body.email; }
      req.body = undefined;
      return res.status(400).json({ ok: false, error: { code: 'INVALID_REQUEST', message: `Send only email, password, and optional max (1–${config.maxEvents}).` } });
    }
    const credentials = { email: body.email, password: body.password }, max = body.max ?? config.maxEvents;
    delete body.email; delete body.password; req.body = undefined;
    const clear = () => { credentials.email = undefined; credentials.password = undefined; };
    const prior = jobs.find(jobId);
    if (prior) { clear(); return res.status(202).json({ ok: true, ...jobs.metadata(prior) }); }
    if (jobs.seen(jobId)) { clear(); return res.status(409).json({ ok: false, error: { code: 'JOB_EXPIRED', message: 'This run was already accepted but its result is no longer retained. Do not restart it automatically.' } }); }
    if (browserUnavailable) { clear(); return res.status(503).json({ ok: false, error: { code: 'BROWSER_ERROR', message: 'Browser cleanup did not finish. Restart this service before another operation.' } }); }
    if (busy) { clear(); return res.status(409).json({ ok: false, error: { code: 'BUSY', message: 'A browser operation is already running.' } }); }
    if (lastAttempt !== null && now() - lastAttempt < config.minIntervalMs) {
      clear(); res.set('Retry-After', String(Math.ceil((config.minIntervalMs - (now() - lastAttempt)) / 1000)));
      return res.status(429).json({ ok: false, error: { code: 'RATE_LIMIT', message: 'Wait before starting another browser operation.' } });
    }
    if (!jobs.hasCapacity()) { clear(); res.set('Retry-After', '60'); return res.status(429).json({ ok: false, error: { code: 'JOB_LIMIT', message: 'The bounded job history is full. Wait before starting another run.' } }); }
    busy = true; lastAttempt = now();
    const controller = new AbortController(); activeController = controller;
    const operation = createOperationLog('scrape', logger, now);
    const job = jobs.create(jobId);
    job.requestId = operation.requestId;
    let complete;
    const completion = new Promise(resolve => { complete = resolve; });
    activeJobCompletion = completion;
    operation.phase('accepted'); watchResponse(res, operation);
    res.set('X-Scraper-Request-Id', operation.requestId);
    // No response-close cancellation: the explicit job outlives a short POST or
    // poll connection. Only the scraper's deadline or shutdown cancels it.
    setImmediate(() => {
      const settled = () => { if (activeJobCompletion === completion) activeJobCompletion = null; complete(); };
      // runJob handles operational failures; always release shutdown's waiter.
      void runJob(job, credentials, max, controller, operation).then(settled, settled);
    });
    res.status(202).json({ ok: true, ...jobs.metadata(job) });
  });
  app.post('/api/diagnostics/events', (req, res, next) => {
    if (!req.is('application/json')) return res.status(415).json({ ok: false, error: { code: 'CONTENT_TYPE', message: 'Send application/json with an empty object.' } });
    next();
  }, express.json({ limit: '1kb', strict: true, inflate: false }), async (req, res) => {
    const valid = req.body && !Array.isArray(req.body) && Object.keys(req.body).length === 0;
    req.body = undefined;
    if (!valid) return res.status(400).json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Diagnostic accepts only {}. Do not send credentials.' } });
    if (browserUnavailable) return res.status(503).json({ ok: false, error: { code: 'BROWSER_ERROR', message: 'Browser cleanup did not finish. Restart this service before another operation.' } });
    if (busy) return res.status(409).json({ ok: false, error: { code: 'BUSY', message: 'A browser operation is already running.' } });
    if (lastAttempt !== null && now() - lastAttempt < config.minIntervalMs) {
      res.set('Retry-After', String(Math.ceil((config.minIntervalMs - (now() - lastAttempt)) / 1000)));
      return res.status(429).json({ ok: false, error: { code: 'RATE_LIMIT', message: 'Wait before starting another browser operation.' } });
    }
    busy = true; lastAttempt = now(); const controller = new AbortController(); activeController = controller;
    const operation = createOperationLog('public_events_diagnostic', logger, now);
    watchResponse(res, operation); operation.phase('accepted');
    res.set('X-Scraper-Request-Id', operation.requestId);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    try {
      const result = await publicDiagnostic({ config, signal: controller.signal, observe: operation.phase });
      const page = sanitizePageEvidence(result.page);
      operation.capture({ page }); operation.phase('complete'); operation.finish();
      if (!res.destroyed) res.json({ ok: true, diagnostic: 'public-events-bootstrap', page, version: SERVICE_VERSION, requestId: operation.requestId, checkedAt: new Date(now()).toISOString() });
    } catch (error) {
      const safe = publicError(error);
      if (safe.cleanupIncomplete === true) browserUnavailable = true;
      const page = safe.pageEvidence ? sanitizePageEvidence(safe.pageEvidence) : null;
      if (page) operation.capture({ page });
      operation.finish(safe.code, safe.phase);
      if (!res.destroyed) res.status(safe.status).json({ ok: false, diagnostic: 'public-events-bootstrap', version: SERVICE_VERSION, requestId: operation.requestId, error: { code: safe.code, message: safe.message, phase: operation.currentPhase() }, ...(page ? { page } : {}) });
    } finally {
      res.off('close', cancel); busy = false; if (activeController === controller) activeController = null;
    }
  });
  app.post('/api/diagnostics/browser', (req, res, next) => {
    if (!req.is('application/json')) return res.status(415).json({ ok: false, error: { code: 'CONTENT_TYPE', message: 'Send application/json with an empty object.' } });
    next();
  }, express.json({ limit: '1kb', strict: true, inflate: false }), async (req, res) => {
    const valid = req.body && !Array.isArray(req.body) && Object.keys(req.body).length === 0;
    req.body = undefined;
    if (!valid) return res.status(400).json({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Diagnostic accepts only {}. Do not send credentials.' } });
    if (browserUnavailable) return res.status(503).json({ ok: false, error: { code: 'BROWSER_ERROR', message: 'Browser cleanup did not finish. Restart this service before another operation.' } });
    if (busy) return res.status(409).json({ ok: false, error: { code: 'BUSY', message: 'A browser operation is already running.' } });
    if (lastAttempt !== null && now() - lastAttempt < config.minIntervalMs) {
      res.set('Retry-After', String(Math.ceil((config.minIntervalMs - (now() - lastAttempt)) / 1000)));
      return res.status(429).json({ ok: false, error: { code: 'RATE_LIMIT', message: 'Wait before starting another browser operation.' } });
    }
    busy = true; lastAttempt = now(); activeController = new AbortController();
    const operation = createOperationLog('browser_diagnostic', logger, now);
    watchResponse(res, operation);
    operation.phase('accepted');
    res.set('X-Scraper-Request-Id', operation.requestId);
    const cancel = () => { if (!res.writableEnded) activeController?.abort(); };
    res.on('close', cancel);
    try {
      const result = await diagnostic({ config, signal: activeController.signal, observe: operation.phase });
      operation.phase('complete'); operation.finish();
      if (!res.destroyed) res.json({ ok: true, ...result, version: SERVICE_VERSION, requestId: operation.requestId, checkedAt: new Date(now()).toISOString() });
    } catch (error) {
      const safe = publicError(error);
      if (safe.cleanupIncomplete === true) browserUnavailable = true;
      const evidence = sanitizeBrowserEvidence(safe.evidence);
      operation.finish(safe.code, safe.phase, evidence);
      if (!res.destroyed) res.status(safe.status).json({ ok: false, diagnostic: 'browser-startup', version: SERVICE_VERSION, requestId: operation.requestId, error: { code: safe.code, message: safe.message, ...(safe.phase ? { phase: safe.phase } : {}), evidence } });
    } finally {
      res.off('close', cancel); busy = false; activeController = null;
    }
  });
  app.post(['/api/scrape', '/scrape'], (req, res, next) => {
    if (!req.is('application/json')) return res.status(415).json({ ok: false, error: { code: 'CONTENT_TYPE', message: 'Send application/json.' } });
    next();
  }, express.json({ limit: '16kb', strict: true, inflate: false }), async (req, res) => {
    const body = req.body;
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['email', 'password', 'max'].includes(key)) || typeof body.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || body.email.length > 254 || typeof body.password !== 'string' || !body.password.length || body.password.length > 1024 || (body.max !== undefined && (!Number.isInteger(body.max) || body.max < 1 || body.max > config.maxEvents))) {
      if (body && typeof body === 'object') { delete body.password; delete body.email; }
      return res.status(400).json({ ok: false, error: { code: 'INVALID_REQUEST', message: `Send only email, password, and optional max (1–${config.maxEvents}).` } });
    }
    const credentials = { email: body.email, password: body.password };
    const max = body.max ?? config.maxEvents;
    delete body.email; delete body.password; req.body = undefined;
    const clear = () => { credentials.email = undefined; credentials.password = undefined; };
    if (browserUnavailable) { clear(); return res.status(503).json({ ok: false, error: { code: 'BROWSER_ERROR', message: 'Browser cleanup did not finish. Restart this service before another operation.' } }); }
    if (busy) { clear(); return res.status(409).json({ ok: false, error: { code: 'BUSY', message: 'A scrape is already running.' } }); }
    if (lastAttempt !== null && now() - lastAttempt < config.minIntervalMs) {
      clear(); res.set('Retry-After', String(Math.ceil((config.minIntervalMs - (now() - lastAttempt)) / 1000)));
      return res.status(429).json({ ok: false, error: { code: 'RATE_LIMIT', message: 'Wait before starting another scrape.' } });
    }
    busy = true; lastAttempt = now(); activeController = new AbortController();
    const operation = createOperationLog('scrape', logger, now);
    watchResponse(res, operation);
    operation.phase('accepted');
    res.set('X-Scraper-Request-Id', operation.requestId);
    const cancel = () => { if (!res.writableEnded) activeController?.abort(); };
    res.on('close', cancel);
    try {
      const task = scrape({ ...credentials, max, config, signal: activeController.signal, observe: operation.phase, observeCapture: operation.capture });
      clear();
      const result = await task;
      // Guard against accidental partial-success regressions in scraper adapters.
      if (result.complete !== true || result.meta?.truncated !== false || !Array.isArray(result.events)) throw new Error('Incomplete result');
      lastSuccess = { ...result, fetchedAt: new Date(now()).toISOString() };
      operation.phase('complete'); operation.finish();
      if (!res.destroyed) res.json({ ok: true, ...lastSuccess, cached: false, stale: false });
    } catch (error) {
      const safe = publicError(error);
      if (safe.cleanupIncomplete === true) browserUnavailable = true;
      operation.finish(safe.code, safe.phase);
      if (!res.destroyed) res.status(safe.status).json({ ok: false, requestId: operation.requestId, error: { code: safe.code, message: safe.message, ...(safe.phase ? { phase: safe.phase } : {}) }, ...(lastSuccess ? { ...lastSuccess, cached: true, stale: true } : {}) });
    } finally {
      clear(); res.off('close', cancel); busy = false; activeController = null;
    }
  });
  app.use((_req, res) => res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } }));
  app.use((error, req, res, _next) => {
    req.body = undefined;
    const code = error.type === 'entity.too.large' ? 'REQUEST_TOO_LARGE' : error.type === 'encoding.unsupported' ? 'CONTENT_ENCODING' : 'INVALID_JSON';
    res.status(code === 'REQUEST_TOO_LARGE' ? 413 : code === 'CONTENT_ENCODING' ? 415 : 400).json({ ok: false, error: { code, message: 'Invalid request body.' } });
  });
  return { app, cancelActive: () => { jobs.close(); activeController?.abort(); return activeJobCompletion || Promise.resolve(); } };
}
