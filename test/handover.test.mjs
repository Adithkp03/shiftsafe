import test from 'node:test';
import assert from 'node:assert/strict';
import { completeness, buildCard, deriveState, shiftSummary, CARD_TYPE, ACK_TYPE, TASK_TYPE } from '../core/handover.mjs';

const full = {
  cardId: 'c1', bed: '12A', ageSex: '29 F', situation: 'Post-op day 1 observation',
  background: 'Elective procedure yesterday', assessment: 'Comfortable, vitals charted by nurse',
  recommendation: 'Continue plan as ordered by Dr. Rao', stability: 'watch',
  pendingTasks: ['Chart 2am vitals', 'Call lab for report'],
};
const T0 = 1_000_000;
let seq = 0;
const msg = (payload, userId) => ({ payload, userId: userId ?? (payload.type === 'SS:ack' ? payload.by : payload.type === 'SS:task-done' ? 'in1' : 'out1'), ts: ++seq });
const RB = 'Bed 12A watch, two tasks pending';

test('complete card passes; every missing field is reported', () => {
  assert.equal(completeness(full).complete, true);
  const c = completeness({ ...full, bed: '', stability: 'unknown', assessment: '   ' });
  assert.deepEqual(c.missing.sort(), ['assessment', 'bed', 'stability']);
  assert.equal(c.score, 5);
});

test('pending tasks may be an explicit "none" but not silently absent', () => {
  assert.equal(completeness({ ...full, pendingTasks: [] }).complete, false);
  assert.equal(completeness({ ...full, pendingTasks: [], noPendingTasks: true }).complete, true);
  const { pendingTasks, ...rest } = full;
  assert.equal(completeness(rest).complete, false);
});

test('buildCard refuses incomplete cards with the missing keys', () => {
  assert.throws(() => buildCard({ ...full, situation: '' }, { author: 'n1', shiftId: 's1', now: T0 }),
    (e) => e.code === 'INCOMPLETE' && e.missing.includes('situation'));
});

test('buildCard trims text and numbers tasks', () => {
  const c = buildCard({ ...full, bed: ' 12A ', pendingTasks: [' a ', '', 'b'] }, { author: 'n1', shiftId: 's1', now: T0 });
  assert.equal(c.type, CARD_TYPE);
  assert.equal(c.bed, '12A');
  assert.deepEqual(c.pendingTasks, [{ id: 't1', text: 'a' }, { id: 't2', text: 'b' }]);
});

const card = (over = {}) => buildCard({ ...full, ...over }, { author: 'Anita', shiftId: 's1', now: T0 });

test('a posted card is awaiting until a different nurse acknowledges', () => {
  const m = [msg(card())];
  assert.equal(deriveState(m, { now: T0 + 1000 })[0].status, 'awaiting');
  const withSelf = [...m, msg({ type: ACK_TYPE, cardId: 'c1', by: 'out1', readBack: RB, at: T0 + 5 })];
  assert.equal(deriveState(withSelf, { now: T0 + 1000 })[0].status, 'awaiting', 'self-ack must not count');
  const withIn = [...m, msg({ type: ACK_TYPE, cardId: 'c1', by: 'in1', readBack: RB, at: T0 + 5 })];
  const s = deriveState(withIn, { now: T0 + 1000 })[0];
  assert.equal(s.status, 'acknowledged');
  assert.deepEqual(s.acknowledgedBy, ['in1']);
});

test('unacknowledged watch/critical cards escalate after the window; stable ones do not', () => {
  const m = [msg(card({ cardId: 'a', stability: 'critical', bed: '1' })), msg(card({ cardId: 'b', stability: 'stable', bed: '2' }))];
  const early = deriveState(m, { now: T0 + 60_000 });
  assert.equal(early.some((s) => s.escalated), false);
  const late = deriveState(m, { now: T0 + 11 * 60_000 });
  assert.equal(late.find((s) => s.cardId === 'a').escalated, true);
  assert.equal(late.find((s) => s.cardId === 'b').escalated, false);
});

