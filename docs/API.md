# Portal integration contract

Version 1.0.1 adds a credential-free authenticated browser diagnostic (below). Existing scrape and cache contracts remain compatible; browser startup failures now use specific JSON 503 codes. Do not interpret a diagnostic success as a successful event scrape.

Version **1.0.2** additionally includes `error.evidence = {errno:[],components:[],signatures:[],signals:[]}` on no-login diagnostic failures. Every value is a fixed enum from `src/browser-evidence.js`; unknown values are dropped. Its fixed-text error message and safe application-log `message` summarize those identifiers. Do not display arbitrary upstream text in the portal: the existing fixed-category UI remains compatible, and the readable Railway application log can convey details without a portal update. No evidence field is added to real staff-login scrape failures.

Server-only HTTPS calls. Never expose the shared secret to the browser. The portal backend must separately authenticate/authorize staff and protect its form endpoint against CSRF. Send no arbitrary target URL. Do not enable request-body logging.

## Health

`GET /health` — public, `200 {"ok":true,"service":"fitler-events-scraper","version":"1.0.4","capabilities":{"browserDiagnostics":true,"asyncScrapeJobs":true,"publicEventsDiagnostic":true}}`. The health response also includes numeric `limits:{totalTimeoutMs,firstResponseWaitMs,cleanupTimeoutMs}` from effective configuration. This proves process readiness only, not browser/login/event freshness. `/api/health` is a compatibility alias.

## Browser startup diagnostic (no staff login)

`POST /api/diagnostics/browser` uses the same private bearer authentication and server-only origin policy; `Content-Type: application/json`; body **exactly `{}`**. Credential fields or any other keys are rejected. The portal should enable this control only when `/health` advertises `capabilities.browserDiagnostics === true`.

Success `200`: `{ok:true,diagnostic:"browser-startup",version:"1.0.4",requestId,checkedAt,browser:{launched:true,contextCreated:true,pageEvaluated:true,sandboxEnabled,version}}`. The browser version is numeric or `"unknown"`. No page is navigated; all network routes are blocked. Cache/fetchedAt are not changed.

Failure is non-2xx JSON `{ok:false,diagnostic:"browser-startup",version:"1.0.4",requestId,error:{code,message,phase?}}`. Startup codes use **503**: `BROWSER_SANDBOX_UNAVAILABLE`, `BROWSER_BINARY_MISSING`, `BROWSER_DEPENDENCIES_MISSING`, `BROWSER_HOST_RESTRICTION`, `BROWSER_LAUNCH_FAILED`, `BROWSER_CONTEXT_FAILED`, `BROWSER_PAGE_FAILED`, `BROWSER_PROBE_FAILED`. `TIMEOUT` is 504; normal auth/validation/concurrency/rate statuses still apply. The same `requestId` appears in `X-Scraper-Request-Id` and privacy-safe application logs.

Startup phase enum: `browser_import`, `browser_launch`, `context_create`, `page_create`, `browser_probe`, `cleanup`. Normal scrape phase logs additionally use `accepted`, `login_page`, `login_form`, `login_submit`, `events_page`, `collect_events`, `normalize_events`, `complete`. Render only allowlisted categories/phases in the portal. Raw Playwright messages/stacks are never returned or logged.

The diagnostic shares the one-browser lock and 30-second cooldown with scraping. There is a 20-second diagnostic deadline; a host-level process kill or an unresponsive runtime may prevent a JSON response. No automatic retries. Sandbox remains enabled unless the operator separately changes the existing setting after reviewing the risk.

## Legacy synchronous scrape (compatibility only)

`POST /api/scrape` (`/scrape` is an alias). **Use the async job API below for the deployed portal:** an observed intermediary closed the long synchronous request after approximately 125 seconds despite the longer application timer. Increasing that timer alone did not fix the connection cutoff.

- `Authorization: Bearer <SCRAPER_SHARED_SECRET>`
- `Content-Type: application/json`
- No `Origin` header: call from your backend, not browser `fetch`.
- Body: `{ "email": "<staff email>", "password": "<staff password>", "max": 500 }`
- `max` is optional, integer 1–`MAX_EVENTS`, and is a collection safety cap—not truncation/pagination. Unknown body keys are rejected.
- Keep the caller connected for up to 300 seconds: the default/maximum scrape deadline is 270 seconds, followed by at most 10 seconds of cleanup. The first parsed private event response may take up to 120 seconds within the total deadline. Do not automatically retry or replay credentials. An existing lower SCRAPE_TIMEOUT_MS setting must be removed or explicitly changed to 270000 to use the new allowance.

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


## 1.0.3 capture and transport visibility

The listener is attached before login, but parses only the exact approved private event endpoint. Login responses, other API bodies, and public fallback event bodies are not collected. A public-only event fallback without private event data yields `UPSTREAM_AUTH`, not a successful empty catalog. Network origin restrictions are unchanged.

Safe application logs add `event_capture` with capped numeric `privateRequests`, `privateResponses`, `parsedResponses`, `publicResponses`, `authDenied`, and `failedRequests`. No URLs, headers, tokens, login bodies or event contents are logged. `response_finish` and `response_close` log only HTTP status, MIME enum (`json`, `text`, `other`, `none`), elapsed time and response-ended/finished/destroyed booleans. A finish record shows Node completed writing its response; it does **not** prove delivery through every proxy to the caller.

