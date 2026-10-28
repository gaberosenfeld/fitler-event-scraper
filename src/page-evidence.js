import { TARGET_ORIGIN } from './config.js';
import { runtimeErrorEvidence, sanitizeRuntimeError, scriptCategory } from './runtime-evidence.js';
import { isApprovedBootstrapScript } from './network-policy.js';

export const PAGE_COUNT_KEYS = ['requests', 'scriptRequests', 'scriptFailures', 'scriptHttpErrors', 'apiRequests', 'apiAuthDenied', 'apiHttpErrors', 'blockedExternalScripts', 'blockedExternalData', 'nonGetRequests', 'matchedPrivateEventRequests', 'matchedPublicEventRequests', 'eventEndpointsOtherGroup', 'eventEndpointsMissingGroup', 'pageErrors', 'moduleErrors', 'rootChildren', 'scriptElements', 'preloadElements', 'visibleEmailInputs', 'visiblePasswordInputs', 'eventLinks', 'cards', 'challengeFrames'];
PAGE_COUNT_KEYS.push('stripeScriptRequests', 'stripeScriptResponses', 'stripeScriptFailures', 'sameOriginScriptFailures', 'analyticsScriptFailures', 'otherExternalScriptFailures');
const ROUTES = new Set(['login', 'events', 'other_same_origin', 'outside_origin', 'unknown']);
export function routeCategory(value) {
  try { const u = new URL(value); return u.origin !== TARGET_ORIGIN ? 'outside_origin' : /^\/login\/?$/.test(u.pathname) ? 'login' : /^\/events\/?$/.test(u.pathname) ? 'events' : 'other_same_origin'; } catch { return 'unknown'; }
}
export function sanitizePageEvidence(value = {}) {
  const safe = {};
  for (const key of PAGE_COUNT_KEYS) safe[key] = Number.isSafeInteger(value[key]) && value[key] >= 0 ? Math.min(value[key], 10000) : 0;
  safe.route = ROUTES.has(value.route) ? value.route : 'unknown';
  safe.readyState = ['loading', 'interactive', 'complete'].includes(value.readyState) ? value.readyState : 'unknown';
  safe.documentStatus = Number.isInteger(value.documentStatus) && value.documentStatus >= 100 && value.documentStatus <= 599 ? value.documentStatus : 0;
  safe.snapshotAvailable = value.snapshotAvailable === true;
  safe.runtimeErrors = Array.isArray(value.runtimeErrors) ? value.runtimeErrors.slice(0, 5).map(sanitizeRuntimeError) : [];
  return safe;
}

export function attachPageEvidence(page, { inspectTimeoutMs = 5000 } = {}) {
  let state = sanitizePageEvidence();
  let detached = false;
  const increment = key => { state[key] = Math.min(state[key] + 1, 10000); };
  const request = req => {
    increment('requests');
    const type = req.resourceType?.();
    if (req.method?.() && !['GET', 'HEAD'].includes(req.method())) increment('nonGetRequests');
    if (type === 'script') increment('scriptRequests');
    let u; try { u = new URL(req.url()); } catch { return; }
    if (u.origin !== TARGET_ORIGIN) {
      if (type === 'script') {
        if (scriptCategory(req.url()) === 'stripe') increment('stripeScriptRequests');
        if (!isApprovedBootstrapScript(req)) increment('blockedExternalScripts');
      }
      if (['xhr', 'fetch'].includes(type)) increment('blockedExternalData');
      return;
    }
    if (u.pathname.startsWith('/api/')) increment('apiRequests');
    if (/^\/api\/(?:public\/)?events\/?$/.test(u.pathname)) {
      const group = u.searchParams.get('group');
      if (!group) increment('eventEndpointsMissingGroup');
      else if (group !== 'events') increment('eventEndpointsOtherGroup');
      else increment(u.pathname.includes('/public/') ? 'matchedPublicEventRequests' : 'matchedPrivateEventRequests');
    }
  };
  const requestfailed = req => {
    if (req.resourceType?.() !== 'script') return;
    increment('scriptFailures');
    const key = { same_origin: 'sameOriginScriptFailures', stripe: 'stripeScriptFailures', analytics: 'analyticsScriptFailures', other_external: 'otherExternalScriptFailures' }[scriptCategory(req.url())];
    if (key) increment(key);
  };
  const response = res => {
    let u; try { u = new URL(res.url()); } catch { return; }
    const status = res.status();
    const type = res.request?.().resourceType?.();
    if (u.origin === 'https://js.stripe.com' && type === 'script' && status === 200) increment('stripeScriptResponses');
    if (u.origin !== TARGET_ORIGIN) return;
    if (type === 'document') state.documentStatus = status;
    if (type === 'script' && status >= 400) increment('scriptHttpErrors');
    if (u.pathname.startsWith('/api/')) {
      if ([401, 403].includes(status)) increment('apiAuthDenied');
      else if (status >= 400) increment('apiHttpErrors');
    }
  };
  const pageerror = error => {
    increment('pageErrors');
    // Inspect locally; only the numeric category is retained, never the text.
    if (/dynamically imported module|loading chunk|module script|importing a module/i.test(String(error?.message || '').slice(0, 4096))) increment('moduleErrors');
    if (state.runtimeErrors.length < 5) state.runtimeErrors.push(runtimeErrorEvidence(error));
  };
  const listeners = { request, requestfailed, response, pageerror };
  for (const [name, fn] of Object.entries(listeners)) page.on(name, fn);
  return {
    async inspect() {
      state.route = routeCategory(page.url());
      let timer;
      try {
        // Deliberately no innerText, title, attributes, field values, storage,
        // cookies, URLs or screenshots. Return only bounded structural counts.
        const evaluation = page.evaluate(() => {
          const visibleCount = selector => [...document.querySelectorAll(selector)].slice(0, 10000).filter(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)).length;
          return {
            readyState: document.readyState,
            rootChildren: document.getElementById('root')?.childElementCount || 0,
            scriptElements: document.scripts.length,
            preloadElements: document.querySelectorAll('link[rel="modulepreload"]').length,
            visibleEmailInputs: visibleCount('input[type="email"], input[autocomplete="username"]'),
            visiblePasswordInputs: visibleCount('input[type="password"]'),
            eventLinks: document.querySelectorAll('a[href^="/events/"]').length,
            cards: document.querySelectorAll('.pv-card').length,
            challengeFrames: document.querySelectorAll('iframe[src*="captcha"], iframe[src*="challenge"]').length,
            snapshotAvailable: true
          };
        });
        const dom = await Promise.race([evaluation, new Promise(resolve => { timer = setTimeout(() => resolve(null), inspectTimeoutMs); })]);
        if (dom && !detached) state = sanitizePageEvidence({ ...state, ...dom });
      } catch { /* Keep last safe snapshot if the page closes or is navigating. */ }
      finally { clearTimeout(timer); }
    },
    snapshot: () => sanitizePageEvidence(state),
    detach() { detached = true; for (const [name, fn] of Object.entries(listeners)) page.off(name, fn); }
  };
}