test('ordering: awaiting first, then critical > watch > stable, then bed', () => {
  const m = [
    msg(card({ cardId: 'a', stability: 'stable', bed: '1' })),
    msg(card({ cardId: 'b', stability: 'critical', bed: '2' })),
    msg(card({ cardId: 'c', stability: 'watch', bed: '3' })),
    msg({ type: ACK_TYPE, cardId: 'b', by: 'in1', readBack: RB, at: T0 + 1 }),
  ];
  assert.deepEqual(deriveState(m, { now: T0 + 1 }).map((s) => s.cardId), ['c', 'a', 'b']);
});

test('corrections: a newer card with the same id replaces the old one and resets acks', () => {
  const m = [
    msg(card({ cardId: 'a' })),
    msg({ type: ACK_TYPE, cardId: 'a', by: 'in1', readBack: RB, at: T0 + 1 }),
    msg(card({ cardId: 'a', assessment: 'Updated assessment' })),
  ];
  const s = deriveState(m, { now: T0 + 2 });
  assert.equal(s.length, 1);
  assert.equal(s[0].status, 'awaiting');
  assert.equal(s[0].card.assessment, 'Updated assessment');
});

test('tasks: done events close tasks, unknown task ids and unknown cards are ignored', () => {
  const m = [
    msg(card({ cardId: 'a' })),
    msg({ type: TASK_TYPE, cardId: 'a', taskId: 't1' }),
    msg({ type: TASK_TYPE, cardId: 'a', taskId: 'nope' }),
    msg({ type: TASK_TYPE, cardId: 'zzz', taskId: 't1' }),
  ];
  const s = deriveState(m, { now: T0 });
  assert.deepEqual(s[0].openTasks.map((t) => t.id), ['t2']);
});

test('duplicate acks by the same nurse are idempotent; malformed messages are skipped', () => {
  const m = [
    msg(card()), { payload: null }, {}, msg({ type: 'other' }),
    msg({ type: ACK_TYPE, cardId: 'c1', by: 'in1', readBack: RB, at: 1 }),
    msg({ type: ACK_TYPE, cardId: 'c1', by: 'in1', readBack: RB, at: 2 }),
  ];
  assert.equal(deriveState(m, { now: T0 })[0].acknowledgedBy.length, 1);
});

test('shiftSummary counts', () => {
  const m = [msg(card({ cardId: 'a', stability: 'critical', bed: '1' })), msg(card({ cardId: 'b', bed: '2' })), msg({ type: ACK_TYPE, cardId: 'b', by: 'in1', readBack: RB, at: 1 })];
  const s = shiftSummary(deriveState(m, { now: T0 + 11 * 60_000 }), { now: T0 + 11 * 60_000 });
  assert.equal(s.total, 2); assert.equal(s.acked, 1); assert.equal(s.awaiting, 1); assert.equal(s.escalated, 1);
  assert.equal(s.openTasks, 4);
});

test('blank-only pending tasks do not satisfy the pending-tasks requirement', () => {
  assert.equal(completeness({ ...full, pendingTasks: ['  ', ''] }).complete, false);
  assert.equal(completeness({ ...full, pendingTasks: ['  '], noPendingTasks: true }).complete, true);
});

test('identity is bound to the sender id: spoofed "by" or author fields are ignored', () => {
  const m = [
    msg(card()),
    msg({ type: ACK_TYPE, cardId: 'c1', by: 'in9', readBack: RB }, 'in1'),
  ];
  assert.deepEqual(deriveState(m, { now: T0 })[0].acknowledgedBy, ['in1']);
});

test('only outgoing-role senders can post cards; only incoming-role can acknowledge', () => {
  const rogue = [msg(card(), 'in2')];
  assert.equal(deriveState(rogue, { now: T0 }).length, 0);
  const m = [msg(card()), msg({ type: ACK_TYPE, cardId: 'c1', readBack: RB }, 'out2')];
  assert.equal(deriveState(m, { now: T0 })[0].status, 'awaiting');
  const noRole = [msg(card(), 'zed')];
  assert.equal(deriveState(noRole, { now: T0 }).length, 0);
});

