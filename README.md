# Fitler event scraper — Railway setup

**Already deployed but getting an early 502?** This is diagnostic update **1.0.1**. Follow [`docs/DIAGNOSTIC-UPDATE.md`](docs/DIAGNOSTIC-UPDATE.md) to test browser startup without a staff login. It preserves sandboxing and does not claim the live issue is fixed.

This is **only the private event-scraping service**, adapted from your uploaded `beta.zip`. Keep the existing portal hosted where it is. Do not upload the old React/Vite frontend or the old `.env` to this repository.

The service signs into `https://member.fitlerclub.com` with staff credentials supplied for **one run**, opens `/events`, captures `/api/events?group=events` responses, and scrolls through the catalog. It preserves event IDs, links, short summaries, full source HTML, images, categories, locations, and New York event times.

**Prepared and tested locally; not deployed or proven against a staff login yet.** The final live check requires your deployed URL, private server-to-server secret, and an authorized staff login. `/health` only proves that the server is running—not that a scrape succeeded.

## What you need

- This extracted folder on your Mac.
- Your own GitHub and Railway accounts.
- A **private** GitHub repository containing this folder's **contents at the repository root**.
- One new, strong secret from your password manager, at least 32 characters (32–256 printable ASCII characters, no spaces). Keep it private; this package contains **no real secret**.
- Review Railway's plan, resource limits, and spending controls yourself before accepting charges. No paid deployment was created for you.

## 1. Put the files on GitHub — no Terminal required

1. Download `fitler-railway-scraper.zip` and double-click it in Finder.
2. Open the extracted `fitler-railway-scraper` folder. You should see `Dockerfile`, `package.json`, `package-lock.json`, `railway.json`, `README.md`, `src`, `test`, and `docs`.
3. Press **Command–Shift–Period** in Finder to reveal the three dotfiles: `.gitignore`, `.dockerignore`, and `.env.example`. Include these in the upload. There should be **no actual `.env`**, `node_modules`, staff password, or browser session file.
4. On GitHub, choose **New repository**, give it a name such as `fitler-events-scraper`, and choose **Private**. Create it. If GitHub asks about initializing a README, leave that unchecked because this package already has one.
5. Use **uploading an existing file** (or **Add file → Upload files**). Drag the **contents inside** `fitler-railway-scraper` into the upload area, including the dotfiles and folders—not the ZIP and not an extra enclosing folder.
6. Commit the upload. Confirm that `Dockerfile` and `package.json` are visible at the top level. GitHub's file uploader does not protect secrets for you: never upload a real `.env`, even though `.gitignore` excludes it from normal Git operations.

## 2. Create the Railway service

1. In Railway, choose **New project → Deploy from GitHub repo** and authorize access to this specific private repository.
2. Select `fitler-events-scraper`. Railway detects the root `Dockerfile`; `railway.json` supplies the health check and one-replica setting.
3. Open the service's **Variables** and add:

   | Variable | Value |
   | --- | --- |
   | `SCRAPER_SHARED_SECRET` | Your private, strong secret (not a staff password) |
   | `HEADLESS` | `true` |

   Do **not** add staff email/password variables. Do **not** add `BASE_URL`, `LOGIN_URL`, or `EVENTS_URL`: the approved target is fixed in code. Railway supplies `PORT`; the server binds to `0.0.0.0` using that value. Local fallback is `5174`.

4. Under **Settings**, verify:
   - Builder: **Dockerfile**, path `Dockerfile`.
   - Root directory: the repository root (leave the default if you uploaded correctly).
   - Start command: leave unset; the image already runs `node src/server.js`.
   - Health-check path: **`/health`**; timeout **120 seconds**.
   - Replicas: **1**. Cache, cooldown, and single-flight protection are process-local.
   - No cron job, recurring refresh, public volume, or database is needed.
