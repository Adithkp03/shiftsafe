// LIVE Nexconn, SDK level: ward isolation. A member of ward B must be refused send/history/self-join on ward A's group,
// and a member removed from their own ward must be refused after removal (control: allowed before).
// Needs NEXCONN_APP_KEY and NEXCONN_APP_SECRET (never commit values). Throwaway signing key, fresh wards.
// Starts the app server and a Vite dev server (only so the page can import the SDK). Run: node test/e2e/isolation.live.e2e.mjs
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { signCredential } from '../../server/auth.mjs';
import { callApi } from '../../server/nexconn.mjs';
for (const k of ['NEXCONN_APP_KEY', 'NEXCONN_APP_SECRET']) if (!process.env[k]) { console.error('missing env ' + k); process.exit(2); }
const BASE = process.env.NEXCONN_BASE_URL || 'https://api.sg-light-api.com', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SK = randomBytes(24).toString('hex'), tag = Date.now().toString(36), wA = 'wardiso' + tag + 'a', wB = 'wardiso' + tag + 'b';
const key = (name, ward) => signCredential({ key: SK, name, role: 'in', ward }).credential;
const srv = spawn('node', ['server/app.mjs'], { env: { ...process.env, PORT: '8798', SS_SIGNING_KEY: SK, SS_LEGACY_INVITES: '0' }, stdio: 'ignore' });
const vite = spawn('npx', ['vite', '--port', '5198', '--strictPort'], { stdio: 'ignore' });
let b; const res = {};
const session = async (name, ward) => (await fetch('http://localhost:8798/api/session', { method: 'POST', body: JSON.stringify({ code: key(name, ward) }) })).json();
try {
  await sleep(4000);
  b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
  const probe = async (s, groupId) => { const p = await b.newPage(); await p.goto('http://localhost:5198/');
    const o = await p.evaluate(async (s, groupId) => { const NC = await import('/@id/@nexconn/chat'); const { NCEngine, AreaCode, GroupChannel, SendTextMessageParams, BaseChannel } = NC;
      NCEngine.initialize({ appKey: s.appKey, areaCode: AreaCode.SG }); const c = await NCEngine.connect({ token: s.token }); const g = new GroupChannel(groupId); const o = { connect: c.code };
      const snd = await g.sendMessage(new SendTextMessageParams({ text: 'SS1:{"type":"probe"}' })); o.send = snd.code;
      const q = BaseChannel.createMessagesQuery({ channelIdentifier: g.identifier, startTime: Date.now(), pageSize: 20, isAscending: false }); const h = await q.loadNextPage(); o.history = h.code;
      const j = await g.join(); o.selfJoin = j.code; return o; }, s, groupId);
    await p.close(); return o; };
  const a = await session('Alma', wA), bb = await session('Bruno', wB);
  res.memberControl = await probe(a, 'ss' + wA);
  res.otherWard = await probe(bb, 'ss' + wA);
  const rm = await callApi({ baseUrl: BASE, appKey: process.env.NEXCONN_APP_KEY, appSecret: process.env.NEXCONN_APP_SECRET, path: '/v4/group-channel/leave', body: { channelId: 'ss' + wA, userIds: [a.userId] } });
  await sleep(3000); res.leaveCode = rm.code; res.removedMember = await probe(a, 'ss' + wA);
} finally { if (b) await b.close(); srv.kill(); vite.kill(); }
console.log(JSON.stringify(res, null, 1));
const refused = (o) => o.send !== 0 && o.history !== 0 && o.selfJoin !== 0;
process.exit(res.memberControl?.send === 0 && res.memberControl?.history === 0 && refused(res.otherWard) && res.leaveCode === 0 && refused(res.removedMember) ? 0 : 1);
