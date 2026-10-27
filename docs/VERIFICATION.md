# Verification — 2026-10-27

## Diagnostic update 1.0.1 (later same day)

- `npm run check`: **35 passing tests**, zero failures, after adding authenticated blank-page browser diagnostics and safe phase/category logging.
- Added tests cover known sandbox/binary/dependency/host-restriction categories, fixed safe error text, phase log allowlisting, network/WebSocket blocking, acquired resource closure, cancellation, authenticated HTTP JSON 503, credential-field rejection, no catalog/cache mutation, and a shared diagnostic/scrape lock and cooldown.
- Read-only access to `gaberosenfeld/fitler-event-scraper` succeeded. The `main` branch's package manifest, Dockerfile, scraper and Express app matched the original ZIP byte-for-byte (Git blob hashes verified). The connector reported public visibility and read-only/pull permission, no push permission. No files were written to GitHub, no secret files were opened and no deployment was performed.
- The user-reported live deployment's early non-JSON 502 is **not a proven root cause**. The new diagnostic endpoint has **not yet been deployed or run on Railway**. Sandbox stays enabled, dependency/browser image versions are unchanged, and no staff credentials were requested or used.
- The original runtime/browser limits below still apply. The update fixes missing diagnostic visibility and typed startup errors; it is not a verified fix for live event scraping. See `DIAGNOSTIC-UPDATE.md` for the required deployed check.

## Original package verification (1.0.0)

## Passed

- Verified the authoritative uploaded `beta.zip` SHA-256: `771384031c2b19aab6a23187246ea969decac4ce0e5756de82ae4e3a21ee3a8a`; original archive was not modified.
- `npm ci --ignore-scripts` installed the locked dependencies without executing package lifecycle scripts.
- `npm run check`: syntax checks plus **28 passing unit/security/mock-integration tests**, zero failures.
- `npm audit --omit=dev`: **zero reported vulnerabilities** at verification time. This is not a guarantee that no vulnerabilities exist.
- Tested exact-origin API matching; complete multi-page collection via response pagination; de-duplication; genuine empty versus no API responses; unknown/malformed schema; incomplete/changed totals; event, response-count and byte limits.
- Tested required authentication, rejection of browser origins/arbitrary target fields, JSON/input/body-size constraints, credential-safe error responses, one active scrape, cooldown, cache-only-after-success, and unchanged stale timestamps after failure.
- Tested New York summer/winter conversion, spring DST gap rejection and fall DST ambiguity flagging; IDs/URLs/summary/HTML/images/categories preserved.
- Mock browser tests cover two-step sign-in, response capture, completed scrolling, isolated-browser cleanup, login/API authentication failures, no responses, partial pagination, context-creation failure, cancellation and deadline expiry during launch.
- Checked that the Playwright package, core package, lock, and official Docker image all specify **1.64.1**, that the container is non-root, and that credential placeholders are empty and `.env` excluded.
- Inspected public, unauthenticated member-portal HTML/JavaScript only. Current public code describes `Pagination` response-header metadata (`totalCount`, `totalPages`, `hasNextPage`, or snake_case equivalents) and `pageNumber`/`pageSize` pagination. This informed completeness checks. **No private catalog or staff login was accessed.**

## Blocked / not passed

- **Docker build/container launch not run:** Docker/Podman is not available in this execution environment. The official image's Chromium launch, host resource behavior, kernel sandbox support, and health check must still be tested on Railway/Render.
- **Real-browser offline fixture did not run successfully here:** the pinned Chromium download returned an invalid/truncated archive; the installed system Chromium could not launch under this environment's process/socket restrictions (`socket() failed: Operation not permitted`, plus crashpad setup errors). This is not a passing browser check and does not establish Railway behavior. `test/browser-smoke.mjs` is included for an operator to run with the pinned browser on a capable machine; all network responses in that fixture are intercepted locally and it never logs into PeopleVine.
- **Live staff login, private event collection, Railway/Render deployment, and end-to-end portal integration not run.** No hosting account, subscription, real service secret, or stored staff credentials were created.

## Required before saying “live events are working”

1. Deploy the image to the user's chosen host with private `SCRAPER_SHARED_SECRET`, `HEADLESS=true`, and one replica.
2. Confirm `/health` returns 200 and protected endpoints reject missing/wrong auth.
3. Verify Chromium launches with sandbox enabled. If the host disallows it, review the README's explicit security tradeoff before changing `CHROMIUM_SANDBOX`; do not assume success or silently weaken it.
4. Wire the portal backend proxy with the matching private secret and authenticated staff access.
5. Perform one authorized credential-supplied run and verify complete pagination, returned event count, true freshness, event links, HTML sanitization, images and New York times against the portal.
6. Verify that an error keeps the previous catalog visibly stale and does not update its timestamp.

No recurring refresh has been enabled.
