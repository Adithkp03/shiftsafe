// Vercel function: checks the invite code, mints a Nexconn token, and adds the user to the ward group server-side.
import { parseInvites, roleForCode } from '../server/app.mjs';
import { issueToken, ensureWardMember } from '../server/nexconn.mjs';

const BASE_URL = process.env.NEXCONN_BASE_URL || 'https://api.sg-light-api.com';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const appKey = process.env.NEXCONN_APP_KEY, appSecret = process.env.NEXCONN_APP_SECRET;
  if (!appKey || !appSecret) return res.status(503).json({ error: 'not configured' });
  try {
    const { name, code } = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const grant = roleForCode(parseInvites([process.env.SS_INVITES, process.env.SS_INVITES_EXTRA].filter(Boolean).join(',')), code);
    if (!grant) return res.status(403).json({ error: 'invalid invite code' });
    const clean = String(name ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 30);
    if (!clean) return res.status(400).json({ error: 'name must contain letters or digits' });
    const userId = grant.role + clean;
    const t = await issueToken({ baseUrl: BASE_URL, appKey, appSecret, userId, name: String(name).trim().slice(0, 30) });
    const groupId = await ensureWardMember({ baseUrl: BASE_URL, appKey, appSecret, wardId: grant.ward, userId: t.userId });
    res.status(200).json({ mode: 'nexconn', appKey, groupId, userId: t.userId, role: grant.role, name: String(name).slice(0, 30), token: t.accessToken, sessionToken: 'live' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status === 400 ? e.message : 'session failed' });
  }
}
