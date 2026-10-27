# Portal integration contract

Version 1.0.1 adds a credential-free authenticated browser diagnostic (below). Existing scrape and cache contracts remain compatible; browser startup failures now use specific JSON 503 codes. Do not interpret a diagnostic success as a successful event scrape.

Server-only HTTPS calls. Never expose the shared secret to the browser. The portal backend must separately authenticate/authorize staff and protect its form endpoint against CSRF. Send no arbitrary target URL. Do not enable request-body logging.

## Health

`GET /health` — public, `200 {"ok":true,"service":"fitler-events-scraper","version":"1.0.1","capabilities":{"browserDiagnostics":true}}`. This proves process readiness only, not browser/login/event freshness. `/api/health` is a compatibility alias.

## Browser startup diagnostic (no staff login)

`POST /api/diagnostics/browser` uses the same private bearer authentication and server-only origin policy; `Content-Type: application/json`; body **exactly `{}`**. Credential fields or any other keys are rejected. The portal should enable this control only when `/health` advertises `capabilities.browserDiagnostics === true`.

Success `200`: `{ok:true,diagnostic:"browser-startup",version:"1.0.1",requestId,checkedAt,browser:{launched:true,contextCreated:true,pageEvaluated:true,sandboxEnabled,version}}`. The browser version is numeric or `"unknown"`. No page is navigated; all network routes are blocked. Cache/fetchedAt are not changed.

Failure is non-2xx JSON `{ok:false,diagnostic:"browser-startup",version:"1.0.1",requestId,error:{code,message,phase?}}`. Startup codes use **503**: `BROWSER_SANDBOX_UNAVAILABLE`, `BROWSER_BINARY_MISSING`, `BROWSER_DEPENDENCIES_MISSING`, `BROWSER_HOST_RESTRICTION`, `BROWSER_LAUNCH_FAILED`, `BROWSER_CONTEXT_FAILED`, `BROWSER_PAGE_FAILED`, `BROWSER_PROBE_FAILED`. `TIMEOUT` is 504; normal auth/validation/concurrency/rate statuses still apply. The same `requestId` appears in `X-Scraper-Request-Id` and privacy-safe application logs.

Startup phase enum: `browser_import`, `browser_launch`, `context_create`, `page_create`, `browser_probe`, `cleanup`. Normal scrape phase logs additionally use `accepted`, `login_page`, `login_form`, `login_submit`, `events_page`, `collect_events`, `normalize_events`, `complete`. Render only allowlisted categories/phases in the portal. Raw Playwright messages/stacks are never returned or logged.

The diagnostic shares the one-browser lock and 30-second cooldown with scraping. There is a 20-second diagnostic deadline; a host-level process kill or an unresponsive runtime may prevent a JSON response. No automatic retries. Sandbox remains enabled unless the operator separately changes the existing setting after reviewing the risk.

## On-demand scrape

`POST /api/scrape` (`/scrape` is an alias).

- `Authorization: Bearer <SCRAPER_SHARED_SECRET>`
- `Content-Type: application/json`
- No `Origin` header: call from your backend, not browser `fetch`.
- Body: `{ "email": "<staff email>", "password": "<staff password>", "max": 500 }`
- `max` is optional, integer 1–`MAX_EVENTS`, and is a collection safety cap—not truncation/pagination. Unknown body keys are rejected.
- Allow at least 105 seconds at the caller for the default 90-second scrape timeout.

Success (`200`):

```json
{
  "ok": true,
  "events": [],
  "complete": true,
  "timeZone": "America/New_York",
  "meta": {
    "apiResponses": 1,
    "totalCollected": 0,
    "returned": 0,
    "truncated": false,
    "completionEvidence": "reported-total"
  },
  "fetchedAt": "2026-10-27T20:00:00.000Z",
  "cached": false,
  "stale": false
}
```

This empty-array example represents a **verified empty** catalog, not “nothing captured.” `complete` covers the catalog scope loaded by the unfiltered `/events` page. It is not a promise to include hidden, unauthorized, archived or other event groups.

Event fields: `id`, `url`, `title`, `description` (short summary), `summary`, `longDescription` (plain text), `longDescriptionHTML` (**untrusted source HTML**), `date`, `time`, `startISO`, `endISO`, `sourceStartISO`, `sourceEndISO`, `timeZone`, `ambiguousLocalTime`, `location`, `bannerImage`, `externalLink`, `categories`, `availability`. No entire raw upstream record is returned. HTML must be sanitized in the portal; plain-text fields must be escaped, never interpreted as markup.

Failure: non-2xx `{ "ok": false, "error": { "code": "...", "message": "..." } }`. If an earlier successful catalog exists, failures additionally include its unchanged `events`, `fetchedAt`, `complete`, `timeZone`, `meta`, plus `cached:true` and `stale:true`. **Never overwrite a freshness indicator using request time or treat `complete:true` in a fallback as a new success.** `ok` and HTTP status govern the outcome.

| Status | Codes |
| --- | --- |
| 400 | `INVALID_REQUEST`, `INVALID_JSON` |
| 401 | `UNAUTHORIZED`, `LOGIN_FAILED`, `UPSTREAM_AUTH` |
| 403 | `ORIGIN_NOT_ALLOWED` |
| 409 | `BUSY` |
| 413 / 415 | `REQUEST_TOO_LARGE`, `CONTENT_TYPE`, `CONTENT_ENCODING` |
| 422 | `EVENT_LIMIT` |
| 429 | `RATE_LIMIT` (respect `Retry-After`) |
| 502 | `LOGIN_CHANGED`, `NO_API_RESPONSES`, `PAGINATION_INCOMPLETE`, `UPSTREAM_ERROR`, `API_SCHEMA_CHANGED`, `RESPONSE_TOO_LARGE`, `INVALID_EVENT`, `TARGET_BLOCKED`, `BROWSER_ERROR` |
| 504 | `TIMEOUT` |

Do not retry login failures automatically. User cancellation closes the active browser; a disconnected caller may not receive the internal `CANCELLED` response.

## Last successful catalog

`GET /api/events` — same bearer authentication; no staff password. Returns the last successful result with `ok:true,cached:true,stale:true`, retaining original `fetchedAt`. A cached result is not a new scrape and is deliberately never labeled fresh. Before the first success or after restart: `404 NO_CACHE`.

Cache is memory-only and single-instance. Do not scale beyond one replica without an explicit shared cache/locking design. This service is for the one Fitler portal, not a multi-tenant credential proxy.
