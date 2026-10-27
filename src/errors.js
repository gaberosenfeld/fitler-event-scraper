const MESSAGES = {
  LOGIN_FAILED: 'Sign-in did not complete. Check staff credentials or complete any required verification in the member portal.',
  LOGIN_CHANGED: 'The member portal sign-in form changed or did not load.',
  NO_API_RESPONSES: 'No event API response was observed; no fresh catalog was saved.',
  UPSTREAM_AUTH: 'The event API rejected the signed-in session.',
  UPSTREAM_ERROR: 'The event API returned an error; no fresh catalog was saved.',
  API_SCHEMA_CHANGED: 'The event response format changed; no fresh catalog was saved.',
  RESPONSE_TOO_LARGE: 'The event response exceeded the safety limit.',
  EVENT_LIMIT: 'The catalog exceeds the configured event limit. No partial result was saved.',
  PAGINATION_INCOMPLETE: 'The end of the event catalog could not be verified. No partial result was saved.',
  TIMEOUT: 'The scrape timed out. No fresh catalog was saved.',
  CANCELLED: 'The scrape was cancelled.',
  BROWSER_ERROR: 'The browser could not complete the scrape. Check the container/browser configuration.',
  TARGET_BLOCKED: 'The member portal navigated outside its approved domain.',
  INVALID_EVENT: 'An event has invalid required fields; no fresh catalog was saved.'
};
export class ScrapeError extends Error {
  constructor(code, status = 502) { super(MESSAGES[code] || MESSAGES.BROWSER_ERROR); this.name = 'ScrapeError'; this.code = code; this.status = status; }
}
export function publicError(error) {
  return error instanceof ScrapeError ? error : new ScrapeError(error?.name === 'TimeoutError' ? 'TIMEOUT' : 'BROWSER_ERROR');
}
