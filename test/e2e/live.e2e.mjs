// LIVE browser checks against real Nexconn (reconnect after a dropped socket; visible history failure).
// Not part of `npm test`. Needs Chrome + puppeteer-core and these env vars (never commit values):
//   NEXCONN_APP_KEY, NEXCONN_APP_SECRET   Nexconn app credentials (server side only)
//   SS_INVITES                            e.g. "<outcode>:out:wardx,<incode>:in:wardx"
//   E2E_OUT_CODE, E2E_IN_CODE             the two invite codes above
// Run: npm run build && node test/e2e/live.e2e.mjs        (CHROME=/path/to/chrome to override)
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { callApi } from '../../server/nexconn.mjs';
const need = ['NEXCONN_APP_KEY', 'NEXCONN_APP_SECRET', 'SS_INVITES', 'E2E_OUT_CODE', 'E2E_IN_CODE'];
for (const k of need) if (!process.env[k]) { console.error('missing env ' + k); process.exit(2); }
const PORT = 8792, BASE = process.env.NEXCONN_BASE_URL || 'https://api.sg-light-api.com', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn('node', ['server/app.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const WSPATCH = () => { const W = window.WebSocket; window.__ws = []; window.__block = false; window.WebSocket = function (u, p) { if (window.__block) return new W('wss://127.0.0.1:1/blocked'); const w = p ? new W(u, p) : new W(u); window.__ws.push(w); return w; }; window.WebSocket.prototype = W.prototype; ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => (window.WebSocket[k] = W[k])); };
let b; const res = {};
try {
  await sleep(1500);
  b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
  const open = async (name, code, hook) => { const p = await b.newPage(); await p.evaluateOnNewDocument(WSPATCH); if (hook) { await p.setRequestInterception(true); p.on('request', (r) => (hook(r) ? null : r.continue())); } await p.goto(`http://localhost:${PORT}/`); await p.type('input[name=name]', name); await p.type('input[name=code]', code); await p.evaluate(() => document.querySelector('form#lf button').click()); return p; };
  const ready = (p) => p.waitForSelector('#summary', { timeout: 20000 });
  // 1) reconnect: drop + block the incoming socket, post a card meanwhile, unblock, expect banner to clear and the card to arrive
  const out = await open('Anita', process.env.E2E_OUT_CODE); await ready(out);
  const inn = await open('Ravi', process.env.E2E_IN_CODE); await ready(inn); await sleep(3000);
  const n0 = await inn.$$eval('.card', (e) => e.length);
  await inn.evaluate(() => { window.__block = true; window.__ws.forEach((w) => w.close()); }); await sleep(3000);
  const set = (k, v) => out.$eval(`[name=${k}]`, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  for (const [k, v] of Object.entries({ bed: 'Bed 7', ageSex: '30 F', situation: 'Posted while incoming offline', background: 'Fictional', assessment: 'Observed ok', recommendation: 'Doctor to decide', stability: 'watch', tasks: 'Check obs at 3am' })) await set(k, v);
  await out.evaluate(() => document.querySelector('#form').requestSubmit()); await sleep(2500);
  const during = await inn.$$eval('.card', (e) => e.length), netDuring = await inn.$eval('#net', (e) => e.innerText);
  await inn.evaluate(() => { window.__block = false; });
  let after = during; for (let i = 0; i < 30 && after === during; i++) { await sleep(2000); after = await inn.$$eval('.card', (e) => e.length); }
  await sleep(4000); const netAfter = await inn.$eval('#net', (e) => e.innerText);
  res.reconnect = { offlineBannerShown: /offline/.test(netDuring), cardMissedWhileDown: during === n0, cardDeliveredAfter: after === n0 + 1, bannerClearedAfter: netAfter === '' };
  // 2) forced history failure: remove the user from the ward right after the session call, so the history query is refused; the UI must say so
  const hook = (r) => { if (!r.url().endsWith('/api/session') || r.method() !== 'POST') return false; (async () => { const sr = await fetch(r.url(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: r.postData() }); const body = await sr.json(); await callApi({ baseUrl: BASE, appKey: process.env.NEXCONN_APP_KEY, appSecret: process.env.NEXCONN_APP_SECRET, path: '/v4/group-channel/leave', body: { channelId: body.groupId, userIds: [body.userId] } }); r.respond({ status: sr.status, contentType: 'application/json', body: JSON.stringify(body) }); })(); return true; };
  const bad = await open('Gone' + (Date.now() % 1000), process.env.E2E_IN_CODE, hook); await ready(bad); await sleep(15000);
  const notice = await bad.$eval('#notice', (e) => e.innerText);
  res.historyFailure = { noticeShown: /Could not load earlier cards/.test(notice), notice };
} finally { if (b) await b.close(); srv.kill(); }
console.log(JSON.stringify(res, null, 1));
const ok = Object.values(res.reconnect).every(Boolean) && res.historyFailure.noticeShown;
process.exit(ok ? 0 : 1);
