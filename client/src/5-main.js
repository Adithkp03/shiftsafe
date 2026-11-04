import { buildCard, completeness, deriveState, shiftSummary, REQUIRED_ITEMS, ACK_TYPE, TASK_TYPE, MIN_READBACK } from '@core/handover.mjs';
import { createTransport } from './transport.js';
import { SEED } from './seed.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nice = (id) => String(id).replace(/^(out|in)/, '');
const ESCALATE_MS = 2 * 60 * 1000; // demo window; a ward would set its own
const app = $('#app');
let transport, me, messages = [], online = true, notice = '', built = false;

const BANNER = `<div class="banner" role="note"><b>DEMO - synthetic patients only.</b> Not real patient data. ShiftSafe is a communication aid, not a medical device: it gives no medical advice, and every example below is fictional text written for this demo.</div>`;

renderLogin();

function renderLogin(err = '') {
  app.innerHTML = `${BANNER}
  <main class="login">
    <h1>ShiftSafe</h1>
    <p class="tag">Shift handover as chat: each patient is a structured card, and the incoming nurse must type a read-back before a card counts as acknowledged.</p>
    <form id="lf">
      <label>Your name <input name="name" required maxlength="30" autocomplete="off" placeholder="e.g. Anita"></label>
      <label>Invite code <input name="code" required autocomplete="off" placeholder="from your ward lead"></label>
      <button>Enter ward</button>
      <p class="err" role="alert">${esc(err)}</p>
    </form>
    <p class="note">Demo codes (local demo only): <code>demo-out</code> outgoing nurse, <code>demo-in</code> incoming nurse.</p>
  </main>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Connecting...';
    try {
      const r = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.get('name'), code: f.get('code') }) });
      const s = await r.json();
      if (!r.ok) throw new Error(s.error || 'could not sign in');
      me = { userId: s.userId, name: s.name, role: s.role };
      transport = await createTransport(s);
      transport.onStatus?.((x) => { online = x === 'online'; render(); });
      messages = await transport.history();
      transport.onMessages((m) => { messages = messages.concat(m); render(); });
      render(); setInterval(render, 1000);
    } catch (err) { renderLogin(err.message); }
  };
}

async function send(payload) {
  try { await transport.send(payload); notice = ''; }
  catch (e) { notice = 'Could not send: ' + e.message + '. Check your connection and try again.'; render(); }
}

function render() {
  const now = Date.now();
  const states = deriveState(messages, { now, escalateAfterMs: ESCALATE_MS });
  const sum = shiftSummary(states, { now });
  if (!built) {
    built = true;
    app.innerHTML = `${BANNER}
    <header><b>ShiftSafe</b><span class="mode">${esc(transport.mode === 'nexconn' ? 'Nexconn Chat SDK' : 'local demo relay')}</span><span id="net"></span>
      <span class="who">${esc(me.name)} · ${me.role === 'out' ? 'outgoing' : 'incoming'}</span></header>
    <div id="notice" role="alert"></div>
    <section class="summary" id="summary"></section>
    <div class="cols"><section class="cards" id="cards" aria-live="polite"></section>
    ${me.role === 'out' ? formHtml() : '<aside class="side"><h3>How to take over</h3><p>Open each card, then type the key points back in your own words and press <b>Acknowledge</b>. Your name and text are recorded. The app records that a read-back was typed; it cannot judge whether it is right.</p></aside>'}</div>`;
    wireStatic();
  }
  $('#net').innerHTML = online ? '' : '<span class="off">offline - changes will not send</span>';
  $('#notice').textContent = notice;
  $('#summary').innerHTML = `
    <div><b>${sum.acked}/${sum.total}</b><small>acknowledged</small></div>
    <div class="${sum.escalated ? 'bad' : ''}"><b>${sum.escalated}</b><small>not acknowledged in time</small></div>
    <div><b>${sum.openTasks}</b><small>open tasks</small></div>
    <div class="grow"><div class="bar"><i style="width:${Math.round(sum.ackRate * 100)}%"></i></div><small>${sum.total === 0 ? 'no cards yet' : sum.awaiting === 0 ? 'all cards acknowledged' : sum.awaiting + ' awaiting acknowledgement'}</small></div>
    ${me.role === 'out' ? '<button id="seed" class="ghost">Load fictional demo ward</button>' : ''}`;
  $('#cards').innerHTML = states.length ? states.map(cardHtml).join('')
    : `<p class="empty">No handover cards yet. ${me.role === 'out' ? 'Add one with the form, or load the fictional demo ward.' : 'Cards appear here as soon as the outgoing nurse posts them.'}</p>`;
}

function cardHtml(s) {
  const c = s.card;
  const canAck = me.role === 'in' && !s.acknowledgedBy.includes(me.userId);
  const tasks = c.pendingTasks.map((t) => { const open = s.openTasks.some((o) => o.id === t.id); return `<li class="${open ? '' : 'done'}"><label><input type="checkbox" data-task="${esc(c.cardId)}|${esc(t.id)}" ${open ? '' : 'checked disabled'}> ${esc(t.text)}</label></li>`; }).join('');
  const rb = s.readBacks.map((a) => `<p class="rb"><b>${esc(nice(a.by))} read back:</b> ${esc(a.readBack)}</p>`).join('');
  return `<article class="card ${s.stability} ${s.status} ${s.escalated ? 'esc' : ''}">
    <div class="top"><b>${esc(c.bed)}</b> <span>${esc(c.ageSex)}</span> <em class="pill ${s.stability}">${s.stability}</em>
      <span class="st">${s.escalated ? 'NOT ACKNOWLEDGED IN TIME' : s.status === 'acknowledged' ? 'acknowledged by ' + esc(s.acknowledgedBy.map(nice).join(', ')) : 'awaiting acknowledgement'}</span></div>
    <dl><dt>Situation</dt><dd>${esc(c.situation)}</dd><dt>Background</dt><dd>${esc(c.background)}</dd>
    <dt>Assessment</dt><dd>${esc(c.assessment)}</dd><dt>Plan (written by outgoing nurse from doctor's orders)</dt><dd>${esc(c.recommendation)}</dd></dl>
    ${tasks ? `<ul class="tasks">${tasks}</ul>` : '<p class="none">No pending tasks (stated explicitly)</p>'}
    <small>Handed over by ${esc(c.authorName || nice(c.author))}</small>
    ${rb}
    ${canAck ? `<form class="ack" data-card="${esc(c.cardId)}"><label>Read back in your own words (at least ${MIN_READBACK} characters)<textarea name="rb" rows="2" required minlength="${MIN_READBACK}"></textarea></label><button>Acknowledge</button></form>` : ''}
  </article>`;
}

function formHtml() {
  return `<aside class="side"><h3>New handover card</h3><form id="form">
    ${[['bed', 'Bed / room'], ['ageSex', 'Age and sex'], ['situation', 'Situation'], ['background', 'Background'], ['assessment', 'Assessment (what you observed)'], ['recommendation', 'Plan (as ordered by the doctor)']]
      .map(([k, l]) => `<label>${l}<input name="${k}" autocomplete="off"></label>`).join('')}
    <label>Stability (your judgement) <select name="stability"><option value="">choose</option><option>stable</option><option>watch</option><option>critical</option></select></label>
    <label>Pending tasks (one per line) <textarea name="tasks" rows="3"></textarea></label>
    <label class="chk"><input type="checkbox" name="none"> No pending tasks</label>
    <div id="meter"></div><button>Post card</button></form></aside>`;
}

function wireStatic() {
  app.addEventListener('click', async (e) => {
    const t = e.target.closest('#seed'); if (!t) return;
    t.disabled = true;
    for (const d of SEED) await send(buildCard(d, { author: me.name, shiftId: 'night', now: Date.now() }));
  });
  app.addEventListener('submit', (e) => {
    const f = e.target.closest('.ack'); if (!f) return;
    e.preventDefault();
    send({ type: ACK_TYPE, cardId: f.dataset.card, readBack: new FormData(f).get('rb') });
  });
  app.addEventListener('change', (e) => {
    const t = e.target; if (!t.dataset?.task) return;
    const [cardId, taskId] = t.dataset.task.split('|'); send({ type: TASK_TYPE, cardId, taskId });
  });
  const f = $('#form'); if (!f) return;
  const draft = () => { const v = Object.fromEntries(new FormData(f)); return { ...v, cardId: 'c' + Date.now(), pendingTasks: (v.tasks || '').split('\n'), noPendingTasks: v.none === 'on' }; };
  const meter = () => { const c = completeness(draft()); $('#meter').innerHTML = `<div class="bar"><i style="width:${(c.score / c.total) * 100}%"></i></div><small>${c.score}/${c.total} fields filled${c.missing.length ? ' - still needed: ' + c.missing.map((k) => REQUIRED_ITEMS.find((r) => r.key === k).label.split(':')[0]).join(', ') : ' - ready to post'}</small>`; };
  f.oninput = meter; meter();
  f.onsubmit = async (e) => { e.preventDefault(); try { await send(buildCard(draft(), { author: me.name, shiftId: 'night', now: Date.now() })); f.reset(); meter(); } catch (err) { if (err.code === 'INCOMPLETE') meter(); else { notice = err.message; render(); } } };
}
