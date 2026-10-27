import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { scrapeEvents } from './scraper.js';
import { publicError } from './errors.js';

function authenticated(value, secret) {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const given = Buffer.from(value.slice(7)), expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
export function createApp({ config, scrape = scrapeEvents, now = Date.now } = {}) {
  if (!config?.secret) throw new Error('Secret configuration is required');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  let busy = false, lastAttempt = null, lastSuccess = null, activeController = null;
  let rateWindow = now(), authenticatedRequests = 0;
  app.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    next();
  });
  app.get(['/health', '/api/health'], (_req, res) => res.json({ ok: true, service: 'fitler-events-scraper' }));
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
    if (busy) { clear(); return res.status(409).json({ ok: false, error: { code: 'BUSY', message: 'A scrape is already running.' } }); }
    if (lastAttempt !== null && now() - lastAttempt < config.minIntervalMs) {
      clear(); res.set('Retry-After', String(Math.ceil((config.minIntervalMs - (now() - lastAttempt)) / 1000)));
      return res.status(429).json({ ok: false, error: { code: 'RATE_LIMIT', message: 'Wait before starting another scrape.' } });
    }
    busy = true; lastAttempt = now(); activeController = new AbortController();
    const cancel = () => { if (!res.writableEnded) activeController?.abort(); };
    res.on('close', cancel);
    try {
      const task = scrape({ ...credentials, max, config, signal: activeController.signal });
      clear();
      const result = await task;
      // Guard against accidental partial-success regressions in scraper adapters.
      if (result.complete !== true || result.meta?.truncated !== false || !Array.isArray(result.events)) throw new Error('Incomplete result');
      lastSuccess = { ...result, fetchedAt: new Date(now()).toISOString() };
      res.json({ ok: true, ...lastSuccess, cached: false, stale: false });
    } catch (error) {
      const safe = publicError(error);
      if (!res.destroyed) res.status(safe.status).json({ ok: false, error: { code: safe.code, message: safe.message }, ...(lastSuccess ? { ...lastSuccess, cached: true, stale: true } : {}) });
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
  return { app, cancelActive: () => activeController?.abort() };
}
