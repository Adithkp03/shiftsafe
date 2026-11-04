// Browser test: personal access keys. Name comes from the signed key, not the form; tampered keys fail; legacy codes off.
// Local mock relay, throwaway signing key generated here, no secrets. Run: npm run build && node test/e2e/auth.e2e.mjs
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { signCredential } from '../../server/auth.mjs';
const PORT = 8795, KEY = randomBytes(24).toString('hex'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn('node', ['server/app.mjs'], { env: { PATH: process.env.PATH, PORT: String(PORT), SS_SIGNING_KEY: KEY, SS_LEGACY_INVITES: '0' }, stdio: 'ignore' });
const key = (name, role) => signCredential({ key: KEY, name, role, ward: 'wardx' }).credential;
let b; const r = {};
try {
  await sleep(1500);
  b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
  const attempt = async (name, code) => { const p = await b.newPage(); await p.goto(`http://localhost:${PORT}/`); if (name) await p.type('input[name=name]', name); await p.type('input[name=code]', code); await p.evaluate(() => document.querySelector('form#lf button').click()); await Promise.race([p.waitForSelector('#summary', { timeout: 6000 }), p.waitForFunction(() => /invalid/i.test(document.body.innerText), { timeout: 6000 })]).catch(() => {}); return p; };
  const out = await attempt('Hacker', key('Priya', 'out'));
  r.nameFromKey = /Priya · outgoing/.test(await out.$eval('header', (e) => e.innerText));
  const inn = await attempt('', key('Anita', 'in'));
  r.incomingRole = /Anita · incoming/.test(await inn.$eval('header', (e) => e.innerText)) && !(await inn.$('#form'));
  const good = key('Eve', 'in'), tampered = good.slice(0, -3) + (good.endsWith('AAA') ? 'BBB' : 'AAA');
  const t = await attempt('Eve', tampered); r.tamperedRejected = /invalid or expired access key/.test(await t.evaluate(() => document.body.innerText)) && !(await t.$('#summary'));
  const l = await attempt('Ravi', 'demo-in'); r.legacyOffRejected = !(await l.$('#summary'));
  const wrongKey = signCredential({ key: 'q'.repeat(40), name: 'Eve', role: 'out', ward: 'wardx' }).credential;
  const w = await attempt('', wrongKey); r.wrongKeyRejected = !(await w.$('#summary'));
} finally { if (b) await b.close(); srv.kill(); }
console.log(JSON.stringify(r, null, 1));
process.exit(Object.values(r).every(Boolean) ? 0 : 1);
