# 1.0.2 — narrow the denied browser operation without a staff login

## What 1.0.2 adds (read this first)

The user's deployed 1.0.1 blank-browser check returned `BROWSER_HOST_RESTRICTION` at `browser_launch`, before any PeopleVine navigation. That proves a permission-denied startup operation, not which operation or which host policy caused it. The original safe logs correctly showed the category but omitted the discriminating component.

Version **1.0.2** adds `error.evidence` to that same authenticated no-login diagnostic, and a readable `message` field to its Railway log record. Both are assembled exclusively from fixed allowlists:

- `errno`: `EACCES`, `EPERM`, `ENOENT`.
- `components`: `sandbox_credentials`, `sandbox_namespace`, `sandbox_zygote`, `sandbox_setuid`, `process_singleton`, `crashpad`, `executable_spawn`, `shared_library_loader`.
- `signatures`: specific fixed identifiers such as `sandbox_credentials_permission_failure`, `namespace_permission_failure`, `executable_spawn_permission_denied`, or `unspecified_permission_denied`.
- `signals`: `SIGTRAP`, `SIGABRT`, `SIGKILL`, `SIGSEGV` when present in the startup exception.

It checks bounded `Error.message`, nested `cause`, and `stderr` strings internally. **No original message, command, path, line number, stack, secret, or page text is emitted.** Unknown detail stays unknown. Real staff-login scrape responses do not expose this additional evidence.

How to interpret the discriminator:

- `sandbox_credentials_permission_failure` / `namespace_permission_failure`: Chromium ran but a sandbox setup operation was denied. Existing error code becomes `BROWSER_SANDBOX_UNAVAILABLE`. This still does **not** identify seccomp versus AppArmor or another kernel/host policy.
- `executable_spawn_permission_denied`: the executable launch itself was denied; inspect executable/file/mount permissions instead of assuming a sandbox issue.
- `singleton_socket_permission_denied`: browser profile/process-singleton socket setup was denied; it is not proof of a namespace problem.
- `unspecified_permission_denied`: no more specific known signature; do not guess a cause.

Upload this update as before, confirm `/health` says **1.0.2**, and run **one** owner no-login browser check. In Railway logs, expand the `failed` record matching its request ID: `message` contains the recognized evidence summary even if the portal does not yet display additive evidence fields. Do not retry staff login yet. No environment, sandbox, image or dependency change is required by this update.

**This is a diagnosis update, not a browser fix.** Sandboxing remains enabled. Do not set `CHROMIUM_SANDBOX=false`, run the browser as root, add `SYS_ADMIN`, or use unconfined seccomp without a separate explicit risk decision. The official Playwright sandbox solution requires host support for the relevant namespace operations; a Dockerfile cannot itself grant host policy. Railway's official Playwright guide does not confirm that specific non-root sandbox configuration, so platform support or a verified sandbox-capable worker host may be needed after the discriminator is known.

The prior 1.0.1 explanation follows for context. Its version-specific examples should now be read as **1.0.2** when verifying the active update.

## What is established

- The reported deployment serves `/health` and correctly rejects invalid scrape input, so the HTTP service and authenticated request path work.
- The reported valid scrape requests failed rapidly (approximately 164–497 ms), before a normal complete login/scroll run could finish. No successful catalog exists.
- Read-only GitHub inspection of `gaberosenfeld/fitler-event-scraper`, default branch `main`, confirmed that `package.json`, `Dockerfile`, `src/app.js`, and `src/scraper.js` match the delivered 1.0.0 source. This does not independently establish which Git commit Railway is currently running.
- The repository was public at inspection. No credential files were opened. The connector has read access but no push permission. Nothing was pushed or deployed by this update's author.
- In 1.0.0, caught application errors are returned as JSON 502. A non-JSON 502 observed at the portal does **not** prove a Chromium sandbox issue or distinguish an application response from an edge/process failure.

## What this update changes

