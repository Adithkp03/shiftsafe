# ShiftSafe

Structured nurse shift handover on the Nexconn Chat SDK. Each patient is an SBAR card posted to a ward group channel. A card cannot be posted until its 8 communication items are filled (our own design, not a clinical standard). The incoming nurse types a read-back and acknowledges each card; the author cannot acknowledge their own card. Pending tasks are tracked to done.

**Honest limits**
- Demo with synthetic patients only. A communication aid, not a medical device. It gives no medical advice or diagnosis.
- A read-back is text a nurse typed. The app records that it was typed; it cannot tell whether it is correct.
- "Not acknowledged in time" is a visual flag only (watch/critical cards, demo setting of 2 minutes shared by logic, UI and report; not a clinical standard). Nothing is sent to anyone: no alert, push or message.
- Times come from the server timestamp of each message, never from the poster's payload. The viewer's clock is corrected using the server time returned at sign-in and live messages; the correction is accurate to about network latency. An invalid or far-future timestamp shows "time unknown" and is never treated as overdue.
- Ward isolation relies on Nexconn group membership: the server adds a user to a ward group only after an invite code check. Tested at SDK level (other-ward user and removed member are refused). The "Restrict chat history access to members" Console setting was left unchanged and its exact semantics were not established, so no blanket privacy claim is made. "Enable pre-join history access by new member" must be Allowed in the Nexconn Console so a newly added nurse can read cards already posted.
- Free-plan custom message types were not delivered in our test, so card/ack/task payloads travel as JSON inside a built-in text message with the prefix `SS1:`.
- Identity: personal access keys (below) give each person a server-bound identity. Shared invite codes still work unless `SS_LEGACY_INVITES=0`; with a shared code the person types any name, so that name is unverified. Personal keys have no database behind them: a key cannot be revoked individually except by listing its id in `SS_REVOKED` (a redeploy picks it up), and rotating `SS_SIGNING_KEY` invalidates all keys. There is no login rate limiting, no password, no second factor and no account recovery. A leaked key works until it expires (default 14 days, max 90).

## Run
    npm install
    npm test                                  # unit tests (core logic, token signing)
    npm run build && node server/app.mjs      # local mock relay when no credentials are set (demo codes demo-out / demo-in)

Live mode needs these server environment variables (never commit values):
- `NEXCONN_APP_KEY`, `NEXCONN_APP_SECRET`: Nexconn app credentials (Singapore default base URL `https://api.sg-light-api.com`, override with `NEXCONN_BASE_URL`).
- `SS_SIGNING_KEY`: 32+ character secret that signs personal access keys (comma-separate several to rotate; the first one signs). Optional `SS_REVOKED` (comma list of key ids) and `SS_LEGACY_INVITES=0` to turn shared invite codes off.
- `SS_INVITES`: comma list of `code:role:ward`, e.g. `<code>:out:wardx,<code>:in:wardx` (role `out` or `in`). `SS_INVITES_EXTRA` is appended for additional wards.

## Personal access keys
    SS_SIGNING_KEY=<secret> node scripts/issue-credential.mjs --name Priya --role out --ward wardx --days 14
Prints one key (`ssk1...`) to stdout and its id to stderr. The person pastes the key into the login form; the name, role and ward come from the signed key and the user id is derived server-side, so nobody can pick or impersonate another identity. Hand keys over through a secret channel, never chat or email in clear.

## Revoking someone
    NEXCONN_APP_KEY=... NEXCONN_APP_SECRET=... node scripts/revoke-user.mjs --user-id outp1a2b3c4d5e6f --ward wardx
Expiring a key or listing it in `SS_REVOKED` only stops NEW sign-ins; a person who already has a Nexconn token and an open connection keeps working. `revoke-user.mjs` cuts the live access in three layers: expire the user's Nexconn tokens (reconnect then fails), remove the user from the ward group (history and send are refused), and ban the user (max 30 days, Nexconn's limit; terminates the live connection at once). Nexconn tokens are valid indefinitely by default (a Console setting we did not change). The ban lasts at most 30 days. Token expiry and group removal do NOT by themselves keep a revoked person out afterwards: while their key is still valid and not listed in `SS_REVOKED` in the DEPLOYED environment, signing in again mints a fresh token and re-adds them to the ward group. So a complete revoke is: run `revoke-user.mjs` (cuts the open session now), add the key id (printed by `issue-credential.mjs`) to `SS_REVOKED`, and redeploy. Until that redeploy happens the person can come back. To replace a lost or leaked key, revoke that one key and issue a new one; do not rotate `SS_SIGNING_KEY`, which would invalidate everyone. Tested live in `test/e2e/revoke.live.e2e.mjs`.
Failed sign-ins are throttled per client (10 per 10 minutes) in memory per server instance. This is not a production rate limiter: each serverless instance counts separately and counters reset on a cold start. Requests over 10 KB or keys over 2000 characters are rejected.

## Browser tests (need Chrome and `puppeteer-core`, not installed by default)
    npm run build
    node test/e2e/typing.e2e.mjs     # draft survives timer ticks and incoming messages
    node test/e2e/report.e2e.mjs     # report download scope and content, filter keeps drafts, mobile layout
    node test/e2e/auth.e2e.mjs       # personal keys: name from key, tampered/wrong-key/legacy-off rejected
    node test/e2e/skew.e2e.mjs       # device clock hours off does not change overdue status
    node test/e2e/revoke.live.e2e.mjs # LIVE: revoke cuts an open session and reconnect, other members unaffected
    node test/e2e/isolation.live.e2e.mjs # LIVE SDK level: other-ward user and removed member refused (starts Vite dev server)
    node test/e2e/live.e2e.mjs       # LIVE Nexconn: reconnect after socket drop, visible history failure
`live.e2e.mjs` needs the env vars above plus `E2E_OUT_CODE` and `E2E_IN_CODE`; set `CHROME=/path/to/chrome` if needed.

## Layout
- `core/handover.mjs` completeness, acknowledgement, overdue flag, timing, report text (pure, tested)
- `server/auth.mjs` signed personal access keys and the single authenticate() used by the server and the Vercel function
- `scripts/issue-credential.mjs` issues a key; `scripts/revoke-user.mjs` cuts live access; `server/throttle.mjs` failed-login throttle
- `server/` token minting and ward joins (signature per Nexconn docs) plus the local mock relay
- `api/` Vercel serverless functions (`session`, `config`)
- `client/` Vite app; `transport.js` has the Nexconn SDK and mock transports

## Deployment
Vercel serverless functions in `api/` plus the Vite client in `dist/`. Set the env vars above in the host; keep the repo private.

## Recovery
`SS_LEGACY_INVITES=0` (shared invite codes off) is set in the host environment and takes effect with the next deployment; check the live app to see whether it is in force. The signing key exists only as a write-only Vercel env value, so nobody can read it back. Only if the signing key itself is lost or leaked: set a new `SS_SIGNING_KEY` (32+ random characters), redeploy, and issue keys again; every older key then stops working. To fall back temporarily to shared invite codes, set `SS_LEGACY_INVITES=1` (the `SS_INVITES` values are still in place) and redeploy.

## Status
MVP plus personal access keys. See limits above.
