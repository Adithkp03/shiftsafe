// Transport abstraction. 'nexconn' uses the Nexconn Chat SDK (group channel + custom messages).
// 'mock' uses the local relay in server/app.mjs so the product runs without credentials.
const TYPES = ['SS:card', 'SS:ack', 'SS:task-done'];

export async function createTransport(session) {
  return session.mode === 'nexconn' ? nexconnTransport(session) : mockTransport(session);
}

async function mockTransport(session) {
  const handlers = new Set(); const statusH = new Set(); const status = (x) => statusH.forEach((h) => h(x));
  const es = new EventSource(`/api/mock/events?s=${encodeURIComponent(session.sessionToken)}`);
  es.onopen = () => status('online'); es.onerror = () => status('offline');
  es.onmessage = (e) => { const m = JSON.parse(e.data); handlers.forEach((h) => h([m])); };
  return {
    mode: 'mock',
    onMessages: (h) => handlers.add(h),
    onStatus: (h) => statusH.add(h),
    async history() { const r = await fetch('/api/mock/history', { headers: { 'x-session': session.sessionToken } }); if (!r.ok) throw new Error('history failed'); return r.json(); },
    async send(payload) {
      const r = await fetch('/api/mock/send', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session': session.sessionToken }, body: JSON.stringify({ payload }) });
      if (!r.ok) throw new Error('send failed');
    },
  };
}

async function nexconnTransport(session) {
  const { NCEngine, AreaCode, GroupChannel, SendMessageParams, BaseChannel, MessageHandler, ConnectionStatusHandler } = await import('@nexconn/chat');
  NCEngine.registerCustomMessages(TYPES.map((messageType) => ({ messageType, isPersisted: true, isPersited: true, isCounted: true })));
  NCEngine.initialize({ appKey: session.appKey, areaCode: AreaCode.SG });
  const handlers = new Set(); const statusH = new Set();
  NCEngine.addConnectionStatusHandler('shiftsafe-conn', new ConnectionStatusHandler({ onConnectionStatusChanged({ status }) { statusH.forEach((h) => h(String(status).toLowerCase().includes('connected') && !String(status).toLowerCase().includes('dis') ? 'online' : 'offline')); } }));
  const toMsg = (m) => ({ id: m.messageId, userId: m.senderUserId, ts: m.sentTime, payload: m.content });
  NCEngine.addMessageHandler('shiftsafe', new MessageHandler({
    onMessageReceived({ messages }) {
      const mine = messages.filter((m) => TYPES.includes(m.messageType) && m.channelIdentifier?.channelId === session.groupId).map(toMsg);
      if (mine.length) handlers.forEach((h) => h(mine));
    },
  }));
  const conn = await NCEngine.connect({ token: session.token });
  if (!conn.isOk) throw new Error(`Nexconn connect failed (code ${conn.code})`);
  // Membership is enforced by the server (it adds this user to the ward group after checking the invite).
  const group = new GroupChannel(session.groupId);
  return {
    mode: 'nexconn',
    onMessages: (h) => handlers.add(h),
    onStatus: (h) => statusH.add(h),
    async history() {
      const q = BaseChannel.createMessagesQuery({ channelIdentifier: group.identifier, startTime: Date.now(), pageSize: 100, isAscending: false });
      const { code, data: page } = await q.loadNextPage();
      if (code !== 0 || !page) return [];
      return page.data.filter((m) => TYPES.includes(m.messageType)).map(toMsg).reverse();
    },
    async send(payload) {
      const r = await group.sendMessage(new SendMessageParams(payload, payload.type));
      if (r.code !== 0) throw new Error(`send failed (code ${r.code})`);
    },
  };
}
