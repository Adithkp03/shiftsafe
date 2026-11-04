// Best-effort failed-login throttle. In-memory per server instance: on serverless hosts each instance has its own
// counters, so this slows guessing but is not a global limit. Memory is bounded by `cap` keys.
export function createThrottle({ max = 10, windowMs = 10 * 60 * 1000, cap = 5000 } = {}) {
  const fails = new Map(); // key -> { n, reset }
  const live = (k, now) => { const e = fails.get(k); if (!e || e.reset <= now) { fails.delete(k); return null; } return e; };
  return {
    blocked(key, now = Date.now()) { const e = live(key, now); return !!e && e.n >= max; },
    fail(key, now = Date.now()) {
      if (!live(key, now) && fails.size >= cap) fails.delete(fails.keys().next().value);
      const e = live(key, now) || { n: 0, reset: now + windowMs }; e.n += 1; fails.set(key, e); return e.n;
    },
    ok(key) { fails.delete(key); },
    size: () => fails.size,
  };
}
export const clientKey = (req) => String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim().slice(0, 64);
