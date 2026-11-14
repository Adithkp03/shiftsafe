// ShiftSafe core: pure functions, no I/O. Handover state is derived from an
// append-only list of channel messages (Nexconn custom messages carry these JSON payloads).
// This is a coordination aid. It never recommends clinical actions.

export const CARD_TYPE = 'SS:card';
export const ACK_TYPE = 'SS:ack';
export const TASK_TYPE = 'SS:task-done';

// Minimum information a patient handover must carry before it can be posted.
// Items are communication items only (who/what/when), not clinical advice.
export const REQUIRED_ITEMS = [
  { key: 'bed', label: 'Bed / room' },
  { key: 'ageSex', label: 'Age and sex' },
  { key: 'situation', label: 'Situation: why the patient is here now' },
  { key: 'background', label: 'Background: relevant history' },
  { key: 'assessment', label: 'Assessment: current status as observed by the nurse' },
  { key: 'recommendation', label: 'Recommendation / plan as ordered by the doctor' },
  { key: 'stability', label: 'Stability status (stable / watch / critical)' },
  { key: 'pendingTasks', label: 'Pending tasks (can be an explicit "none")' },
];

export const MIN_READBACK = 10;
export const STABILITY = ['stable', 'watch', 'critical'];

// Roles are issued by the server and encoded in the user id prefix ('out...' / 'in...').
export const roleOf = (userId) => (/^out/.test(userId || '') ? 'out' : /^in/.test(userId || '') ? 'in' : null);

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';

/** Returns { complete, score, total, missing[] } for a draft card. */
export function completeness(draft) {
  const missing = [];
  for (const item of REQUIRED_ITEMS) {
    if (item.key === 'pendingTasks') {
      const real = Array.isArray(draft.pendingTasks) ? draft.pendingTasks.filter((t) => !isBlank(t)) : [];
      if (real.length === 0 && draft.noPendingTasks !== true) missing.push(item.key);
      continue;
    }
    if (item.key === 'stability') {
      if (!STABILITY.includes(draft.stability)) missing.push(item.key);
      continue;
    }
    if (isBlank(draft[item.key])) missing.push(item.key);
  }
  const total = REQUIRED_ITEMS.length;
  return { complete: missing.length === 0, score: total - missing.length, total, missing };
}

