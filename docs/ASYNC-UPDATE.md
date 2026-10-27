# Update the existing deployment to 1.0.4

1. Extract this ZIP. Upload the folder's **contents** to the same GitHub repository root, replacing the older source. Include the new `src/jobs.js`, `src/page-evidence.js`, `src/public-events-diagnostic.js`, tests and docs. Include the three dotfiles; never upload a real `.env`, staff credentials or `node_modules`.
2. Keep existing service secret and reviewed sandbox settings unchanged. No new secret, database, queue, paid service or credential variable is needed. Default/max `SCRAPE_TIMEOUT_MS` remains 270000; remove a lower override or set 270000 if the full allowance is wanted.
3. Wait for Railway deployment. `/health` must show version 1.0.4 and capabilities `asyncScrapeJobs:true` and `publicEventsDiagnostic:true`, alongside `browserDiagnostics:true`. Effective limits should show 270000/120000/10000 milliseconds unless a lower total override is intentional.
4. Wait for the matching portal update. Its event refresh now uses a short start request plus status polling, not one connection held open for several minutes.
5. Before another staff login, use **Check public events page** once in the owner's Connections panel. This needs no staff credentials. It reports only safe structural/network counts. Share the result with the person diagnosing the integration; a completed check is not evidence of a successful event catalog.
6. Only after reviewing that observation, use the private run-once staff form for one explicit event job. Do not repeatedly click or replay credentials. If a start response is lost, the portal checks the same job ID; it never starts another job automatically.

## What this fixes—and what it does not establish

The observed upstream 524 cutoff at about 125 seconds happened despite the portal's 300-second application timer. Short start/poll requests remove dependence on that long-lived connection. Idempotency prevents duplicate browser runs after an uncertain start.

The prior run also recorded zero event requests matching the exact event/group filter. That does not establish whether the event component mounted, whether a session was accepted, or whether some other request/group occurred. This update adds a credential-free way to inspect the public bootstrap and safe structural evidence for real runs. It does not guess a new API origin, weaken the target restriction, or claim the zero-event cause is fixed.

Today’s public HTML and JavaScript still point to the same-origin events endpoint and default `events` group. Public HTML advertises 993 module preloads; Playwright routing disables HTTP caching, but no live observation yet establishes that this is the failure cause. Network policy is unchanged.

The full scrape remains bounded at 270 seconds, with 10 seconds for cleanup. Completed job results/dedup keys expire after 10 minutes, max 10 full result records/max 32 keys, and all state is lost on restart. Unknown/expired jobs must not trigger automatic credential replay. Cleanup failure still quarantines new browser work until restart.

No deployment, GitHub write, staff login, sandbox-setting change, or recurring refresh is performed by this ZIP. See `VERIFICATION.md` for passed tests and unrun live/container checks.