test('another outgoing nurse cannot overwrite someone else\'s card', () => {
  const m = [msg(card({ assessment: 'orig' })), msg(card({ assessment: 'hijack' }), 'out2')];
  assert.equal(deriveState(m, { now: T0 })[0].card.assessment, 'orig');
});

test('an acknowledgement without a real read-back text does not count', () => {
  const base = [msg(card())];
  for (const rb of [undefined, '', '   ', 'ok', 'short']) {
    const m = [...base, msg({ type: ACK_TYPE, cardId: 'c1', readBack: rb }, 'in1')];
    assert.equal(deriveState(m, { now: T0 })[0].status, 'awaiting', String(rb));
  }
  const ok = [...base, msg({ type: ACK_TYPE, cardId: 'c1', readBack: RB }, 'in1')];
  assert.equal(deriveState(ok, { now: T0 })[0].readBacks[0].readBack, RB);
});

test('ack for an unknown card is ignored and a late ack cannot attach to a later reissued card id of another author', () => {
  const m = [msg({ type: ACK_TYPE, cardId: 'ghost', readBack: RB }, 'in1'), msg(card())];
  assert.equal(deriveState(m, { now: T0 })[0].status, 'awaiting');
});

test('reconnect replay: duplicate card delivery after an ack does not reset the acknowledgement', () => {
  const c = { ...msg(card()), id: 'm1' };
  const a = { ...msg({ type: ACK_TYPE, cardId: 'c1', readBack: RB }, 'in1'), id: 'm2' };
  const replay = [c, a, { ...c }]; // history re-delivered the card
  assert.equal(deriveState(replay, { now: T0 })[0].status, 'acknowledged');
});

test('out-of-order delivery: an ack that arrives before its card is replayed in time order', () => {
  const c = { ...msg(card()), id: 'm1', ts: 100 };
  const a = { ...msg({ type: ACK_TYPE, cardId: 'c1', readBack: RB }, 'in1'), id: 'm2', ts: 200 };
  assert.equal(deriveState([a, c], { now: T0 })[0].status, 'acknowledged');
});

test('a genuine correction after an ack (later timestamp, new id) does reset it', () => {
  const c1 = { ...msg(card()), id: 'm1', ts: 100 };
  const a = { ...msg({ type: ACK_TYPE, cardId: 'c1', readBack: RB }, 'in1'), id: 'm2', ts: 200 };
  const c2 = { ...msg(card({ assessment: 'changed' })), id: 'm3', ts: 300 };
  const s = deriveState([c1, a, c2], { now: T0 })[0];
  assert.equal(s.status, 'awaiting'); assert.equal(s.card.assessment, 'changed');
});

test('closed tasks survive a card correction; garbage entries are ignored', () => {
  const m = [msg(card({ cardId: 'a' })), msg({ type: TASK_TYPE, cardId: 'a', taskId: 't1' }), msg(card({ cardId: 'a', assessment: 'x' })), null, undefined, {}];
  assert.deepEqual(deriveState(m, { now: T0 })[0].openTasks.map((t) => t.id), ['t2']);
});

import { prioritise, needsAttention, shiftReportText } from '../core/handover.mjs';
test('escalation order and report text', () => {
  const mk = (bed, stability, status, escalated, open = []) => ({ card: { bed, ageSex: '1 F', situation: 's', background: 'b', assessment: 'a', recommendation: 'r', pendingTasks: [] }, stability, status, escalated, openTasks: open, readBacks: [], acknowledgedBy: [] });
  const a = mk('B1', 'critical', 'acknowledged', false), b = mk('B2', 'stable', 'awaiting', true), c = mk('B3', 'watch', 'awaiting', false);
  assert.deepEqual(prioritise([a, c, b]).map((s) => s.card.bed), ['B2', 'B3', 'B1']);
  assert.equal(needsAttention(a), false); assert.equal(needsAttention(c), true);
  const t = shiftReportText([a, b, c], { now: 0, who: 'X' });
  assert.match(t, /DEMO/); assert.ok(t.indexOf('B2') < t.indexOf('B1'));
});
