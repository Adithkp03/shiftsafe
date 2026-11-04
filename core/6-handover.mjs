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

export const STABILITY = ['stable', 'watch', 'critical'];

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
    author,
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
export function deriveState(messages, { now, escalateAfterMs = 10 * 60 * 1000 } = {}) {
  const cards = new Map();
  for (const m of messages) {
    const p = m.payload;
    if (!p) continue;
    if (p.type === CARD_TYPE) {
      cards.set(p.cardId, { card: p, acks: [], doneTasks: new Set(), supersededAt: null });
    } else if (p.type === ACK_TYPE) {
      const s = cards.get(p.cardId);
      if (!s) continue;
      if (p.by === s.card.author) continue; // self-ack does not count
      if (s.acks.some((a) => a.by === p.by)) continue;
      s.acks.push({ by: p.by, at: p.at });
    } else if (p.type === TASK_TYPE) {
      const s = cards.get(p.cardId);
      if (s && s.card.pendingTasks.some((t) => t.id === p.taskId)) s.doneTasks.add(p.taskId);
    }
  }
  const out = [];
  for (const { card, acks, doneTasks } of cards.values()) {
    const acknowledged = acks.length > 0;
    const age = now - card.postedAt;
    const overdue = !acknowledged && age >= escalateAfterMs;
    // critical or watch cards that are overdue escalate; stable ones just stay pinned
    const escalated = overdue && card.stability !== 'stable';
    const openTasks = card.pendingTasks.filter((t) => !doneTasks.has(t.id));
    out.push({
      cardId: card.cardId,
      bed: card.bed,
      stability: card.stability,
      author: card.author,
      status: acknowledged ? 'acknowledged' : 'awaiting',
      acknowledgedBy: acks.map((a) => a.by),
      escalated,
      openTasks,
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
