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
const msg = (payload, userId) => ({ payload, userId: userId ?? (payload.type === 'SS:ack' ? payload.by : payload.type === 'SS:task-done' ? 'in1' : 'out1'), ts: T0 + ++seq });
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

import { fmtDur, timingText } from '../core/handover.mjs';
test('timing text', () => {
  assert.equal(fmtDur(30000), 'under 1 min'); assert.equal(fmtDur(5 * 60000), '5 min'); assert.equal(fmtDur(125 * 60000), '2 h 5 min');
  assert.equal(timingText({ postedAt: null }, 5), 'time unknown');
  assert.equal(timingText({ postedAt: 1000, status: 'awaiting' }, 1000 + 4 * 60000), 'waiting 4 min since posting');
  assert.equal(timingText({ postedAt: 1000, status: 'acknowledged', ackAt: 1000 + 180000 }, 9e9), 'acknowledged 3 min after posting');
  const r = shiftReportText([], { now: 0 }); assert.match(r, /visual flag only/); assert.match(r, /Scope: all 0 cards/);
});

test('report audit lines', () => {
  const st = { card: { bed: 'B', ageSex: '1 F', situation: 's', background: 'b', assessment: 'a', recommendation: 'r', pendingTasks: [] }, stability: 'stable', status: 'acknowledged', escalated: false, openTasks: [], postedAt: 1000, author: 'out1', authorName: 'Priya', readBacks: [{ by: 'in1', at: 5000, readBack: 'text here ok' }], acknowledgedBy: ['in1'], ackAt: 5000 };
  const t = shiftReportText([st], { now: 9000 });
  assert.match(t, /Posted by Priya at 1970-01-01T00:00:01.000Z/); assert.match(t, /Read-back by in1 at 1970-01-01T00:00:05.000Z \(typed text, not validated\)/);
});

import { validTs, FUTURE_TOLERANCE_MS } from '../core/handover.mjs';
const mid = (payload, userId, id, ts) => ({ payload, userId, id, ts });
test('poster-controlled postedAt in the payload is ignored', () => {
  const now = 50 * 3_600_000;
  const forged = card({ cardId: 'f', stability: 'critical', postedAt: now - 3_600_000 }); // claims posted 1h ago
  const [s] = deriveState([mid(forged, 'out1', 'm1', now - 1000)], { now });
  assert.equal(s.postedAt, now - 1000); assert.equal(s.escalated, false);
  const future = card({ cardId: 'g', stability: 'critical', postedAt: now + 9e9 });
  assert.equal(deriveState([mid(future, 'out1', 'm2', now - 11 * 60_000)], { now })[0].escalated, true);
});
test('malformed or future transport timestamps mean unknown time, never overdue', () => {
  const now = 50 * 3_600_000;
  for (const ts of [undefined, null, NaN, 'x', 0, -5, now + FUTURE_TOLERANCE_MS + 1, Infinity]) {
    const [s] = deriveState([mid(card({ cardId: 'z', stability: 'critical' }), 'out1', 'mz', ts)], { now });
    assert.equal(s.postedAt, null, String(ts)); assert.equal(s.escalated, false); assert.equal(timingText(s, now), 'time unknown');
  }
  assert.equal(validTs(now + FUTURE_TOLERANCE_MS, now), now + FUTURE_TOLERANCE_MS);
});
test('ack time before post time or invalid is not shown as elapsed', () => {
  const now = 50 * 3_600_000, t = now - 600_000;
  const c = mid(card({ cardId: 'a1' }), 'out1', 'c', t);
  const early = mid({ type: ACK_TYPE, cardId: 'a1', readBack: RB }, 'in1', 'a', t - 5000);
  // replay is ordered by server time, so an ack stamped before its card cannot count
  assert.equal(deriveState([c, early], { now })[0].status, 'awaiting');
  const bad = mid({ type: ACK_TYPE, cardId: 'a1', readBack: RB }, 'in1', 'a', NaN);
  assert.equal(timingText(deriveState([c, bad], { now })[0], now), 'acknowledged (time unknown)');
  const ok = mid({ type: ACK_TYPE, cardId: 'a1', readBack: RB }, 'in1', 'a', t + 180_000);
  assert.equal(timingText(deriveState([c, ok], { now })[0], now), 'acknowledged 3 min after posting');
});
test('replay and out-of-order delivery do not change post time or duplicate acks', () => {
  const now = 50 * 3_600_000, t = now - 120_000;
  const c = mid(card({ cardId: 'r1' }), 'out1', 'c', t), a = mid({ type: ACK_TYPE, cardId: 'r1', readBack: RB }, 'in1', 'a', t + 60_000);
  const x = deriveState([a, c, c, a, c], { now }), y = deriveState([c, a], { now });
  assert.deepEqual(x.map((s) => [s.postedAt, s.ackAt, s.readBacks.length]), y.map((s) => [s.postedAt, s.ackAt, s.readBacks.length]));
  assert.deepEqual(x[0].readBacks.length, 1);
  // a replayed copy of the card with a later server time (different id) is a correction: original post time is kept
  const fix = mid(card({ cardId: 'r1', assessment: 'edited' }), 'out1', 'c2', t + 90_000);
  assert.equal(deriveState([c, a, fix], { now })[0].postedAt, t);
});

import { DEMO_ESCALATE_MS } from '../core/handover.mjs';
test('one demo threshold: reducer default, boundary, and report agree', () => {
  assert.equal(DEMO_ESCALATE_MS, 120000);
  const now = 50 * 3_600_000, c = (age) => deriveState([{ payload: card({ cardId: 'q', stability: 'watch' }), userId: 'out1', id: 'm', ts: now - age }], { now })[0];
  assert.equal(c(DEMO_ESCALATE_MS - 1).escalated, false); assert.equal(c(DEMO_ESCALATE_MS).escalated, true);
  assert.match(shiftReportText([], { now }), /unacknowledged for 2 min; a demo setting, not a clinical standard/);
  assert.match(shiftReportText([], { now, escalateAfterMs: 300000 }), /for 5 min/);
});

test('ack carries an optional display name; identity stays the transport sender id', () => {
  const m = [msg(card()), msg({ type: ACK_TYPE, cardId: 'c1', by: 'in1', readBack: RB, name: 'Meena', at: T0 + 5 })];
  const s = deriveState(m, { now: T0 + 1000 })[0];
  assert.equal(s.readBacks[0].name, 'Meena');
  assert.equal(s.readBacks[0].by, 'in1', 'identity must remain the transport userId');

  const noName = deriveState([msg(card()), msg({ type: ACK_TYPE, cardId: 'c1', by: 'in1', readBack: RB, at: T0 + 5 })], { now: T0 + 1000 })[0];
  assert.equal(noName.readBacks[0].name, '', 'acks without a name fall back to the sender id at render time');

  const longName = deriveState([msg(card()), msg({ type: ACK_TYPE, cardId: 'c1', by: 'in1', readBack: RB, name: '  ' + 'x'.repeat(80) + '  ', at: T0 + 5 })], { now: T0 + 1000 })[0];
  assert.equal(longName.readBacks[0].name.length, 30, 'display name is trimmed and capped');

  const nonString = deriveState([msg(card()), msg({ type: ACK_TYPE, cardId: 'c1', by: 'in1', readBack: RB, name: 42, at: T0 + 5 })], { now: T0 + 1000 })[0];
  assert.equal(nonString.readBacks[0].name, '', 'non-string name ignored');
});
