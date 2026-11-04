import test from 'node:test';
import assert from 'node:assert/strict';
import { signCredential, verifyCredential, authenticate, legacyEnabled, PREFIX } from '../server/auth.mjs';
import { parseInvites, roleForCode, createApp } from '../server/app.mjs';

const KEY = 'k'.repeat(40), OTHER = 'z'.repeat(40), NOW = 1_800_000_000_000;
const mk = (o = {}) => signCredential({ key: KEY, name: 'Priya', role: 'out', ward: 'wardx', now: NOW, ...o });
const v = (credential, o = {}) => verifyCredential({ keys: KEY, credential, now: NOW + 1000, ...o });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

test('valid key verifies and the userId comes from the signed id and role', () => {
  const { credential, payload } = mk();
  const r = v(credential);
  assert.equal(r.ok, true); assert.equal(r.grant.role, 'out'); assert.equal(r.grant.ward, 'wardx');
  assert.equal(r.grant.userId, 'outp' + payload.pid); assert.match(r.grant.userId, /^out/);
});
test('two keys with the same name are different identities', () => {
  assert.notEqual(v(mk().credential).grant.userId, v(mk().credential).grant.userId);
});
test('tampering is rejected: role, ward, name, expiry, signature, wrong key, garbage', () => {
  const { credential } = mk({ role: 'in' });
  const [, part, sig] = credential.split('.');
  const p = JSON.parse(Buffer.from(part, 'base64url'));
  for (const edit of [{ role: 'out' }, { ward: 'wardother' }, { name: 'Boss' }, { exp: p.exp + 1e9 }]) {
    assert.equal(v(PREFIX + b64({ ...p, ...edit }) + '.' + sig).reason, 'signature', JSON.stringify(edit));
  }
  assert.equal(v(PREFIX + part + '.' + sig.slice(0, -2) + 'AA').ok, false);
  assert.equal(verifyCredential({ keys: OTHER, credential, now: NOW }).reason, 'signature');
  for (const g of ['', 'ssk1.', 'ssk1.a', 'ssk1.a.b.c', 'demo-out', null, undefined, 5, 'ssk1.' + 'x'.repeat(3000)]) assert.equal(v(g).ok, false);
});
test('expiry, future issue time, over-long lifetime and revocation', () => {
  const { credential, payload } = mk({ days: 1 });
  assert.equal(verifyCredential({ keys: KEY, credential, now: payload.exp }).reason, 'expired');
  assert.equal(verifyCredential({ keys: KEY, credential, now: payload.exp - 1 }).ok, true);
  assert.equal(verifyCredential({ keys: KEY, credential, now: NOW - 10 * 60000 }).reason, 'window');
  assert.equal(v(credential, { revoked: 'abc, ' + payload.jti }).reason, 'revoked');
  assert.throws(() => mk({ days: 91 })); assert.throws(() => mk({ days: 0 }));
  assert.throws(() => signCredential({ key: 'short', name: 'A', role: 'in', ward: 'wardx' }));
  assert.throws(() => mk({ role: 'admin' })); assert.throws(() => mk({ name: '  ' })); assert.throws(() => mk({ ward: 'bad ward!' }));
});
test('key rotation: any listed key verifies, only the first signs', () => {
  const old = signCredential({ key: OTHER, name: 'A', role: 'in', ward: 'wardx', now: NOW }).credential;
  assert.equal(verifyCredential({ keys: KEY + ',' + OTHER, credential: old, now: NOW + 1 }).ok, true);
  assert.equal(verifyCredential({ keys: KEY, credential: old, now: NOW + 1 }).ok, false);
});
test('authenticate: typed name is ignored for personal keys; shared invites still need a name; legacy can be switched off', () => {
  const env = { SS_SIGNING_KEY: KEY }, legacy = parseInvites('code1:in:wardx');
  const { credential, payload } = mk({ role: 'in', name: 'Anita' });
  const a = authenticate({ body: { name: 'SomeoneElse', code: credential }, env, legacy, roleForCode, now: NOW + 1 });
  assert.equal(a.ok, true); assert.equal(a.name, 'Anita'); assert.equal(a.userId, 'inp' + payload.pid); assert.equal(a.kind, 'personal');
  assert.equal(authenticate({ body: { code: 'code1' }, env, legacy, roleForCode }).status, 400);
  const s = authenticate({ body: { name: 'Ravi', code: 'code1' }, env, legacy, roleForCode });
  assert.equal(s.ok, true); assert.equal(s.kind, 'shared-invite'); assert.equal(s.userId, 'inRavi');
  assert.equal(authenticate({ body: { name: 'Ravi', code: 'code1' }, env, legacy: null, roleForCode }).ok, false);
  assert.equal(authenticate({ body: { code: credential }, env: {}, legacy, roleForCode, now: NOW + 1 }).ok, false); // no key configured
  assert.equal(legacyEnabled({}), true); assert.equal(legacyEnabled({ SS_LEGACY_INVITES: '0' }), false);
});
test('HTTP session endpoint (mock mode): personal key, wrong key, and legacy switched off', async () => {
  const saved = { ...process.env };
  process.env.SS_SIGNING_KEY = KEY; process.env.SS_LEGACY_INVITES = '0'; delete process.env.NEXCONN_APP_KEY; delete process.env.NEXCONN_APP_SECRET;
  const srv = createApp({ invites: parseInvites('demo-in:in') }); await new Promise((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/api/session`;
  const post = (body) => fetch(url, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  try {
    const good = signCredential({ key: KEY, name: 'Mira', role: 'in', ward: 'wardx' }).credential, bad = signCredential({ key: OTHER, name: 'Mira', role: 'in', ward: 'wardx' }).credential;
    const [s1, j1] = await post({ name: 'x', code: good });
    assert.equal(s1, 200); assert.equal(j1.name, 'Mira'); assert.equal(j1.role, 'in'); assert.equal(j1.ward, 'wardx'); assert.match(j1.userId, /^inp[0-9a-f]{12}$/);
    assert.equal((await post({ code: bad }))[0], 403);
    assert.equal((await post({ name: 'Ravi', code: 'demo-in' }))[0], 403);
  } finally { srv.close(); for (const k of ['SS_SIGNING_KEY', 'SS_LEGACY_INVITES', 'NEXCONN_APP_KEY', 'NEXCONN_APP_SECRET']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
});
