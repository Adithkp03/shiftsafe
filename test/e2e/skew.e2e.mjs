// Browser test: a device clock that is hours fast or slow must not change overdue status or elapsed times.
// Local mock relay (server-stamped timestamps), no secrets. Run: npm run build && node test/e2e/skew.e2e.mjs
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
const PORT = 8794, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn('node', ['server/app.mjs'], { env: { PATH: process.env.PATH, PORT: String(PORT) }, stdio: 'ignore' });
let b; const r = {};
try {
  await sleep(1500);
  b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
  const login = async (name, code, offsetMs = 0) => { const p = await b.newPage(); if (offsetMs) await p.evaluateOnNewDocument((o) => { const d = Date.now; Date.now = () => d() + o; }, offsetMs); await p.goto(`http://localhost:${PORT}/`); await p.type('input[name=name]', name); await p.type('input[name=code]', code); await p.evaluate(() => document.querySelector('form#lf button').click()); await p.waitForSelector('#summary', { timeout: 8000 }); return p; };
  const out = await login('Anita', 'demo-out');
  await out.evaluate(() => document.querySelector('#seed').click()); await sleep(2500);
  for (const [label, off] of [['normal', 0], ['clock3hFast', 3 * 3600e3], ['clock3hSlow', -3 * 3600e3]]) {
    const p = await login('Ravi' + label.length, 'demo-in', off); await sleep(1500);
    const lines = await p.$$eval('.card small', (e) => e.map((x) => x.innerText).filter((t) => /Handed over/.test(t)));
    const escalated = await p.$$eval('.card.esc', (e) => e.length);
    r[label] = { escalated, timing: lines.every((t) => /waiting (under 1 min|[1-3] min) since posting|acknowledged/.test(t)) };
    await p.close();
  }
} finally { if (b) await b.close(); srv.kill(); }
console.log(JSON.stringify(r, null, 1));
process.exit(Object.values(r).every((x) => x.escalated === 0 && x.timing) ? 0 : 1);
