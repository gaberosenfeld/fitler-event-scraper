import { TARGET_ORIGIN } from './config.js';

// Fixed output vocabulary only. Never retain raw messages, stacks, URLs, query
// strings, identifiers, page text, form values or account/payment information.
const NAMES = new Set(['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'SecurityError', 'NetworkError', 'AbortError']);
const SIGNATURES = new Set(['stripe_load_failed', 'stripe_unavailable', 'stripe_invalid_key_type', 'module_load_failed', 'undefined_property', 'null_property', 'invalid_call', 'undefined_reference', 'network_fetch_failed', 'security_restriction', 'react_minified_error', 'other']);
const SOURCES = new Set(['stripe_loader', 'stripe_provider', 'stripe_sdk', 'authorized_shell', 'events_page', 'app_bundle', 'same_origin_asset', 'external_script', 'unknown']);
const number = value => Number.isInteger(value) && value >= 0 ? Math.min(value, 10000000) : 0;
export function sanitizeRuntimeError(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return { name: NAMES.has(value.name) ? value.name : 'Error', signature: SIGNATURES.has(value.signature) ? value.signature : 'other', source: SOURCES.has(value.source) ? value.source : 'unknown', line: number(value.line), column: number(value.column) };
}
function sourceCategory(value) {
  try {
    const u = new URL(value);
    if (u.origin === 'https://js.stripe.com') return 'stripe_sdk';
    if (u.origin !== TARGET_ORIGIN) return 'external_script';
    if (u.pathname === '/assets/index-BWla6c-w.js') return 'stripe_loader';
    if (u.pathname === '/assets/index-DDXVWwkU.js' || /^\/assets\/Payment-[\w-]+\.js$/.test(u.pathname)) return 'stripe_provider';
    if (/^\/assets\/Authorized-[\w-]+\.js$/.test(u.pathname)) return 'authorized_shell';
    if (/^\/assets\/Events-[\w-]+\.js$/.test(u.pathname)) return 'events_page';
    if (u.pathname === '/assets/index-CxrdghEy.js') return 'app_bundle';
    return /^\/assets\/[\w.-]+\.js$/.test(u.pathname) ? 'same_origin_asset' : 'unknown';
  } catch { return 'unknown'; }
}
export function runtimeErrorEvidence(error) {
  const message = typeof error?.message === 'string' ? error.message.slice(0, 4096) : '';
  const rules = [
    [/Failed to load Stripe\.js/i, 'stripe_load_failed'], [/Stripe\.js not available/i, 'stripe_unavailable'],
    [/Expected publishable key to be of type string/i, 'stripe_invalid_key_type'],
    [/dynamically imported module|loading chunk|module script|importing a module/i, 'module_load_failed'],
    [/Cannot read (?:properties|property) of undefined/i, 'undefined_property'], [/Cannot read (?:properties|property) of null/i, 'null_property'],
    [/is not a function/i, 'invalid_call'], [/is not defined/i, 'undefined_reference'],
    [/Failed to fetch|NetworkError|Load failed/i, 'network_fetch_failed'], [/SecurityError|Blocked a frame|cross-origin frame/i, 'security_restriction'],
    [/Minified React error #\d+/i, 'react_minified_error']
  ];
  const signature = rules.find(([pattern]) => pattern.test(message))?.[1] || 'other';
  const stack = typeof error?.stack === 'string' ? error.stack.slice(0, 12000) : '';
  const frame = stack.match(/https:\/\/[^\s()]+?:([0-9]{1,8}):([0-9]{1,8})(?=[\s)]|$)/);
  return sanitizeRuntimeError({ name: error?.name, signature, source: frame ? sourceCategory(frame[0].replace(/:\d+:\d+$/, '')) : 'unknown', line: frame ? Number(frame[1]) : 0, column: frame ? Number(frame[2]) : 0 });
}
export function scriptCategory(value) {
  try {
    const u = new URL(value);
    if (u.origin === TARGET_ORIGIN) return 'same_origin';
    if (u.origin === 'https://js.stripe.com') return 'stripe';
    if (['https://analytics.public.peoplevine.dev', 'https://www.googletagmanager.com'].includes(u.origin)) return 'analytics';
    return 'other_external';
  } catch { return 'unknown'; }
}
