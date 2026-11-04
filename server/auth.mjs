// Individual credentials without a database: HMAC-signed, expiring, per-person access keys.
//   ssk1.<base64url JSON payload>.<base64url HMAC-SHA256(payloadPart)>
// payload = { v:1, pid, name, role:'out'|'in', ward, iat, exp, jti }
// The server derives the Nexconn userId from the signed pid and role, so a person cannot choose or
// impersonate another identity by typing a name. Revoke one key by adding its jti to SS_REVOKED
// (comma list) or all keys by rotating SS_SIGNING_KEY. SS_SIGNING_KEY may hold several comma-separated
// keys (first signs, any verifies) to allow rotation.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isValidWardId } from './nexconn.mjs';

export const PREFIX = 'ssk1.';
const MAX_DAYS = 90;
const b64 = (b) => Buffer.from(b).toString('base64url');
const mac = (key, part) => createHmac('sha256', key).update(part).digest();
const keysOf = (s) => String(s || '').split(',').map((k) => k.trim()).filter((k) => k.length >= 32);

export function signCredential({ key, name, role, ward, days = 14, now = Date.now() }) {
  const k = keysOf(key)[0];
  if (!k) throw new Error('signing key must be at least 32 characters');
  if (role !== 'out' && role !== 'in') throw new Error('role must be out or in');
  if (!isValidWardId(ward)) throw new Error('invalid ward id');
  const clean = String(name ?? '').trim().slice(0, 30);
  if (!/[A-Za-z0-9]/.test(clean)) throw new Error('name must contain letters or digits');
  if (!(days > 0 && days <= MAX_DAYS)) throw new Error(`days must be between 1 and ${MAX_DAYS}`);
  const payload = { v: 1, pid: randomBytes(6).toString('hex'), name: clean, role, ward, iat: now, exp: now + days * 86400000, jti: randomBytes(6).toString('hex') };
  const part = b64(JSON.stringify(payload));
  return { credential: PREFIX + part + '.' + b64(mac(k, part)), payload };
}

/** Returns { ok:true, grant } or { ok:false, reason } (reason is for tests/logs, never shown to the client). */
export function verifyCredential({ keys, credential, now = Date.now(), revoked = '' }) {
  const ks = keysOf(keys);
  if (!ks.length) return { ok: false, reason: 'no-key' };
  if (typeof credential !== 'string' || !credential.startsWith(PREFIX) || credential.length > 2000) return { ok: false, reason: 'format' };
  const [part, sig, extra] = credential.slice(PREFIX.length).split('.');
  if (!part || !sig || extra !== undefined) return { ok: false, reason: 'format' };
  let sigBuf; try { sigBuf = Buffer.from(sig, 'base64url'); } catch { return { ok: false, reason: 'format' }; }
  const good = ks.some((k) => { const m = mac(k, part); return m.length === sigBuf.length && timingSafeEqual(m, sigBuf); });
  if (!good) return { ok: false, reason: 'signature' };
  let p; try { p = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'payload' }; }
  if (!p || p.v !== 1 || (p.role !== 'out' && p.role !== 'in') || !/^[0-9a-f]{12}$/.test(String(p.pid)) || !isValidWardId(p.ward) || typeof p.name !== 'string' || !/[A-Za-z0-9]/.test(p.name)) return { ok: false, reason: 'payload' };
  if (!Number.isFinite(p.exp) || !Number.isFinite(p.iat) || p.exp <= now) return { ok: false, reason: 'expired' };
  if (p.iat > now + 5 * 60000 || p.exp - p.iat > MAX_DAYS * 86400000) return { ok: false, reason: 'window' };
  if (String(revoked).split(',').map((x) => x.trim()).includes(p.jti)) return { ok: false, reason: 'revoked' };
  return { ok: true, grant: { role: p.role, ward: p.ward, name: p.name.slice(0, 30), userId: p.role + 'p' + p.pid, jti: p.jti, exp: p.exp } };
}

// One entry point for both the Vercel function and the local server.
// legacy: Map(code -> {role, ward}) of shared invite codes, or null when disabled.
export function authenticate({ body, env, legacy, roleForCode, now = Date.now() }) {
  const code = body && (body.code ?? body.key);
  if (typeof code === 'string' && code.startsWith(PREFIX)) {
    const v = verifyCredential({ keys: env.SS_SIGNING_KEY, credential: code.trim(), now, revoked: env.SS_REVOKED });
    return v.ok ? { ok: true, ...v.grant, kind: 'personal' } : { ok: false, status: 403, error: 'invalid or expired access key', reason: v.reason };
  }
  if (!legacy) return { ok: false, status: 403, error: 'invalid or expired access key', reason: 'legacy-off' };
  const grant = roleForCode(legacy, code);
  if (!grant) return { ok: false, status: 403, error: 'invalid invite code', reason: 'invite' };
  const clean = String(body.name ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 30);
  if (!clean) return { ok: false, status: 400, error: 'name must contain letters or digits' };
  return { ok: true, role: grant.role, ward: grant.ward, name: String(body.name).trim().slice(0, 30), userId: grant.role + clean, kind: 'shared-invite' };
}
export const legacyEnabled = (env) => String(env.SS_LEGACY_INVITES ?? '1') !== '0';
