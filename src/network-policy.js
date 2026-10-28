import { TARGET_ORIGIN } from './config.js';

export const STRIPE_BOOTSTRAP_URL = 'https://js.stripe.com/dahlia/stripe.js';
const MAX_BOOTSTRAP_BYTES = 2 * 1024 * 1024;
export function isApprovedBootstrapScript(request) {
  return request.method?.() === 'GET' && request.resourceType?.() === 'script' && request.url() === STRIPE_BOOTSTRAP_URL;
}

export async function routeBrowserRequest(route, { publicOnly = false } = {}) {
  const request = route.request();
  let sameOrigin = false;
  try { sameOrigin = new URL(request.url()).origin === TARGET_ORIGIN; } catch {}
  if (sameOrigin && !['image', 'font', 'media'].includes(request.resourceType()) && (!publicOnly || ['GET', 'HEAD'].includes(request.method()))) return route.continue();
  if (!isApprovedBootstrapScript(request)) return route.abort('blockedbyclient');

  // The member app gates ALL authenticated routes on this public SDK loading.
  // Fetch only the exact public script, with no credentials/referrer, no redirect
  // following and no response cookies. Stripe APIs, frames, telemetry and writes
  // remain blocked. This is not a payment operation or a general Stripe allowlist.
  let response;
  try {
    response = await route.fetch({ method: 'GET', headers: { accept: 'application/javascript', authorization: '', cookie: '', referer: '' }, maxRedirects: 0, maxRetries: 0, timeout: 15000 });
    const headers = response.headers();
    if (response.status() !== 200 || !/^(?:application|text)\/(?:java|ecma)script(?:;|$)/i.test(headers['content-type'] || '') || Number(headers['content-length']) > MAX_BOOTSTRAP_BYTES) return route.abort('blockedbyclient');
    const body = await response.body();
    if (body.length > MAX_BOOTSTRAP_BYTES) return route.abort('blockedbyclient');
    return await route.fulfill({ status: 200, headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body });
  } catch { return route.abort('blockedbyclient').catch(() => {}); }
  finally { if (response) await response.dispose().catch(() => {}); }
}
