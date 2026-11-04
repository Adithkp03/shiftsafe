// LIVE Nexconn: revoking a person must cut their EXISTING session and their ability to reconnect, not only new sign-ins.
// Needs NEXCONN_APP_KEY and NEXCONN_APP_SECRET (never commit values). Uses a throwaway signing key and a fresh ward.
// Run: npm run build && node test/e2e/revoke.live.e2e.mjs        (CHROME=/path/to/chrome to override)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { signCredential } from '../../server/auth.mjs';
import { revokeUser } from '../../server/nexconn.mjs';
for (const k of ['NEXCONN_APP_KEY', 'NEXCONN_APP_SECRET']) if (!process.env[k]) { console.error('missing env ' + k); process.exit(2); }
const BASE = process.env.NEXCONN_BASE_URL || 'https://api.sg-light-api.com', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SK = randomBytes(24).toString('hex'), ward = 'wardrev' + Date.now().toString(36);
const mint = (name, role) => { const { credential, payload } = signCredential({ key: SK, name, role, ward }); return { credential, userId: payload.role + 'p' + payload.pid, jti: payload.jti }; };
const start = (port, extra = {}) => spawn('node', ['server/app.mjs'], { env: { ...process.env, PORT: String(port), SS_SIGNING_KEY: SK, SS_LEGACY_INVITES: '0', ...extra }, stdio: 'ignore' });
const s1 = start(8796), s2 = (() => null)(); let s2p = null, b; const res = {};
try {
  await sleep(1500);
  b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
  const open = async (port, cred) => { const p = await b.newPage(); await p.goto(`http://localhost:${port}/`); await p.type('input[name=code]', cred); await p.evaluate(() => document.querySelector('form#lf button').click()); await Promise.race([p.waitForSelector('#summary', { timeout: 20000 }), p.waitForFunction(() => document.querySelector('#lf .err, .err, [role=alert]')?.innerText, { timeout: 20000 })]).catch(() => {}); return p; };
  const A = mint('Priya', 'out'), B = mint('Anita', 'in');
  const pa = await open(8796, A.credential), pb = await open(8796, B.credential); await sleep(3000);
  const set = (k, v) => pa.$eval(`[name=${k}]`, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  const post = async (bed) => { for (const [k, v] of Object.entries({ bed, ageSex: '30 F', situation: 'Fictional', background: 'Fictional', assessment: 'Observed ok', recommendation: 'Doctor to decide', stability: 'watch', tasks: 'Check obs' })) await set(k, v); await pa.evaluate(() => document.querySelector('#form').requestSubmit()); await sleep(3000); };
  await post('Bed 1'); const before = await pb.$$eval('.card', (e) => e.length);
  res.beforeRevoke = { postedAndReceived: before === 1 };
  const rv = await revokeUser({ baseUrl: BASE, appKey: process.env.NEXCONN_APP_KEY, appSecret: process.env.NEXCONN_APP_SECRET, userId: A.userId, wardId: ward });
  res.revokeCalls = rv;
  let off = false; for (let i = 0; i < 20 && !off; i++) { await sleep(1500); off = /offline/.test(await pa.$eval('#net', (e) => e.innerText).catch(() => '')); }
  res.existingSessionCut = off;
  await post('Bed 2').catch(() => {}); const after = await pb.$$eval('.card', (e) => e.length);
  res.postAfterRevokeNotDelivered = after === before;
  // new sign-in with the same, still-valid key: Nexconn itself must refuse (ban + expired tokens), without any SS_REVOKED help
  const pr = await open(8796, A.credential); await sleep(1500);
  res.reloginBlockedByProvider = !(await pr.$('#summary'));
  // and with SS_REVOKED the server refuses to mint at all
  s2p = start(8797, { SS_REVOKED: A.jti }); await sleep(1500);
  const px = await open(8797, A.credential); res.mintRefusedWhenListed = /invalid or expired access key/.test(await px.evaluate(() => document.body.innerText));
  // the untouched member is unaffected
  res.otherMemberStillConnected = !/offline/.test(await pb.$eval('#net', (e) => e.innerText));
} finally { if (b) await b.close(); s1.kill(); if (s2p) s2p.kill(); }
console.log(JSON.stringify(res, null, 1));
process.exit(res.beforeRevoke?.postedAndReceived && res.revokeCalls?.ok && res.existingSessionCut && res.postAfterRevokeNotDelivered && res.reloginBlockedByProvider && res.mintRefusedWhenListed && res.otherMemberStillConnected ? 0 : 1);
