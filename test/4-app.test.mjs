import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, parseInvites, roleForCode } from '../server/app.mjs';

const start = (opts) => new Promise((r) => { const s = createApp(opts).listen(0, () => r(s)); });
const base = (s) => `http://localhost:${s.address().port}`;
const post = (s, path, body, headers = {}) => fetch(base(s) + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('invites parse and compare safely', () => {
  const inv = parseInvites('a1:out, b2:in ,bad:admin,:out');
  assert.equal(roleForCode(inv, 'a1'), 'out'); assert.equal(roleForCode(inv, 'b2'), 'in');
  assert.equal(roleForCode(inv, 'bad'), null); assert.equal(roleForCode(inv, undefined), null); assert.equal(roleForCode(inv, 'a'), null);
});

test('config reports mode; mock mode needs a valid invite for a session', async () => {
  const s = await start({ appKey: '', appSecret: '' });
  try {
    assert.deepEqual(await (await fetch(base(s) + '/api/config')).json(), { mode: 'mock', appKey: null });
    assert.equal((await post(s, '/api/session', { name: 'Anita', code: 'nope' })).status, 403);
    assert.equal((await post(s, '/api/session', { name: '!!!', code: 'demo-out' })).status, 400);
    const r = await (await post(s, '/api/session', { name: 'Anita K', code: 'demo-out' })).json();
    assert.equal(r.role, 'out'); assert.equal(r.userId, 'outAnitaK'); assert.ok(r.sessionToken); assert.equal(r.token, undefined);
  } finally { s.close(); }
});

test('server assigns the role: a client cannot pick it by naming itself', async () => {
  const s = await start({ appKey: '', appSecret: '' });
  try {
    const r = await (await post(s, '/api/session', { name: 'outBoss', code: 'demo-in' })).json();
    assert.equal(r.role, 'in'); assert.ok(r.userId.startsWith('in'));
  } finally { s.close(); }
});

test('mock relay requires a session; sender id comes from the session, not the body', async () => {
  const s = await start({ appKey: '', appSecret: '' });
  try {
    assert.equal((await fetch(base(s) + '/api/mock/history')).status, 401);
    assert.equal((await post(s, '/api/mock/send', { payload: { type: 'SS:ack' } })).status, 401);
    const { sessionToken } = await (await post(s, '/api/session', { name: 'Ravi', code: 'demo-in' })).json();
    const h = { 'x-session': sessionToken };
    assert.equal((await post(s, '/api/mock/send', { userId: 'outFake', payload: { type: 'SS:ack', cardId: 'c' } }, h)).status, 200);
    const hist = await (await fetch(base(s) + '/api/mock/history', { headers: h })).json();
    assert.equal(hist.length, 1); assert.equal(hist[0].userId, 'inRavi');
    assert.equal((await post(s, '/api/mock/send', { payload: {} }, h)).status, 400);
  } finally { s.close(); }
});

test('live mode mints a token, never returns the secret, and disables the mock relay', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ code: 0, result: { userId: 'inAnita', accessToken: 'TOK' } }) });
  const s = await start({ appKey: 'KEY', appSecret: 'SUPERSECRET', fetchImpl, invites: parseInvites('c9:in') });
  try {
    assert.equal((await post(s, '/api/session', { name: 'Anita', code: 'demo-in' })).status, 403, 'demo codes are off in live mode');
    const txt = await (await post(s, '/api/session', { name: 'Anita', code: 'c9' })).text();
    assert.ok(txt.includes('TOK')); assert.ok(!txt.includes('SUPERSECRET'));
    assert.ok(!(await (await fetch(base(s) + '/api/config')).text()).includes('SUPERSECRET'));
    const { sessionToken } = JSON.parse(txt);
    assert.equal((await fetch(base(s) + '/api/mock/history', { headers: { 'x-session': sessionToken } })).status, 401);
  } finally { s.close(); }
});
