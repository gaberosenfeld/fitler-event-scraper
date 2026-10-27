const MESSAGES = {
  LOGIN_FAILED: 'Sign-in did not complete. Check staff credentials or complete any required verification in the member portal.',
  LOGIN_CHANGED: 'The member portal sign-in form changed or did not load.',
  NO_API_RESPONSES: 'No event API response was observed; no fresh catalog was saved.',
  UPSTREAM_AUTH: 'An authenticated event session was not available or the event API rejected it. No fresh catalog was saved.',
  UPSTREAM_ERROR: 'The event API returned an error; no fresh catalog was saved.',
  API_SCHEMA_CHANGED: 'The event response format changed; no fresh catalog was saved.',
  RESPONSE_TOO_LARGE: 'The event response exceeded the safety limit.',
  EVENT_LIMIT: 'The catalog exceeds the configured event limit. No partial result was saved.',
  PAGINATION_INCOMPLETE: 'The end of the event catalog could not be verified. No partial result was saved.',
  TIMEOUT: 'The scrape timed out. No fresh catalog was saved.',
  CANCELLED: 'The scrape was cancelled.',
  BROWSER_ERROR: 'The browser could not complete the scrape. Check the container/browser configuration.',
  BROWSER_SANDBOX_UNAVAILABLE: 'The host prevented Chromium sandbox startup. Review host sandbox support; sandboxing has not been disabled.',
  BROWSER_BINARY_MISSING: 'The matching Playwright browser executable or package is missing. Rebuild using the supplied Dockerfile.',
  BROWSER_DEPENDENCIES_MISSING: 'Chromium system dependencies are missing. Rebuild using the matching official Playwright image.',
  BROWSER_HOST_RESTRICTION: 'The host blocked a browser process operation. Check deployment process permissions and runtime restrictions.',
  BROWSER_LAUNCH_FAILED: 'Chromium could not start. Check the safe diagnostic phase/category in application logs.',
  BROWSER_CONTEXT_FAILED: 'Chromium started but could not create an isolated browser context.',
  BROWSER_PAGE_FAILED: 'Chromium could not create an isolated page.',
  BROWSER_PROBE_FAILED: 'Chromium could not evaluate the credential-free startup probe.',
  TARGET_BLOCKED: 'The member portal navigated outside its approved domain.',
  INVALID_EVENT: 'An event has invalid required fields; no fresh catalog was saved.'
};
export class ScrapeError extends Error {
  constructor(code, status = 502) { super(MESSAGES[code] || MESSAGES.BROWSER_ERROR); this.name = 'ScrapeError'; this.code = code; this.status = status; }
}
export function publicError(error) {
  return error instanceof ScrapeError ? error : new ScrapeError(error?.name === 'TimeoutError' ? 'TIMEOUT' : 'BROWSER_ERROR');
}