If browser cleanup cannot complete within 10 seconds, the operation fails with JSON 503 `BROWSER_ERROR` at `cleanup`, saves no fresh result, and quarantines new browser operations until the service is restarted. `/health` returns 503 while quarantined. This prevents launching new browser work beside an unclosed prior browser.

[Railway's documented network limit](https://docs.railway.com/networking/public-networking/specs-and-limits) is five minutes without transferred data. The bounded scrape stays below that limit, but an observed intermediary cut off the synchronous connection sooner. Version 1.0.4 therefore uses short async-job start/poll requests, with in-memory progress/results only; no credential store is introduced. [Workers HTTP requests](https://developers.cloudflare.com/workers/platform/limits/) can wait while the caller remains connected; a separate intermediary can still impose its own limit. Longer-than-five-minute work would require a separately reviewed asynchronous design.


## Async event jobs — recommended in 1.0.4

Use the same bearer authentication, server-only origin policy, strict credential body, one-browser lock and cooldown. The portal must bind each job to the authenticated owner; the service is a single trusted Fitler tenant, not an end-user authorization layer.

1. Before starting, the portal generates and persists a canonical lowercase UUID v4 for this explicit action. Send it as **`Idempotency-Key`** to `POST /api/scrape/jobs`, with the same `{email,password,max?}` body as the old endpoint. Do not log/store the credentials.
2. Start returns **202** promptly: `{ok:true,jobId,requestId,status:"running",phase:"accepted",startedAt,elapsedMs}`. `jobId` is exactly the supplied UUID. `requestId` is the separate generated operation ID used in safe Railway logs.
3. Poll authenticated `GET /api/scrape/jobs/:jobId` every three seconds. Running responses are 200 with the same metadata and actual current phase. No credentials are needed for a poll, and polling never starts or retries a login.
4. Success is 200 with `status:"succeeded"`, `finishedAt`, and `result` containing the complete existing success JSON (`ok:true`, events, true freshness and completeness). Only this result may replace the portal catalog.
5. Failure retains the original **non-2xx** status and returns `{ok:false,jobId,requestId,status:"failed",phase,startedAt,finishedAt,elapsedMs,error:{code,message,phase},result?}`. Optional `result` is an unchanged stale fallback, never a new success.

Repeated starts with the same retained key return the existing job without a second browser run, even if the submitted credential fields differ. No password/body fingerprint is retained. After an ambiguous/lost start response, the portal uses the already-persisted ID for **GET-only recovery**—it must not resend credentials. Unknown/expired/restarted jobs return 404 `JOB_NOT_FOUND`; a known key whose result was evicted returns 409 `JOB_EXPIRED` on a duplicate start. Neither authorizes an automatic restart.

Completed records and dedup keys expire after 10 minutes, with an unreferenced cleanup timer even while idle. At most 10 result records and 32 lightweight dedup keys are retained; older terminal results may be evicted earlier while their dedup tombstone remains. A running job is never evicted. Capacity exhaustion is 429 `JOB_LIMIT`. A fresh process loses all job state; the portal must retain its own attempt guard and not replay an unknown job. The legacy cache remains memory-only and keeps only the last successful catalog.

The detached job is still bounded by 270 seconds plus 10 seconds cleanup. It survives POST/poll connection closure, but service shutdown aborts it and waits for cleanup within the process shutdown guard. There is no automatic refresh or recurring credential access.

## Credential-free public-events bootstrap diagnostic

`POST /api/diagnostics/events` requires the same bearer token, `Content-Type: application/json`, and exactly `{}`. Reject credential fields. Gate the portal control on `capabilities.publicEventsDiagnostic === true`. This is separate from the unchanged blank-browser diagnostic.

A fresh isolated browser opens only the fixed public `/events` page, allows GET/HEAD on the approved origin, and blocks other origins, writes, WebSockets, downloads and media. It does not submit login, inspect cookie/storage values, read API bodies, or collect a catalog. Its total deadline is 60 seconds plus 10 seconds cleanup; callers should allow 80 seconds.

Observation response 200: `{ok:true,diagnostic:"public-events-bootstrap",version:"1.0.4",requestId,checkedAt,page}`. **This means the observation completed, not that authentication or event scraping works.** A page with zero event requests is reported as such, never a verified empty catalog. Errors use existing non-2xx typed errors with optional safe `page` evidence.

`page` permits only:
- `route`: `login`, `events`, `other_same_origin`, `outside_origin`, `unknown`.
- `readyState`: `loading`, `interactive`, `complete`, `unknown`.
- `documentStatus`: integer 100–599 or0; `snapshotAvailable`: boolean.
- Integer counters 0–10000: `requests`, `scriptRequests`, `scriptFailures`, `scriptHttpErrors`, `apiRequests`, `apiAuthDenied`, `apiHttpErrors`, `blockedExternalScripts`, `blockedExternalData`, `nonGetRequests`, `matchedPrivateEventRequests`, `matchedPublicEventRequests`, `eventEndpointsOtherGroup`, `eventEndpointsMissingGroup`, `pageErrors`, `moduleErrors`, `rootChildren`, `scriptElements`, `preloadElements`, `visibleEmailInputs`, `visiblePasswordInputs`, `eventLinks`, `cards`, `challengeFrames`.

The same allowlisted structural summary is included in real-scrape application logs. It contains no title, page text, screenshot, actual URL/query value, field value, token, header, cookie or raw exception. It helps distinguish a script/bootstrap failure, auth/interstitial page, different event group, and no matching requests without exposing private content.
