import { buildCard, completeness, deriveState, shiftSummary, REQUIRED_ITEMS, ACK_TYPE, TASK_TYPE } from '@core/handover.mjs';
import { createTransport } from './transport.js';
import { SEED } from './seed.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ESCALATE_MS = 2 * 60 * 1000; // demo window; real wards would set their own
const app = $('#app');
let transport, me, messages = [];

renderLogin();

function renderLogin() {
  app.innerHTML = `
  <main class="login">
    <h1>ShiftSafe</h1>
    <p class="tag">Nothing gets lost between shifts. Every patient handover is complete, and acknowledged by the person taking over.</p>
    <form id="lf">
      <label>Your name <input name="name" required maxlength="30" placeholder="e.g. Anita"></label>
      <label>Role <select name="role"><option value="out">Outgoing nurse (hands over)</option><option value="in">Incoming nurse (takes over)</option></select></label>
      <button>Enter ward</button>
    </form>
    <p class="note">Demo with synthetic patients only. ShiftSafe is a communication aid: it never recommends treatment and is not a medical device.</p>
  </main>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = String(f.get('name')).trim();
    const userId = (f.get('role') + name.replace(/[^A-Za-z0-9]/g, '')).slice(0, 40);
    try {
      const s = await (await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, name }) })).json();
      if (s.error) throw new Error(s.error);
      me = { userId, name, role: f.get('role') };
      transport = await createTransport(s);
      messages = await transport.history();
      transport.onMessages((m) => { messages = messages.concat(m); render(); });
      render(); setInterval(render, 1000);
    } catch (err) { alert('Could not connect: ' + err.message); }
  };
}

const send = (payload) => transport.send(payload);

let built = false;
function render() {
  const now = Date.now();
  const states = deriveState(messages, { now, escalateAfterMs: ESCALATE_MS });
  const sum = shiftSummary(states, { now });
  if (!built) {
    built = true;
    app.innerHTML = `
    <header><b>ShiftSafe</b><span class="mode">${esc(transport.mode === 'nexconn' ? 'Nexconn live' : 'local demo relay')}</span>
      <span class="who">${esc(me.name)} · ${me.role === 'out' ? 'outgoing' : 'incoming'}</span></header>
    <section class="summary" id="summary"></section>
    <div class="cols"><section class="cards" id="cards"></section>
    ${me.role === 'out' ? formHtml() : '<aside class="side"><h3>Incoming checklist</h3><p>Read each card, then press <b>Read back &amp; accept</b>. Your name is recorded. Cards from you do not count as acknowledged.</p></aside>'}</div>`;
    wireStatic();
  }
  $('#summary').innerHTML = `
    <div><b>${sum.acked}/${sum.total}</b><small>acknowledged</small></div>
    <div class="${sum.escalated ? 'bad' : ''}"><b>${sum.escalated}</b><small>escalated</small></div>
    <div><b>${sum.openTasks}</b><small>open tasks</small></div>
    <div class="grow"><div class="bar"><i style="width:${Math.round(sum.ackRate * 100)}%"></i></div><small>handover ${sum.total && sum.awaiting === 0 ? 'complete' : 'in progress'}</small></div>
    ${me.role === 'out' ? '<button id="seed" class="ghost">Load synthetic ward</button>' : ''}`;
  $('#cards').innerHTML = states.length ? states.map(cardHtml).join('') : '<p class="empty">No handover cards yet.</p>';
}

function cardHtml(s) {
  const c = s.card;
  const mine = me.role === 'in' && s.status === 'awaiting';
  const tasks = c.pendingTasks.map((t) => `<li class="${s.openTasks.some((o) => o.id === t.id) ? '' : 'done'}"><label><input type="checkbox" data-task="${esc(c.cardId)}|${esc(t.id)}" ${s.openTasks.some((o) => o.id === t.id) ? '' : 'checked disabled'}> ${esc(t.text)}</label></li>`).join('');
  return `<article class="card ${s.stability} ${s.status} ${s.escalated ? 'esc' : ''}">
    <div class="top"><b>${esc(c.bed)}</b> <span>${esc(c.ageSex)}</span> <em class="pill ${s.stability}">${s.stability}</em>
      <span class="st">${s.escalated ? 'NOT ACKNOWLEDGED - escalate' : s.status === 'acknowledged' ? 'acknowledged by ' + esc(s.acknowledgedBy.join(', ')) : 'awaiting acknowledgement'}</span></div>
    <dl><dt>Situation</dt><dd>${esc(c.situation)}</dd><dt>Background</dt><dd>${esc(c.background)}</dd>
    <dt>Assessment</dt><dd>${esc(c.assessment)}</dd><dt>Plan (doctor's)</dt><dd>${esc(c.recommendation)}</dd></dl>
    ${tasks ? `<ul class="tasks">${tasks}</ul>` : '<p class="none">No pending tasks (stated explicitly)</p>'}
    <small>Handed over by ${esc(c.author)}</small>
    ${mine ? `<button data-ack="${esc(c.cardId)}">Read back &amp; accept</button>` : ''}
  </article>`;
}

function formHtml() {
  return `<aside class="side"><h3>New handover card</h3><form id="form">
    ${[['bed', 'Bed / room'], ['ageSex', 'Age and sex'], ['situation', 'Situation'], ['background', 'Background'], ['assessment', 'Assessment (what you observed)'], ['recommendation', "Plan (as ordered by doctor)"]]
      .map(([k, l]) => `<label>${l}<input name="${k}"></label>`).join('')}
    <label>Stability <select name="stability"><option value="">choose</option><option>stable</option><option>watch</option><option>critical</option></select></label>
    <label>Pending tasks (one per line) <textarea name="tasks" rows="3"></textarea></label>
    <label class="chk"><input type="checkbox" name="none"> No pending tasks</label>
    <div id="meter"></div><button>Post card</button></form></aside>`;
}

function wireStatic() {
  app.addEventListener('click', async (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.id === 'seed') { for (const d of SEED) await send(buildCard(d, { author: me.name, shiftId: 'night', now: Date.now() })); }
    if (t.dataset.ack) send({ type: ACK_TYPE, cardId: t.dataset.ack, by: me.name, at: Date.now() });
  });
  app.addEventListener('change', (e) => {
    const t = e.target; if (!t.dataset?.task) return;
    const [cardId, taskId] = t.dataset.task.split('|'); send({ type: TASK_TYPE, cardId, taskId, by: me.name });
  });
  const f = $('#form'); if (!f) return;
  const draft = () => { const v = Object.fromEntries(new FormData(f)); return { ...v, cardId: 'c' + Date.now(), pendingTasks: (v.tasks || '').split('\n'), noPendingTasks: v.none === 'on' }; };
  const meter = () => { const c = completeness(draft()); $('#meter').innerHTML = `<div class="bar"><i style="width:${(c.score / c.total) * 100}%"></i></div><small>${c.score}/${c.total} items${c.missing.length ? ' - missing: ' + c.missing.map((k) => REQUIRED_ITEMS.find((r) => r.key === k).label.split(':')[0]).join(', ') : ' - ready'}</small>`; };
  f.oninput = meter; meter();
  f.onsubmit = async (e) => { e.preventDefault(); try { await send(buildCard(draft(), { author: me.name, shiftId: 'night', now: Date.now() })); f.reset(); } catch (err) { if (err.code === 'INCOMPLETE') meter(); else alert(err.message); } };
}