- New authenticated **`POST /api/diagnostics/browser`** accepts **only `{}`**. It launches the same Chromium configuration, creates an isolated blank page, evaluates `1 + 1`, and closes context/browser. It blocks all context HTTP/WebSocket requests. It never visits PeopleVine, submits credentials, or updates the event cache.
- Known browser-startup failures become fixed JSON **503** categories (sandbox unavailable, binary missing, dependencies missing, generic host restriction, launch/context/page/probe failure), rather than a generic application 502. This separates service-unavailable failures semantically; it is **not a guarantee** against hosting-edge response replacement or process termination.
- Both diagnostic runs and normal scrape runs emit privacy-safe JSON application logs: generated request ID, operation, fixed phase/category, elapsed milliseconds and service version. No email, password, token, input body, headers, URL, page content, raw exception text or stack is logged by this code.
- `/health` includes `version: "1.0.1"` and `capabilities: { "browserDiagnostics": true }` so the portal can detect the new endpoint before offering a check.
- Same bearer authentication, origin rejection, one-active-browser lock and 30-second cooldown. No automatic diagnosis, scrape, retry or recurring job.
- **Chromium sandboxing stays enabled.** No dependency/image change and no `--no-sandbox` flag is added. This is a diagnostic improvement, not a claim that the live scraper is fixed.

## Install the update

1. Download/extract the updated ZIP. Upload its contents to the same repository root, replacing existing files and including the new `src/diagnostics.js`. Do not upload `.env`, credentials, or `node_modules`. Keep existing Railway secrets and variables unchanged.
2. Committing to a branch connected to Railway can trigger deployment. Do this only when you intend that deploy. This package itself does not push or deploy.
3. After the deployment completes, open `/health` and confirm version `1.0.1` and `browserDiagnostics: true`. A plain old health response means the new code is not active yet.
4. Use the owner-only portal browser-startup check. It sends an authenticated server-to-server POST with `{}`; **no staff login is needed**. Do not type staff credentials into this diagnostic.
5. Inspect the returned fixed error code and request ID. In Railway, open the service's **application/deployment logs**, not only the HTTP request list. Match the request ID to a `phase` or `failed` log record. Share only those safe records (no environment values or unrelated logs).

## Interpret the result

| Result | Meaning / next step |
| --- | --- |
| 200 with `browser.pageEvaluated: true` | Browser startup works in this runtime; still does not verify PeopleVine login or events. Investigate the next safe phase from a separately authorized scrape. |
| `BROWSER_SANDBOX_UNAVAILABLE` | The browser's startup exception specifically reports sandbox/namespace failure. Review a sandbox-capable host/runtime first. Any `CHROMIUM_SANDBOX=false` change is a separate reduced-isolation decision requiring the owner's approval. |
| `BROWSER_BINARY_MISSING` | Rebuild from the supplied root Dockerfile; confirm the package and official browser image both use Playwright 1.64.1. |
| `BROWSER_DEPENDENCIES_MISSING` | Verify Dockerfile deployment uses the official image rather than a bare Node runtime. |
| `BROWSER_HOST_RESTRICTION` | The host reports a denied operation but the message does not prove sandbox failure. Investigate runtime permissions; do not infer that disabling the sandbox will fix it. |
| `BROWSER_LAUNCH_FAILED`, `BROWSER_CONTEXT_FAILED`, `BROWSER_PAGE_FAILED`, `BROWSER_PROBE_FAILED` | The fixed phase identifies how far startup got. More host/runtime evidence is needed; do not claim a specific root cause. |
| No JSON / gateway error / abrupt logs stop | Look for host crash/restart/resource evidence. A killed process cannot emit a final application error. Retain the request ID/last phase if available. |
| 409 / 429 | A browser operation is active or the cooldown applies. Wait; do not loop retries. |

## Verification boundaries

Local unit/security/mock-integration tests exercise startup classification, safe logs, credential rejection, no-network diagnostic behavior, resource cleanup, HTTP JSON 503, cache non-mutation and shared locking. Docker and a live Railway diagnostic are not available to the author here; no staff credentials were accessed or used. The next required evidence is **the deployed diagnostic result**, not another speculative config change.

Official guidance: [Playwright Docker sandbox requirements](https://playwright.dev/docs/docker), [Railway application-failed-to-respond troubleshooting](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond).
