import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';

const start = (opts) => new Promise((r) => { const s = createApp(opts).listen(0, () => r(s)); });
const base = (s) => `http://localhost:${s.address().port}`;

test('mock mode when no secret: config and session work without credentials', async () => {
  const s = await start({ appKey: '', appSecret: '' });
  try {
    assert.deepEqual(await (await fetch(base(s) + '/api/config')).json(), { mode: 'mock', appKey: null });
    const r = await (await fetch(base(s) + '/api/session', { method: 'POST', body: JSON.stringify({ userId: 'anita1', name: 'Anita' }) })).json();
    assert.equal(r.mode, 'mock'); assert.equal(r.token, undefined);
  } finally { s.close(); }
});

test('live mode mints a token and never returns the secret', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ code: 0, result: { userId: 'anita1', accessToken: 'TOK' } }) });
  const s = await start({ appKey: 'KEY', appSecret: 'SUPERSECRET', fetchImpl });
  try {
    const txt = await (await fetch(base(s) + '/api/session', { method: 'POST', body: JSON.stringify({ userId: 'anita1', name: 'Anita' }) })).text();
    assert.ok(txt.includes('TOK')); assert.ok(!txt.includes('SUPERSECRET'));
    const cfg = await (await fetch(base(s) + '/api/config')).text();
    assert.ok(!cfg.includes('SUPERSECRET'));
  } finally { s.close(); }
});

test('session rejects bad user ids; mock relay stores and returns messages', async () => {
  const s = await start({ appKey: '', appSecret: '' });
  try {
    const bad = await fetch(base(s) + '/api/session', { method: 'POST', body: JSON.stringify({ userId: 'a b', name: 'x' }) });
    assert.equal(bad.status, 400);
    await fetch(base(s) + '/api/mock/reset', { method: 'POST' });
    const ok = await fetch(base(s) + '/api/mock/send', { method: 'POST', body: JSON.stringify({ userId: 'u1', payload: { type: 'SS:ack', cardId: 'c' } }) });
    assert.equal(ok.status, 200);
    const h = await (await fetch(base(s) + '/api/mock/history')).json();
    assert.equal(h.length, 1); assert.equal(h[0].payload.type, 'SS:ack');
    const rej = await fetch(base(s) + '/api/mock/send', { method: 'POST', body: JSON.stringify({ userId: 'u1', payload: {} }) });
    assert.equal(rej.status, 400);
  } finally { s.close(); }
});
