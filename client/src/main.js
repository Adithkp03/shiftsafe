import { buildCard, completeness, deriveState, shiftSummary, prioritise, needsAttention, shiftReportText, timingText, REQUIRED_ITEMS, ACK_TYPE, TASK_TYPE, MIN_READBACK } from '@core/handover.mjs';
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
      if (typeof s.serverNow === 'number') skew = Date.now() - s.serverNow;
      transport = await createTransport(s);
      transport.onStatus?.(async (x) => {
        const was = online; online = x === 'online'; render();
        if (online && !was) { try { messages = messages.concat(await transport.history()); render(); } catch { notice = 'Reconnected, but could not refresh history. Reload the page.'; render(); } } // dedupe happens in the reducer
      });
      try { messages = await transport.history(); } catch { notice = 'Could not load earlier cards yet. Retrying...'; }
      transport.onMessages((m) => { sampleSkew(m); messages = messages.concat(m); render(); });
      render(); setInterval(render, 1000);
      // A user who was just added to the ward can query history before the server finishes the join; refresh a few times (reducer dedupes by id).
      let loaded = notice === '';
      [2500, 6000, 12000].forEach((ms, n, all) => setTimeout(async () => {
        try { const h = await transport.history(); loaded = true; if (notice.startsWith('Could not load earlier')) notice = ''; if (h.length) messages = messages.concat(h); render(); }
        catch { if (!loaded && n === all.length - 1) { notice = 'Could not load earlier cards. What you see may be incomplete - reload the page.'; render(); } }
      }, ms));
    } catch (err) { renderLogin(err.message); }
  };
}

async function send(payload) {
  if (!online) { notice = 'You are offline. Nothing was sent. Reconnect and try again.'; render(); return; }
  try { await transport.send(payload); notice = ''; }
  catch (e) { notice = 'Could not send: ' + e.message + '. Check your connection and try again.'; render(); }
}

// Clock skew: card/ack times come from server timestamps, so "now" must be on the same clock. Start from the
// session response's server time, then refine with live-delivered messages (smallest local-minus-server gap is
// the best estimate; it is accurate to about the network latency, not exactly).
let skew = 0, liveSkew = null;
const serverNow = () => Date.now() - skew;
function sampleSkew(msgs) { for (const m of msgs) if (typeof m.ts === 'number' && m.ts > 0) { const g = Date.now() - m.ts; if (liveSkew == null || g < liveSkew) liveSkew = g; } if (liveSkew != null) skew = liveSkew; }
let lastCards = null, lastSummary = null, attentionOnly = false;
function render() {
  const now = serverNow();
  const all = deriveState(messages, { now, escalateAfterMs: ESCALATE_MS });
  const states = prioritise(attentionOnly ? all.filter(needsAttention) : all);
  const sum = shiftSummary(all, { now });
  if (!built) {
    built = true;
    app.innerHTML = `${BANNER}
    <header><b>ShiftSafe</b><span class="mode">${esc(transport.mode === 'nexconn' ? 'Nexconn Chat SDK' : 'local demo relay')}</span><span id="net"></span>
      <span class="who">${esc(me.name)} · ${me.role === 'out' ? 'outgoing' : 'incoming'}</span></header>
    <div id="notice" role="alert"></div>
    <section class="summary" id="summary"></section>
    <p class="hint">"Not acknowledged in time" is a visual flag only. ShiftSafe sends no alert or notification to anyone.</p>
    <div class="cols"><section class="cards" id="cards" aria-live="polite"></section>
    ${me.role === 'out' ? formHtml() : '<aside class="side"><h3>How to take over</h3><p>Open each card, then type the key points back in your own words and press <b>Acknowledge</b>. Your name and text are recorded. The app records that a read-back was typed; it cannot judge whether it is right.</p></aside>'}</div>`;
    wireStatic();
  }
  $('#net').innerHTML = online ? '' : '<span class="off">offline - changes will not send</span>';
  $('#notice').textContent = notice;
  const summaryHtml = `
    <div><b>${sum.acked}/${sum.total}</b><small>acknowledged</small></div>
    <div class="${sum.escalated ? 'bad' : ''}"><b>${sum.escalated}</b><small>not acknowledged in time</small></div>
    <div><b>${sum.openTasks}</b><small>open tasks</small></div>
    <div class="grow"><div class="bar"><i style="width:${sum.total === 0 ? 0 : Math.round(sum.ackRate * 100)}%"></i></div><small>${sum.total === 0 ? 'no cards yet' : sum.awaiting === 0 ? 'all cards acknowledged' : sum.awaiting + ' awaiting acknowledgement'}</small></div>
    <div class="acts"><button id="attn" class="ghost" aria-pressed="${attentionOnly}">${attentionOnly ? 'Showing: needs attention - show all' : 'Show only cards needing attention'}</button><button id="dl" class="ghost">Download shift report</button>
    ${me.role === 'out' ? '<button id="seed" class="ghost">Load fictional demo ward</button>' : ''}</div>`;
  if (summaryHtml !== lastSummary) { lastSummary = summaryHtml; $('#summary').innerHTML = summaryHtml; }
  const cardsHtml = states.length ? states.map((x) => cardHtml(x, now)).join('')
    : `<p class="empty">No handover cards yet. ${me.role === 'out' ? 'Add one with the form, or load the fictional demo ward.' : 'Cards appear here as soon as the outgoing nurse posts them.'}</p>`;
  // The 1s tick must not rebuild the DOM when nothing changed, or a half-typed read-back is wiped.
  if (cardsHtml !== lastCards) {
    lastCards = cardsHtml;
    // Keep half-typed read-backs (and focus/caret) when a new message re-renders the list.
    const drafts = {}; let focus = null;
    for (const f of document.querySelectorAll('#cards form.ack')) {
      const ta = f.querySelector('textarea'); if (ta.value) drafts[f.dataset.card] = ta.value;
      if (document.activeElement === ta) focus = { card: f.dataset.card, start: ta.selectionStart, end: ta.selectionEnd };
    }
    $('#cards').innerHTML = cardsHtml;
    for (const f of document.querySelectorAll('#cards form.ack')) {
      const ta = f.querySelector('textarea'), d = drafts[f.dataset.card]; if (d != null) ta.value = d;
      if (focus && focus.card === f.dataset.card) { ta.focus(); ta.setSelectionRange(focus.start, focus.end); }
    }
  }
}

function cardHtml(s, now) {
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
    <small>Handed over by ${esc(c.authorName || nice(c.author))}${timingText(s, now) ? ' · ' + esc(timingText(s, now)) : ''}</small>
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
    if (e.target.closest('#attn')) { attentionOnly = !attentionOnly; render(); return; }
    if (e.target.closest('#dl')) {
      const now = serverNow(), txt = shiftReportText(deriveState(messages, { now, escalateAfterMs: ESCALATE_MS }), { now, who: me.name });
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' })); a.download = 'shiftsafe-handover-report.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); return;
    }
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
