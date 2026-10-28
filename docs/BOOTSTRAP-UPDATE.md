# Update the existing service to 1.0.5

1. Replace the repository contents with this extracted package, including `src`, `test`, manifests, Dockerfile and dotfiles. Never upload an actual `.env` or credentials.
2. Keep existing Railway variables and sandbox decision unchanged. No new variable, account, payment permission, plan upgrade or recurring job is needed.
3. Wait for deployment; `/health` must report **1.0.5**. The portal must include the matching failed-job envelope handling before a staff fetch.
4. Start at most one explicitly authorized staff run in the private portal. Never paste credentials into chat or logs. Allow up to 4½ minutes plus cleanup; the portal polls the same job rather than submitting another login.
5. Only a terminal successful, complete, untruncated result with fresh `fetchedAt` proves the catalog works. If it fails, inspect the safe request-ID-matched `event_capture` and `failed` logs; do not retry automatically.

## What the evidence established

The prior 1.0.4 service really finished with `NO_API_RESPONSES` at about 125.7 seconds; the portal later displayed an expiry. These are separate failures. The new job GET uses HTTP 200 for an existing resource, with `ok:false,status:"failed"` and the original failure status in `error.httpStatus`. A failed scrape is never presented as success, and stale data never gets a new timestamp.

Read-only public-source inspection found a concrete bootstrap dependency: the authenticated member-app wrapper includes its payment provider; when Stripe is configured, that provider withholds all child routes until the Stripe object initializes. The anonymous public configuration confirms a Stripe processor exists. The loader requests exactly `https://js.stripe.com/dahlia/stripe.js`. The former same-origin-only rule blocked that script. This is a **source-supported likely explanation**, not a live-confirmed catalog fix.

This update permits **only that exact public GET script**, with resource type `script`, no query, no credentials/referrer, no redirects and no response cookies. The live official response must be JavaScript, HTTP 200, and at most 2 MiB. No copied SDK is bundled. Stripe frames, API calls, telemetry, POSTs, payment creation/confirmation and all other external resources remain blocked. No payment UI is operated. The SDK may attempt ancillary requests; this package does not permit them or claim they are necessary for event rendering.

The public member app's Stripe constructor/Elements setup is synchronous before its route-rendering guard. This supports trying the minimal script-only allowance; actual browser rendering with all ancillary requests blocked remains unverified. See [Stripe.js loading](https://docs.stripe.com/js/including), [initialization](https://docs.stripe.com/js/initializing), and [Elements without an intent](https://docs.stripe.com/js/elements_object/create_without_intent).

## Additional bounded safeguards

- Independent job watchdog: abort at 270 seconds; if the scraper still has not settled after the 10-second cleanup grace, record terminal `TIMEOUT`, quarantine new browser work and keep the original lock until settlement/restart. Late success cannot update cache, job status or timestamps.
- DOM evidence checks stop waiting after five seconds. They never read field values, page text, storage or API bodies.
- Runtime evidence contains only fixed error/source/signature categories and numeric public-bundle line/column positions, at most five records. Additional counters distinguish failed Stripe/analytics/same-origin scripts. No raw exception, stack, URL, token or credential is logged.

The watchdog fixes a separately reproduced latent weakness; it was **not** the cause of the observed 125.7-second failure. Docker and authenticated live checks have not been run for this package. See `VERIFICATION.md`.
