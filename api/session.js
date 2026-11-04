// Vercel function: checks the invite code, mints a Nexconn token, and adds the user to the ward group server-side.
import { parseInvites, roleForCode } from '../server/app.mjs';
import { authenticate, legacyEnabled } from '../server/auth.mjs';
import { issueToken, ensureWardMember } from '../server/nexconn.mjs';

const BASE_URL = process.env.NEXCONN_BASE_URL || 'https://api.sg-light-api.com';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const appKey = process.env.NEXCONN_APP_KEY, appSecret = process.env.NEXCONN_APP_SECRET;
  if (!appKey || !appSecret) return res.status(503).json({ error: 'not configured' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const legacy = legacyEnabled(process.env) ? parseInvites([process.env.SS_INVITES, process.env.SS_INVITES_EXTRA].filter(Boolean).join(',')) : null;
    const r = authenticate({ body, env: process.env, legacy, roleForCode });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const { role, ward, userId, name } = r;
    const t = await issueToken({ baseUrl: BASE_URL, appKey, appSecret, userId, name });
    const groupId = await ensureWardMember({ baseUrl: BASE_URL, appKey, appSecret, wardId: ward, userId: t.userId });
    res.status(200).json({ mode: 'nexconn', appKey, groupId, userId: t.userId, role, name, token: t.accessToken, sessionToken: 'live', serverNow: Date.now() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status === 400 ? e.message : 'session failed' });
  }
}
