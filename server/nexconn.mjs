// Server-side Nexconn Platform API helpers. App Secret never leaves the server.
// Signature per docs.nexconn.ai/platform-chat-api/prepare-to-use-api/auth:
//   Signature = SHA1(AppSecret + Nonce + Timestamp), headers App-Key, Nonce, Timestamp, Signature.
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function signHeaders({ appKey, appSecret, nonce, timestamp, requestId }) {
  if (!appKey || !appSecret) throw new Error('appKey and appSecret are required');
  const n = nonce ?? String(parseInt(randomBytes(6).toString('hex'), 16)).slice(0, 18); // max 18 chars
  const t = String(timestamp ?? Date.now());
  const signature = createHash('sha1').update(appSecret + n + t).digest('hex');
  return {
    'App-Key': appKey,
    Nonce: n,
    Timestamp: t,
    Signature: signature,
    'X-Request-ID': requestId ?? randomUUID().replaceAll('-', ''),
    'Content-Type': 'application/json',
  };
}

const USER_ID_RE = /^[A-Za-z0-9]{1,64}$/;
export const isValidUserId = (id) => typeof id === 'string' && USER_ID_RE.test(id);

/** Exchange a userId for an access token via POST {baseUrl}/v4/auth/access-token/issue. */
export async function issueToken({ baseUrl, appKey, appSecret, userId, name, fetchImpl = fetch }) {
  if (!isValidUserId(userId)) throw Object.assign(new Error('invalid userId'), { status: 400 });
  const cleanName = String(name ?? '').trim().slice(0, 64);
  if (!cleanName) throw Object.assign(new Error('name required'), { status: 400 });
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v4/auth/access-token/issue`, {
    method: 'POST',
    headers: signHeaders({ appKey, appSecret }),
    body: JSON.stringify({ userId, name: cleanName }),
  });
  if (!res.ok) throw Object.assign(new Error(`Nexconn API HTTP ${res.status}`), { status: 502 });
  const body = await res.json();
  if (body.code !== 0 || !body.result?.accessToken) {
    throw Object.assign(new Error(`Nexconn API code ${body.code}`), { status: 502 });
  }
  return { userId: body.result.userId, accessToken: body.result.accessToken };
}

/** Signed POST to any Platform API path; returns the parsed body or throws a 502. */
export async function callApi({ baseUrl, appKey, appSecret, path, body, fetchImpl = fetch }) {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST', headers: signHeaders({ appKey, appSecret }), body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok && !json) throw Object.assign(new Error(`Nexconn API HTTP ${res.status}`), { status: 502 });
  return { httpStatus: res.status, ...json };
}

export const isValidWardId = (id) => typeof id === 'string' && /^[A-Za-z0-9]{1,48}$/.test(id);

/**
 * Server-enforced membership: the ward group is created with nobody-can-join-by-themselves
 * (joinPerm 3) and users are added only here, after their invite code was checked.
 * Idempotent: "already exists" style failures on create are tolerated, join is always attempted.
 */
export async function ensureWardMember({ baseUrl, appKey, appSecret, wardId, userId, fetchImpl = fetch }) {
  if (!isValidWardId(wardId)) throw Object.assign(new Error('bad ward'), { status: 400 });
  const ownerId = 'wardowner' + wardId.slice(0, 40);
  await issueToken({ baseUrl, appKey, appSecret, userId: ownerId, name: 'Ward owner', fetchImpl }); // registers the owner
  const groupId = 'ss' + wardId;
  const c = await callApi({ baseUrl, appKey, appSecret, path: '/v4/group-channel/create', fetchImpl,
    body: { channelId: groupId, name: `Ward ${wardId} (synthetic)`, owner: ownerId, permissions: { joinPerm: 3, memInvitePerm: 0, removePerm: 0 } } });
  if (c.code !== 0 && c.code !== 25409) throw Object.assign(new Error(`create failed code ${c.code}`), { status: 502 });
  const j = await callApi({ baseUrl, appKey, appSecret, path: '/v4/group-channel/join', fetchImpl, body: { channelId: groupId, userIds: [userId] } });
  if (j.code !== 0) throw Object.assign(new Error(`join failed code ${j.code}`), { status: 502 });
  return groupId;
}

/**
 * Revoke a person's live access, not just future sign-ins. Three layered steps (each reported):
 *  1. expire all access tokens issued so far (existing connections stay up, but reconnect fails),
 *  2. remove the user from the ward group (history and send are then refused),
 *  3. ban the user for up to 30 days (Nexconn's maximum; the live connection is terminated at once).
 * Nexconn tokens are valid indefinitely by default, so step 1 and 2 are what keep a revoked person out after the
 * ban expires. Also list the key id in SS_REVOKED so no new session can be minted.
 */
export async function revokeUser({ baseUrl, appKey, appSecret, userId, wardId, banMinutes = 43200, now = Date.now(), fetchImpl = fetch }) {
  if (!isValidUserId(userId) || !isValidWardId(wardId)) throw Object.assign(new Error('bad userId or ward'), { status: 400 });
  const common = { baseUrl, appKey, appSecret, fetchImpl };
  const expire = await callApi({ ...common, path: '/v4/auth/access-token/expire', body: { userIds: [userId], expiresAt: now } });
  const leave = await callApi({ ...common, path: '/v4/group-channel/leave', body: { channelId: 'ss' + wardId, userIds: [userId] } });
  const ban = await callApi({ ...common, path: '/v4/user/ban', body: { userIds: [userId], durationMinutes: Math.min(Math.max(1, banMinutes), 43200) } });
  return { expireTokens: expire.code, leaveGroup: leave.code, ban: ban.code, ok: expire.code === 0 && ban.code === 0 && leave.code === 0 };
}
