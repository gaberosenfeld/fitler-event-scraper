# Update an existing deployment to 1.0.3

1. Extract the new ZIP. In GitHub, upload the **contents** of `fitler-railway-scraper` into the same repository root, replacing the old files. Include `src`, `test`, `docs`, the package files, and the three dotfiles (Finder: Command–Shift–Period). Never upload a real `.env`, credentials, or `node_modules`.
2. Keep existing service authentication and reviewed sandbox settings unchanged. No new secret or staff-password variable is needed. If you previously set `SCRAPE_TIMEOUT_MS` below 270000, remove that override or set it to **270000**. Do not add paid services or an automatic schedule.
3. Wait for Railway's deployment to finish. Open `/health`: check `version:"1.0.3"` and `limits:{totalTimeoutMs:270000,firstResponseWaitMs:120000,cleanupTimeoutMs:10000}`. Health alone does not prove event scraping. The portal also needs its matching **300-second** wait update before a slow run.
4. Only after both updates are ready, use the portal's private form for one authorized run. Keep the tab open; a full run may take several minutes. Do not repeatedly click refresh or resend credentials. Success requires `ok:true`, `complete:true`, `cached:false`, `stale:false`, and a genuinely new `fetchedAt`.

## What changed

- The event-response listener is registered before login, matching the uploaded build. It never parses the login response/body.
- A parsed successful **private** event response is required before scroll settling begins. It may take up to 120 seconds to arrive. A public-only fallback is not accepted as a staff catalog.
- Slow pagination keeps waiting/scrolling until API totals/end markers plus a settled page prove completion, within the overall 270-second limit. Pending parsing must finish. Missing data never becomes a fresh empty/partial catalog.
- Browser cleanup runs concurrently and has a 10-second bound. Failure quarantines new browser work until restart rather than allowing a second browser alongside an unclosed one.
- Safe numeric capture counters and response-finish/close metadata help explain any remaining failure. No password, email, cookie, token, URL, raw exception, request body, or event content is logged.

## What is not established

This package fixes two reproduced source bugs, not a verified live result. It does not prove that the prior staff session was authenticated, that this host will complete the catalog, or why Railway's caller previously saw text/plain instead of JSON. It does not change the reviewed sandbox setting, broaden network access, push to GitHub, or deploy itself.

If a run fails, do not repeat credentials automatically. Share only the request UUID and the safe application-log rows for `event_capture`, `failed`, `response_finish`, and `response_close`. Redact anything unrelated. A `response_finish` JSON record proves Node wrote JSON, not that every proxy delivered it.
