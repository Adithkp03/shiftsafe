// Browser regression: a half-typed read-back must survive 1s timer ticks AND incoming messages.
// Not part of `npm test` (needs Chrome + puppeteer-core). Run: npm run build && node test/e2e/typing.e2e.mjs
// Uses the local mock relay (no Nexconn secrets). CHROME=/path/to/chrome to override.
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
const PORT = 8791, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn('node', ['server/app.mjs'], { env: { PATH: process.env.PATH, PORT: String(PORT) }, stdio: 'ignore' });
let b; let ok = false;
try {
  await sleep(1500);
  b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
  const login = async (name, code) => { const p = await b.newPage(); await p.goto(`http://localhost:${PORT}/`); await p.type('input[name=name]', name); await p.type('input[name=code]', code); await p.evaluate(() => document.querySelector('form#lf button').click()); await p.waitForSelector('#summary', { timeout: 8000 }); return p; };
  const out = await login('Anita', 'demo-out'), inn = await login('Ravi', 'demo-in');
  await out.evaluate(() => document.querySelector('#seed').click()); await sleep(2500);
  await (await inn.$('.ack textarea')).click();
  await inn.keyboard.type('Bed 3 child after fall, ', { delay: 30 });
  await sleep(3500); // several 1s ticks
  const v1 = await inn.$eval('.ack textarea', (e) => e.value);
  const set = (k, v) => out.$eval(`[name=${k}]`, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  for (const [k, v] of Object.entries({ bed: 'Bed 9', ageSex: '50 F', situation: 'Test', background: 'Fictional', assessment: 'Observed ok', recommendation: 'Doctor to decide', stability: 'stable', tasks: 'none' })) await set(k, v);
  await out.evaluate(() => document.querySelector('#form').requestSubmit()); await sleep(2500); // incoming event
  const cards = await inn.$$eval('.card', (e) => e.length);
  const v2 = await inn.$eval('.ack textarea', (e) => e.value);
  const focus = await inn.evaluate(() => document.activeElement && document.activeElement.tagName);
  const r = { keptAfterTicks: v1 === 'Bed 3 child after fall, ', cardsAfterIncoming: cards, keptAfterIncoming: v2 === v1, focusKept: focus === 'TEXTAREA' };
  console.log(JSON.stringify(r)); ok = r.keptAfterTicks && r.keptAfterIncoming && r.focusKept && cards >= 5;
} finally { if (b) await b.close(); srv.kill(); }
process.exit(ok ? 0 : 1);