/** Validate and normalise a card for posting. Throws on incomplete cards. */
export function buildCard(draft, { author, shiftId, now }) {
  const c = completeness(draft);
  if (!c.complete) {
    const err = new Error('Incomplete handover card');
    err.code = 'INCOMPLETE';
    err.missing = c.missing;
    throw err;
  }
  const tasks = (draft.pendingTasks || [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .map((text, i) => ({ id: `t${i + 1}`, text }));
  return {
    type: CARD_TYPE,
    cardId: draft.cardId,
    shiftId,
    authorName: author,
    postedAt: now,
    bed: String(draft.bed).trim(),
    ageSex: String(draft.ageSex).trim(),
    situation: String(draft.situation).trim(),
    background: String(draft.background).trim(),
    assessment: String(draft.assessment).trim(),
    recommendation: String(draft.recommendation).trim(),
    stability: draft.stability,
    pendingTasks: tasks,
  };
}

/**
 * Derive per-card state from messages (oldest first). A card is:
 *  - 'awaiting'  : posted, not yet acknowledged by an incoming nurse
 *  - 'acknowledged': acked by someone other than the author
 * Self-acknowledgement is ignored (read-back must come from a different person).
 * A newer card with the same cardId supersedes the old one (corrections).
 */
// One demo threshold for the overdue flag, used by the reducer default, the UI and the report. It is a demo
// setting chosen for visibility, not a clinical standard; a ward would set its own.
export const DEMO_ESCALATE_MS = 2 * 60 * 1000;
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
/** A usable event time: finite, positive, and not in the future beyond tolerance. Otherwise null (unknown). */
export function validTs(ts, now) {
  return typeof ts === 'number' && Number.isFinite(ts) && ts > 0 && ts <= now + FUTURE_TOLERANCE_MS ? ts : null;
}

export function deriveState(messages, { now, escalateAfterMs = DEMO_ESCALATE_MS } = {}) {
  // Reconnects replay history, so the same message can arrive twice and out of order.
  // Drop duplicates by message id and replay in timestamp order (stable for equal timestamps).
  const seen = new Set();
  messages = messages
    .filter(Boolean)
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => { if (m && m.id != null) { if (seen.has(m.id)) return false; seen.add(m.id); } return true; })
    .sort((a, b) => ((a.m.ts ?? 0) - (b.m.ts ?? 0)) || a.i - b.i)
    .map(({ m }) => m);
  const cards = new Map();
  // Identity comes from the transport's sender id (m.userId), never from payload fields,
  // so a client cannot post or acknowledge as someone else.
  for (const m of messages) {
    const p = m && m.payload;
    if (!p || !m.userId) continue;
    const role = roleOf(m.userId);
    if (p.type === CARD_TYPE) {
      if (role !== 'out' || typeof p.cardId !== 'string') continue; // only outgoing nurses post cards
      const prev = cards.get(p.cardId);
      if (prev && prev.card.sender !== m.userId) continue; // only the original author may correct a card
      // Time comes from the transport's server timestamp (m.ts), never from the payload: a poster-controlled
      // postedAt must not drive overdue status. A corrected card keeps the original posting time.
      const at = prev ? prev.postedAt : validTs(m.ts, now);
      // A correction replaces the card and voids earlier acknowledgements (acks: []) - the new text was
      // never read back. Task completions survive only where the task id still has the SAME text: task
      // ids are positional, so an edited or reordered task must be closed again, not inherit a "done".
      const prevText = new Map(prev ? prev.card.pendingTasks.map((t) => [t.id, t.text]) : []);
      const kept = new Map();
      if (prev) for (const t of p.pendingTasks) if (prev.doneTasks.has(t.id) && prevText.get(t.id) === t.text) kept.set(t.id, prev.doneTasks.get(t.id));
      const editedAt = prev ? validTs(m.ts, now) : null;
      cards.set(p.cardId, { card: { ...p, postedAt: undefined, sender: m.userId, author: m.userId }, postedAt: at, acks: [], doneTasks: kept, editedAt, edits: (prev ? prev.edits : 0) + (prev ? 1 : 0) });
    } else if (p.type === ACK_TYPE) {
      const s = cards.get(p.cardId);
      if (!s || role !== 'in') continue; // only incoming nurses acknowledge
      if (s.acks.some((a) => a.by === m.userId)) continue;
      // An acknowledgement must carry the incoming nurse's own read-back text. This records that a
      // read-back was typed; it does not verify that it is correct or that it shows understanding.
      const rb = typeof p.readBack === 'string' ? p.readBack.trim() : '';
      if (rb.length < MIN_READBACK) continue;
      // Display name is payload data (untrusted, cosmetic only - identity stays m.userId, as with authorName on cards).
      const nm = typeof p.name === 'string' ? p.name.trim().slice(0, 30) : '';
      s.acks.push({ by: m.userId, at: validTs(m.ts, now), readBack: rb.slice(0, 500), name: nm });
    } else if (p.type === TASK_TYPE) {
      const s = cards.get(p.cardId);
      // A task cannot be reopened, so the first completion record wins. Identity is the transport
      // sender id; the name is cosmetic payload text (untrusted, same rule as ack display names).
      if (s && role && s.card.pendingTasks.some((t) => t.id === p.taskId) && !s.doneTasks.has(p.taskId)) {
        const nm = typeof p.name === 'string' ? p.name.trim().slice(0, 30) : '';
        s.doneTasks.set(p.taskId, { by: m.userId, at: validTs(m.ts, now), name: nm });
      }
    }
  }
  const out = [];
  for (const { card, postedAt, acks, doneTasks, editedAt, edits } of cards.values()) {
    const acknowledged = acks.length > 0;
    // Unknown or invalid post time means we cannot say it is overdue.
    const overdue = !acknowledged && postedAt != null && now - postedAt >= escalateAfterMs;
    // critical or watch cards that are overdue escalate; stable ones just stay pinned
    const escalated = overdue && card.stability !== 'stable';
    const openTasks = card.pendingTasks.filter((t) => !doneTasks.has(t.id));
    out.push({
      cardId: card.cardId,
      bed: card.bed,
      stability: card.stability,
      author: card.author,
      authorName: card.authorName,
      status: acknowledged ? 'acknowledged' : 'awaiting',
      acknowledgedBy: acks.map((a) => a.by),
      readBacks: acks,
      escalated,
      openTasks,
      doneTasks,
      editedAt: editedAt || null,
      edits: edits || 0,
      postedAt,
      ackAt: acks.length ? acks[0].at : null,
      card,
    });
  }
  const rank = { critical: 0, watch: 1, stable: 2 };
  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'awaiting' ? -1 : 1;
    return rank[a.stability] - rank[b.stability] || a.bed.localeCompare(b.bed);
  });
  return out;
}

