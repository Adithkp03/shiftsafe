# ShiftSafe

Structured nurse shift handover on the Nexconn Chat SDK. Each patient is an SBAR card posted to a ward group channel as a custom message. A card cannot be posted until its 8 communication items are filled. The incoming nurse must read back and accept each card (the author cannot acknowledge their own card). Unacknowledged watch/critical cards escalate after a set window, and pending tasks are tracked to done.

**Honest limits:** demo with synthetic patients only. It is a communication aid, not a medical device. It never recommends treatment or diagnoses.

## Run
    npm install
    npm test
    npm run build && node server/app.mjs     # mock relay if no credentials

Live Nexconn mode needs `NEXCONN_APP_KEY` and `NEXCONN_APP_SECRET` in the server environment (Singapore base URL default `https://api.sg-light-api.com`). The secret never reaches the browser or this repo.

## Layout
- `core/handover.mjs` completeness, acknowledgement, escalation (pure, tested)
- `server/` token minting (signature per Nexconn docs) and local mock relay
- `client/` Vite app; `transport.js` has the Nexconn SDK and mock transports
