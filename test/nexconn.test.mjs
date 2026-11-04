import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { signHeaders, issueToken, isValidUserId } from '../server/nexconn.mjs';

test('signature is SHA1(secret + nonce + timestamp) per the docs', () => {
  const h = signHeaders({ appKey: 'k', appSecret: 'sec', nonce: '14314', timestamp: 1408710653000 });
  assert.equal(h.Signature, createHash('sha1').update('sec' + '14314' + '1408710653000').digest('hex'));
  assert.equal(h['App-Key'], 'k');
  assert.equal(h.Timestamp, '1408710653000');
});

test('nonce is at most 18 chars and X-Request-ID at most 36', () => {
  for (let i = 0; i < 200; i++) {
    const h = signHeaders({ appKey: 'k', appSecret: 's' });
    assert.ok(h.Nonce.length >= 1 && h.Nonce.length <= 18, h.Nonce);
    assert.ok(h['X-Request-ID'].length <= 36);
  }
});

test('user ids: letters and digits only, max 64', () => {
  assert.ok(isValidUserId('nurseAnita7'));
  assert.ok(!isValidUserId('has space'));
  assert.ok(!isValidUserId('a'.repeat(65)));
  assert.ok(!isValidUserId(''));
  assert.ok(!isValidUserId(undefined));
});

test('issueToken posts to the issue endpoint and never leaks the secret in the body', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ code: 0, result: { userId: 'u1', accessToken: 'TOK' } }) };
  };
  const r = await issueToken({ baseUrl: 'https://api.example/', appKey: 'k', appSecret: 'TOPSECRET', userId: 'u1', name: 'Anita', fetchImpl });
  assert.deepEqual(r, { userId: 'u1', accessToken: 'TOK' });
  assert.equal(seen.url, 'https://api.example/v4/auth/access-token/issue');
  assert.ok(!seen.init.body.includes('TOPSECRET'));
  assert.ok(!JSON.stringify(seen.init.headers).includes('TOPSECRET'));
  assert.equal(JSON.parse(seen.init.body).name, 'Anita');
});

test('issueToken maps API failures to 502 and bad input to 400', async () => {
  const bad = async () => ({ ok: true, json: async () => ({ code: 1004 }) });
  await assert.rejects(issueToken({ baseUrl: 'https://x', appKey: 'k', appSecret: 's', userId: 'u1', name: 'A', fetchImpl: bad }), (e) => e.status === 502);
  const http500 = async () => ({ ok: false, status: 500 });
  await assert.rejects(issueToken({ baseUrl: 'https://x', appKey: 'k', appSecret: 's', userId: 'u1', name: 'A', fetchImpl: http500 }), (e) => e.status === 502);
  await assert.rejects(issueToken({ baseUrl: 'https://x', appKey: 'k', appSecret: 's', userId: 'bad id', name: 'A' }), (e) => e.status === 400);
  await assert.rejects(issueToken({ baseUrl: 'https://x', appKey: 'k', appSecret: 's', userId: 'u1', name: '  ' }), (e) => e.status === 400);
});