/** Shift-level summary used for the audit view. */
export function shiftSummary(states, { now }) {
  const total = states.length;
  const acked = states.filter((s) => s.status === 'acknowledged').length;
  const awaiting = total - acked;
  const escalated = states.filter((s) => s.escalated).length;
  const openTasks = states.reduce((n, s) => n + s.openTasks.length, 0);
  const times = states
    .filter((s) => s.status === 'acknowledged')
    .map((s) => s.card && null)
    .filter(Boolean);
  return { total, acked, awaiting, escalated, openTasks, ackRate: total ? acked / total : 1, times };
}

// Escalation view order: not-acknowledged-in-time first, then unacknowledged, then by stability, then bed.
const RANK = { critical: 0, watch: 1, stable: 2 };
export function prioritise(states) {
  const score = (s) => (s.escalated ? 0 : s.status === 'acknowledged' ? 2 : 1);
  return [...states].sort((a, b) => score(a) - score(b) || (RANK[a.stability] ?? 3) - (RANK[b.stability] ?? 3) || String(a.card.bed).localeCompare(String(b.card.bed)));
}
export function fmtDur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 1 ? 'under 1 min' : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}
// Timing line for a card. Elapsed time only; nothing here notifies anyone.
export function timingText(s, now) {
  if (s.postedAt == null) return 'time unknown';
  if (s.status === 'acknowledged') return s.ackAt != null && s.ackAt >= s.postedAt ? 'acknowledged ' + fmtDur(s.ackAt - s.postedAt) + ' after posting' : 'acknowledged (time unknown)';
  return 'waiting ' + fmtDur(now - s.postedAt) + ' since posting';
}
export const needsAttention = (s) => s.escalated || s.status !== 'acknowledged' || s.openTasks.length > 0;

// Plain-text shift report. Synthetic demo content only; makes no clinical judgement.
export function shiftReportText(states, { now, who = '', escalateAfterMs = DEMO_ESCALATE_MS } = {}) {
  const sum = shiftSummary(states, { now });
  const L = ['SHIFTSAFE HANDOVER REPORT (DEMO - fictional data)', `Generated: ${new Date(now).toISOString()}${who ? ' by ' + who : ''}`,
    `Acknowledged ${sum.acked}/${sum.total} | not acknowledged in time: ${sum.escalated} | open tasks: ${sum.openTasks}`,
    `Scope: all ${sum.total} cards on this ward (the on-screen "needs attention" filter is not applied).`,
    'Note: a read-back is text a nurse typed; this app cannot judge whether it is correct.',
    `Note: "NOT ACKNOWLEDGED IN TIME" is a visual flag only (a watch/critical card unacknowledged for ${Math.round(escalateAfterMs / 60000)} min; a demo setting, not a clinical standard). ShiftSafe sends no alert or notification to anyone. No medical advice or clinical judgement is given.`, ''];
  for (const s of prioritise(states)) {
    const c = s.card;
    L.push(`[${s.escalated ? 'NOT ACKNOWLEDGED IN TIME' : s.status === 'acknowledged' ? 'acknowledged' : 'awaiting acknowledgement'}] ${c.bed} (${c.ageSex}) - ${s.stability}`);
    { const tt = timingText(s, now); if (tt) L.push('  Timing: ' + tt); }
    L.push(`  Situation: ${c.situation}`, `  Background: ${c.background}`, `  Assessment: ${c.assessment}`, `  Plan (doctor's orders as written by outgoing nurse): ${c.recommendation}`);
    for (const t of c.pendingTasks) {
      const d = s.doneTasks && s.doneTasks.get(t.id);
      const who = d ? (d.name || d.by) : null;
      const doneTxt = '[x] done' + (who ? ' by ' + who : '') + (d && d.at ? ' at ' + new Date(d.at).toISOString() : '');
      L.push(`  ${s.openTasks.some((o) => o.id === t.id) ? '[ ] OPEN' : doneTxt}: ${t.text}`);
    }
    for (const a of s.readBacks) L.push(`  Read-back by ${a.name || a.by}${a.at ? ' at ' + new Date(a.at).toISOString() : ''} (typed text, not validated): ${a.readBack}`);
    if (s.postedAt != null) L.push(`  Posted by ${s.authorName || s.author} at ${new Date(s.postedAt).toISOString()}`);
    if (s.editedAt) L.push(`  Corrected since posting: edit ${s.edits} at ${new Date(s.editedAt).toISOString()} (replaced the previous version; earlier acknowledgements were voided and the current card awaits a fresh read-back)`);
    L.push('');
  }
  return L.join('\n');
}