5. Deploy/redeploy after saving the variables. An initial attempt before the secret is set may fail safely; set the variables and redeploy rather than weakening authentication.
6. In **Settings → Networking → Public Networking**, choose **Generate Domain**. Use Railway's detected target port; the service honors `PORT`. Railway terminates HTTPS. Keep all external calls on the generated **HTTPS** URL.
7. Open `https://YOUR-RAILWAY-DOMAIN/health`. Expected result:

   ```json
   {"ok":true,"service":"fitler-events-scraper"}
   ```

8. Send the **base URL only** to whoever is wiring the portal. Configure the matching `SCRAPER_SHARED_SECRET` in the portal's **server-side secret store** through a private setup flow. Do not paste it into chat, the website UI, source code, a screenshot, or a `VITE_`/public environment variable.

Railway references: [Dockerfile builds](https://docs.railway.com/builds/dockerfiles), [health checks and PORT](https://docs.railway.com/deployments/healthchecks), [HTTPS public networking](https://docs.railway.com/networking/public-networking).

## 3. Connect and verify the demo

The portal must make a **server-to-server** request using the contract in [`docs/API.md`](docs/API.md). Browser-origin requests are deliberately rejected. The portal's backend must authenticate the staff user before forwarding a scrape, protect against CSRF, avoid logging request bodies, and hold the service secret privately.

For the first real run:

1. Verify the deployed health endpoint and an unauthenticated `/api/events` returning `401`.
2. Enter authorized staff credentials only in the portal's private run-once login form. The portal sends them in the request body, never a URL. Do not save them in browser storage.
3. Start a scrape once. Allow up to 90 seconds plus network overhead; set the portal proxy timeout to at least 105 seconds. A second concurrent attempt is rejected.
4. Confirm `ok: true`, `complete: true`, `cached: false`, `stale: false`, a new `fetchedAt`, and the expected number of events. Spot-check at least one event link, rich description, image, and New York date against the member portal.
5. A login error, missing API response, timeout, limit, or unverified pagination is **not success**. Keep any prior events visibly labeled **last successful / stale**, preserving the original timestamp.

There is **no automatic 30-minute refresh** and no stored staff login. Scheduling or persistent credentials require a separate decision and authorization.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Startup says `Set SCRAPER_SHARED_SECRET…` | Set a private 32–256-character secret; redeploy. Never remove the auth middleware. |
| Health is good but scrape says `BROWSER_ERROR` | Check Railway process/resource logs for browser startup issues without enabling request-body, Playwright protocol, or password logging. The image includes matching browsers/dependencies. |
| Chromium reports user namespace/sandbox restrictions | The container runs as non-root and **keeps Chromium sandboxing enabled by default**. Some hosted container kernels disallow it. Prefer a host that supports Chromium's sandbox. An operator can explicitly set `CHROMIUM_SANDBOX=false` only after accepting the reduced browser isolation; this is not silently done. The fixed-origin network boundary remains, but it is not a replacement for an OS sandbox. |
| `LOGIN_FAILED` / `LOGIN_CHANGED` | Check credentials and whether PeopleVine requires a verification/MFA step or changed its form. No bypass or hidden retries are attempted. |
| `NO_API_RESPONSES` | Check whether the portal still uses the expected authenticated `/api/events?group=events` endpoint. Do not treat this as “zero events.” |
| `PAGINATION_INCOMPLETE` | A response failed, the scroll stopped before the reported total, or pagination proof changed. Preserve the old catalog and investigate; do not silently accept partial results. |
| `EVENT_LIMIT` | Default cap is 500 events. If appropriate, set `MAX_EVENTS` up to 1000; ensure timeout and host resources are adequate. Requests may ask for a lower `max`, but it is a **safety cap**, not “return the first N.” An over-cap catalog fails rather than truncating. |
| `429` / `409` | Respect `Retry-After` / wait for the running scrape. Default cooldown is 30 seconds and only one browser run is allowed. |
| Cache disappears after redeploy/restart | Expected: cache is private memory only. Run a new authorized scrape; do not call old events fresh. |

## Local Mac development (optional)

Use Node 22 or 24 and run from this folder:

```sh
npm ci --ignore-scripts
npx playwright install chromium
cp .env.example .env
```

Set your own `SCRAPER_SHARED_SECRET` in the ignored `.env`, leave the staff credential placeholders blank, and keep `HEADLESS=false` to watch the browser locally. `PORT=5174` matches the original local server. Then:

```sh
npm run check
npm start
```

The original upload's Playwright lock was 1.54.2. This package pins Playwright **1.64.1** with matching official image **`mcr.microsoft.com/playwright:v1.64.1-noble`**. Do not upgrade only one side. Dependency lifecycle scripts are disabled during installation. The intentional browser-install command above uses the pinned, patched Playwright CLI. [Advisory GHSA-7mvr-c777-76hp](https://github.com/advisories/GHSA-7mvr-c777-76hp) affects versions below 1.55.1; [Microsoft Docker guidance](https://playwright.dev/docs/docker) explains matching versions and sandbox requirements.

## Render instead of Railway

Use the same private repository and create a **Web Service**, not a Static Site. Select **Docker** as the language/runtime, root Dockerfile path `Dockerfile`, leave Docker Command unset, set the same `SCRAPER_SHARED_SECRET` and `HEADLESS=true`, set health path `/health`, and keep one instance. The service uses Render's `PORT` and HTTPS endpoint. The same sandbox/resource caveats and first-live-run checklist apply. Review the selected plan and any charges yourself. [Render Docker documentation](https://render.com/docs/docker).

## Security and verification

- One fixed HTTPS target origin; other browser network origins, WebSockets, downloads, popups, fonts, images, and media requests are blocked. This keeps scraping narrow and reduces resource usage; a future portal requiring cross-origin assets needs explicit review.
- Per-run isolated browser/context, closed after success or failure. No password logs, screenshots, traces, session saves, persistent cookies, or credential cache. Staff credentials exist transiently in process/browser memory and are not persisted. Application strings cannot guarantee cryptographic memory erasure.
- 16 KiB client body limit; 90-second scrape deadline (maximum configurable 120 seconds); 80 scrolls; 120 API responses; 4 MiB per event API response; 12 MiB collected response bytes; 500 events by default. HTTP connection/header limits and request throttles are also applied. Use host-level access controls/rate limiting for internet-scale abuse.
- API totals, end-of-page metadata (including the PeopleVine `Pagination` header), or an explicit empty/short API page are required **in addition to** settled, completed scrolling. Returned catalogs are never silently sliced.
- Source HTML is **untrusted and intentionally preserved**. The portal must sanitize it with a maintained allowlist sanitizer before rendering; never load it into an unsanitized `iframe`/`srcDoc`. Encode titles, text and attributes; validate links/images. There is no frontend in this package.
- Event time zone is `America/New_York`. Offset-less local values use New York DST rules, not the Docker server time zone. A nonexistent spring-forward wall time fails; ambiguous fall-back local times choose the earlier occurrence and set `ambiguousLocalTime: true` for review.
- Only a complete successful scrape changes cached events and `fetchedAt`. Failure remains non-2xx even when stale prior data is returned. Cache is shared only with the trusted authenticated portal service, not public users; the portal must enforce staff access to this single Fitler tenant.

See [`docs/VERIFICATION.md`](docs/VERIFICATION.md) for exactly what was and was not run.

### Source provenance

Adapted from the user's latest `beta.zip`, SHA-256 `771384031c2b19aab6a23187246ea969decac4ce0e5756de82ae4e3a21ee3a8a`. The original upload is unchanged. The two-step login selectors and response-driven scrolling approach are retained; frontend/email rendering, unsafe generic CORS, silent partial/empty handling, unbounded collection, and unsafe server-time-zone formatting are not.
