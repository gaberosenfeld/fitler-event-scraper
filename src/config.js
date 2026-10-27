export const TARGET_ORIGIN = 'https://member.fitlerclub.com';
export const LOGIN_URL = `${TARGET_ORIGIN}/login`;
export const EVENTS_URL = `${TARGET_ORIGIN}/events`;
export const TIME_ZONE = 'America/New_York';

function integer(value, fallback, min, max, name) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Invalid ${name}`);
  return result;
}

export function loadConfig(env = process.env) {
  const secret = env.SCRAPER_SHARED_SECRET;
  if (typeof secret !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(secret)) {
    throw new Error('Set SCRAPER_SHARED_SECRET to a private 32–256 character printable ASCII secret without spaces');
  }
  if (env.HEADLESS !== undefined && !['true', 'false'].includes(env.HEADLESS)) throw new Error('HEADLESS must be true or false');
  return Object.freeze({
    secret,
    port: integer(env.PORT, 5174, 1, 65535, 'PORT'),
    headless: env.HEADLESS !== 'false',
    timeoutMs: integer(env.SCRAPE_TIMEOUT_MS, 90000, 15000, 120000, 'SCRAPE_TIMEOUT_MS'),
    maxEvents: integer(env.MAX_EVENTS, 500, 1, 1000, 'MAX_EVENTS'),
    minIntervalMs: integer(env.MIN_SCRAPE_INTERVAL_MS, 30000, 1000, 3600000, 'MIN_SCRAPE_INTERVAL_MS'),
    maxApiResponses: 120,
    maxScrolls: 80,
    maxResponseBytes: 4 * 1024 * 1024,
    maxCatalogBytes: 12 * 1024 * 1024,
    // Fail closed rather than silently disabling Chromium's OS sandbox.
    chromiumSandbox: env.CHROMIUM_SANDBOX !== 'false'
  });
}
