// Transport abstraction. 'nexconn' uses the Nexconn Chat SDK (group channel + custom messages).
// 'mock' uses the local relay in server/app.mjs so the product runs without credentials.
const WARD_ID = 'ward1';
const TYPES = ['SS:card', 'SS:ack', 'SS:task-done'];

export async function createTransport(session) {
  return session.mode === 'nexconn' ? nexconnTransport(session) : mockTransport(session);
}

async function mockTransport(session) {
  const handlers = new Set();
  const es = new EventSource(`/api/mock/events?user=${encodeURIComponent(session.userId)}`);
  es.onmessage = (e) => { const m = JSON.parse(e.data); handlers.forEach((h) => h([m])); };
  return {
    mode: 'mock',
    onMessages: (h) => handlers.add(h),
    async history() { return (await (await fetch('/api/mock/history')).json()); },
    async send(payload) {
      await fetch('/api/mock/send', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: session.userId, payload }) });
    },
  };
}

async function nexconnTransport(session) {
  const { NCEngine, AreaCode, GroupChannel, GroupJoinPermission, SendMessageParams, BaseChannel, MessageHandler } = await import('@nexconn/chat');
  NCEngine.registerCustomMessages(TYPES.map((messageType) => ({ messageType, isPersited: true, isCounted: true })));
  NCEngine.initialize({ appKey: session.appKey, areaCode: AreaCode.SG });
  const handlers = new Set();
  const toMsg = (m) => ({ id: m.messageId ?? m.messageUId, userId: m.senderUserId, ts: m.sentTime, payload: m.content });
  NCEngine.addMessageHandler('shiftsafe', new MessageHandler({
    onMessageReceived({ messages }) {
      const mine = messages.filter((m) => TYPES.includes(m.messageType)).map(toMsg);
      if (mine.length) handlers.forEach((h) => h(mine));
    },
  }));
  const conn = await NCEngine.connect({ token: session.token });
  if (!conn.isOk) throw new Error(`Nexconn connect failed (code ${conn.code})`);
  // Create the ward group once; if it already exists, join it.
  await GroupChannel.createGroup({ groupId: WARD_ID, groupName: 'Ward 1 (synthetic)', joinPermission: GroupJoinPermission.FREE }).catch(() => {});
  const group = new GroupChannel(WARD_ID);
  await group.join().catch(() => {});
  return {
    mode: 'nexconn',
    onMessages: (h) => handlers.add(h),
    async history() {
      const q = BaseChannel.createMessagesQuery({ channelIdentifier: group.identifier, startTime: Date.now(), pageSize: 100, isAscending: false });
      const { code, data } = await q.loadNextPage();
      if (code !== 0) return [];
      return data.data.filter((m) => TYPES.includes(m.messageType)).map(toMsg).reverse();
    },
    async send(payload) {
      const r = await group.sendMessage(new SendMessageParams(payload, payload.type));
      if (r.code !== 0) throw new Error(`send failed (code ${r.code})`);
    },
  };
}
