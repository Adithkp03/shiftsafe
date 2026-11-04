import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, parseInvites, roleForCode } from '../server/app.mjs';

const start = (opts) => new Promise((r) => { const s = createApp(opts).listen(0, () => r(s)); });
const base = (s) => `http://localhost:${s.address().port}`;
const post = (s, path, body, headers = {}) => fetch(base(s) + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('invites parse and compare safely', () => {
  const inv = parseInvites('a1:out, b2:in ,bad:admin,:out');
  assert.deepEqual(roleForCode(inv, 'a1'), { role: 'out', ward: 'ward1' }); assert.deepEqual(roleForCode(parseInvites('x:in:wardB'), 'x'), { role: 'in', ward: 'wardB' });
  assert.equal(roleForCode(inv, 'b2').role, 'in');
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

test('wards are isolated: a session only reads and writes its own ward (mock relay)', async () => {
  const s = await start({ appKey: '', appSecret: '', invites: parseInvites('oA:out:wardA,iB:in:wardB') });
  try {
    const a = await (await post(s, '/api/session', { name: 'Anita', code: 'oA' })).json();
    const b = await (await post(s, '/api/session', { name: 'Ravi', code: 'iB' })).json();
    await post(s, '/api/mock/send', { payload: { type: 'SS:card', cardId: 'x' } }, { 'x-session': a.sessionToken });
    const seenByA = await (await fetch(base(s) + '/api/mock/history', { headers: { 'x-session': a.sessionToken } })).json();
    const seenByB = await (await fetch(base(s) + '/api/mock/history', { headers: { 'x-session': b.sessionToken } })).json();
    assert.equal(seenByA.length, 1); assert.equal(seenByB.length, 0);
  } finally { s.close(); }
});

test('live: membership is added by the server only after a valid invite; group is not self-joinable', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { const path = new URL(url).pathname; const body = JSON.parse(init.body); calls.push({ path, body }); return { ok: true, json: async () => ({ code: 0, result: { userId: body.userId, accessToken: 'T' } }) }; };
  const s = await start({ appKey: 'K', appSecret: 'S', fetchImpl, invites: parseInvites('oA:out:wardA,iB:in:wardB') });
  try {
    assert.equal((await post(s, '/api/session', { name: 'Eve', code: 'guess' })).status, 403);
    assert.equal(calls.length, 0, 'no Nexconn call for a bad invite');
    const r = await (await post(s, '/api/session', { name: 'Ravi', code: 'iB' })).json();
    assert.equal(r.groupId, 'sswardB');
    const create = calls.find((c) => c.path === '/v4/group-channel/create');
    assert.equal(create.body.channelId, 'sswardB'); assert.equal(create.body.permissions.joinPerm, 3);
    const join = calls.find((c) => c.path === '/v4/group-channel/join');
    assert.deepEqual(join.body, { channelId: 'sswardB', userIds: ['inRavi'] });
    assert.ok(!calls.some((c) => JSON.stringify(c.body).includes('wardA')), 'other ward untouched');
  } finally { s.close(); }
});

test('live: if the server cannot add the user to the group the session fails closed', async () => {
  const fetchImpl = async (url, init) => { const path = new URL(url).pathname; const body = JSON.parse(init.body); return { ok: true, json: async () => (path.endsWith('/join') ? { code: 1001 } : { code: 0, result: { userId: body.userId, accessToken: 'T' } }) }; };
  const s = await start({ appKey: 'K', appSecret: 'S', fetchImpl, invites: parseInvites('iB:in:wardB') });
  try {
    const r = await post(s, '/api/session', { name: 'Ravi', code: 'iB' });
    assert.equal(r.status, 502); assert.ok(!(await r.text()).includes('"token"'));
  } finally { s.close(); }
});
