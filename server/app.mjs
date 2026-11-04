// Tiny dependency-free server: session endpoint (token minting) + local mock relay + static files.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { issueToken, isValidUserId, ensureWardMember, isValidWardId } from './nexconn.mjs';

const env = process.env;
const BASE_URL = env.NEXCONN_BASE_URL || 'https://api.sg-light-api.com';
const logs = new Map(); const logOf = (w) => { if (!logs.has(w)) logs.set(w, []); return logs.get(w); }; const clientsByWard = new Map(); const sessions = new Map(); // sessionToken -> { userId, ward }

// Invite codes bind a person to a role. Real deployments set SS_INVITES="code:out,code:in"; the
// demo codes are only valid when running without live Nexconn credentials.
export function parseInvites(str) {
  const m = new Map(); // code -> { role, ward }
  for (const part of String(str || '').split(',')) {
    const [code, role, ward] = part.split(':').map((x) => x && x.trim());
    if (code && (role === 'out' || role === 'in') && isValidWardId(ward || 'ward1')) m.set(code, { role, ward: ward || 'ward1' });
  }
  return m;
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
export function roleForCode(invites, code) {
  for (const [c, r] of invites) if (safeEq(c, code ?? '')) return r;
  return null; // { role, ward } or null
}

export function createApp({ appKey = env.NEXCONN_APP_KEY, appSecret = env.NEXCONN_APP_SECRET, fetchImpl = fetch, staticDir = 'dist', invites } = {}) {
  const live = Boolean(appKey && appSecret);
  const inv = invites ?? parseInvites([env.SS_INVITES, env.SS_INVITES_EXTRA].filter(Boolean).join(',') || (live ? '' : 'demo-out:out,demo-in:in'));
  const auth = (req) => sessions.get(req.headers['x-session'] || new URL(req.url, 'http://x').searchParams.get('s') || '');
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = async (req) => { let b = ''; for await (const c of req) { b += c; if (b.length > 20000) throw new Error('too large'); } return b ? JSON.parse(b) : {}; };
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { mode: live ? 'nexconn' : 'mock', appKey: live ? appKey : null });
      if (req.method === 'POST' && url.pathname === '/api/session') {
        const { name, code } = await body(req);
        const grant = roleForCode(inv, code);
        if (!grant) return send(res, 403, { error: 'invalid invite code' });
        const clean = String(name ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 30);
        if (!clean) return send(res, 400, { error: 'name must contain letters or digits' });
        const { role, ward } = grant;
        const userId = role + clean; // role is server-assigned and bound to the id
        const sessionToken = randomBytes(18).toString('hex');
        sessions.set(sessionToken, { userId, ward });
        if (!live) return send(res, 200, { mode: 'mock', userId, role, ward, name: String(name).slice(0, 30), sessionToken, serverNow: Date.now() });
        const t = await issueToken({ baseUrl: BASE_URL, appKey, appSecret, userId, name: String(name).trim().slice(0, 30), fetchImpl });
        const groupId = await ensureWardMember({ baseUrl: BASE_URL, appKey, appSecret, wardId: ward, userId: t.userId, fetchImpl });
        return send(res, 200, { mode: 'nexconn', appKey, groupId, userId: t.userId, role, name: String(name).slice(0, 30), token: t.accessToken, sessionToken, serverNow: Date.now() });
      }
      if (url.pathname.startsWith("/api/mock/") && (live || !auth(req))) return send(res, 401, { error: 'sign in first' });
      const sess = auth(req);
      if (url.pathname === '/api/mock/history') return send(res, 200, logOf(sess.ward));
      if (url.pathname === '/api/mock/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': ok\n\n'); const set = clientsByWard.get(sess.ward) ?? new Set(); clientsByWard.set(sess.ward, set); set.add(res); req.on('close', () => set.delete(res)); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mock/send') {
        const { payload } = await body(req); const userId = sess.userId;
        if (!isValidUserId(userId) || !payload || typeof payload.type !== 'string') return send(res, 400, { error: 'bad message' });
        const lg = logOf(sess.ward); const m = { id: String(lg.length + 1), userId, ts: Date.now(), payload };
        lg.push(m); for (const c of clientsByWard.get(sess.ward) ?? []) c.write(`data: ${JSON.stringify(m)}\n\n`);
        return send(res, 200, { ok: true });
      }
      // static
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      let p = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      if (p === '/' || p === '') p = '/index.html';
      try { const data = await readFile(join(staticDir, p)); res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); return res.end(data); }
      catch { res.writeHead(404); return res.end('not found'); }
    } catch (e) { send(res, e.status || 500, { error: e.status ? e.message : 'server error' }); }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(env.PORT || 8787);
  createApp().listen(port, () => console.log(`ShiftSafe on :${port} (${env.NEXCONN_APP_SECRET ? 'live Nexconn' : 'mock relay'})`));
}
