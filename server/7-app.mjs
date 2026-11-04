// Tiny dependency-free server: session endpoint (token minting) + local mock relay + static files.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { issueToken, isValidUserId } from './nexconn.mjs';

const env = process.env;
const BASE_URL = env.NEXCONN_BASE_URL || 'https://api.sg-light-api.com';
const log = []; const clients = new Set();

export function createApp({ appKey = env.NEXCONN_APP_KEY, appSecret = env.NEXCONN_APP_SECRET, fetchImpl = fetch, staticDir = 'dist' } = {}) {
  const live = Boolean(appKey && appSecret);
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = async (req) => { let b = ''; for await (const c of req) { b += c; if (b.length > 20000) throw new Error('too large'); } return b ? JSON.parse(b) : {}; };
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { mode: live ? 'nexconn' : 'mock', appKey: live ? appKey : null });
      if (req.method === 'POST' && url.pathname === '/api/session') {
        const { userId, name } = await body(req);
        if (!isValidUserId(userId)) return send(res, 400, { error: 'userId must be letters/digits' });
        if (!live) return send(res, 200, { mode: 'mock', userId, name });
        const t = await issueToken({ baseUrl: BASE_URL, appKey, appSecret, userId, name, fetchImpl });
        return send(res, 200, { mode: 'nexconn', appKey, userId: t.userId, name, token: t.accessToken });
      }
      if (url.pathname === '/api/mock/history') return send(res, 200, log);
      if (url.pathname === '/api/mock/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': ok\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mock/send') {
        const { userId, payload } = await body(req);
        if (!isValidUserId(userId) || !payload || typeof payload.type !== 'string') return send(res, 400, { error: 'bad message' });
        const m = { id: String(log.length + 1), userId, ts: Date.now(), payload };
        log.push(m); for (const c of clients) c.write(`data: ${JSON.stringify(m)}\n\n`);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/mock/reset' && req.method === 'POST') { log.length = 0; return send(res, 200, { ok: true }); }
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
