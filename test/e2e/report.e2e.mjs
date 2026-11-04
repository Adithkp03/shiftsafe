// Browser test: shift-report download content/scope, filter keeps drafts, mobile controls fit.
// Local mock relay, no secrets. Run: npm run build && node test/e2e/report.e2e.mjs
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
const PORT = 8793, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = spawn('node', ['server/app.mjs'], { env: { PATH: process.env.PATH, PORT: String(PORT) }, stdio: 'ignore' });
let b; const r = {};
try {
  await sleep(1500);
  b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
  const login = async (name, code, vp) => { const p = await b.newPage(); if (vp) await p.setViewport(vp); await p.evaluateOnNewDocument(() => { const o = URL.createObjectURL; window.__blobs = []; URL.createObjectURL = (bl) => { bl.text().then((t) => window.__blobs.push(t)); return o.call(URL, bl); }; }); await p.goto(`http://localhost:${PORT}/`); await p.type('input[name=name]', name); await p.type('input[name=code]', code); await p.evaluate(() => document.querySelector('form#lf button').click()); await p.waitForSelector('#summary', { timeout: 8000 }); return p; };
  const out = await login('Anita', 'demo-out'), inn = await login('Ravi', 'demo-in', { width: 390, height: 800, isMobile: true });
  await out.evaluate(() => document.querySelector('#seed').click()); await sleep(2500);
  const total = await inn.$$eval('.card', (e) => e.length);
  // ack one card so the filter removes it only if it also has no open tasks; tick all its tasks first
  await inn.$eval('.ack textarea', (e) => { e.value = 'Bed 3 child after fall, call radiology at 6am'; });
  await inn.evaluate(() => document.querySelector('.ack button').click()); await sleep(2000);
  // complete the acknowledged card's tasks so the filter hides exactly that card
  for (let i = 0; i < 4; i++) { const c = await inn.$('.card.acknowledged input[type=checkbox]:not(:disabled)'); if (!c) break; await c.click(); await sleep(900); }
  // draft survives filter toggle (sort/filter rebuild)
  await (await inn.$('.ack textarea')).click(); await inn.keyboard.type('half typed note', { delay: 10 });
  await inn.evaluate(() => document.querySelector('#attn').click()); await sleep(400);
  await inn.evaluate(() => document.querySelector('#attn').click()); await sleep(400);
  r.draftKeptAcrossFilter = (await inn.$eval('.ack textarea', (e) => e.value)) === 'half typed note';
  // download while filtered: report must still cover all cards
  await inn.evaluate(() => document.querySelector('#attn').click()); await sleep(300);
  r.filteredCards = await inn.$$eval('.card', (e) => e.length);
  await inn.evaluate(() => document.querySelector('#dl').click()); await sleep(800);
  const txt = (await inn.evaluate(() => window.__blobs))[0] || '';
  const beds = (txt.match(/^\[.*\] Bed/gm) || []).length;
  r.report = { scopeAll: new RegExp(`Scope: all ${total} cards`).test(txt), bedsInReport: beds === total, demoLabel: /DEMO/.test(txt), noClinical: /No medical advice or clinical judgement/.test(txt), visualFlagOnly: /visual flag only/.test(txt), readBackCaveat: /cannot judge/.test(txt), timing: /Timing: /.test(txt) };
  r.totalCards = total;
  // mobile: no horizontal overflow, controls visible and tappable size
  r.mobile = await inn.evaluate(() => { const bs = [...document.querySelectorAll('.acts button')]; return { noOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1, buttonsInView: bs.every((x) => { const q = x.getBoundingClientRect(); return q.left >= 0 && q.right <= window.innerWidth + 1; }), tall: bs.every((x) => x.getBoundingClientRect().height >= 40) }; });
} finally { if (b) await b.close(); srv.kill(); }
console.log(JSON.stringify(r, null, 1));
const ok = r.draftKeptAcrossFilter && Object.values(r.report).every(Boolean) && Object.values(r.mobile).every(Boolean) && r.filteredCards === r.totalCards - 1;
process.exit(ok ? 0 : 1);
