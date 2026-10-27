# Portal integration contract

Server-only HTTPS calls. Never expose the shared secret to the browser. The portal backend must separately authenticate/authorize staff and protect its form endpoint against CSRF. Send no arbitrary target URL. Do not enable request-body logging.

## Health

`GET /health` — public, `200 {"ok":true,"service":"fitler-events-scraper"}`. This proves process readiness only, not browser/login/event freshness. `/api/health` is a compatibility alias.

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
