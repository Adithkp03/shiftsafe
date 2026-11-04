// Vercel function: tells the client which mode it is in. Live mode only (no in-memory mock relay on serverless).
export default function handler(req, res) {
  const live = Boolean(process.env.NEXCONN_APP_KEY && process.env.NEXCONN_APP_SECRET);
  res.status(200).json({ mode: live ? 'nexconn' : 'unconfigured', appKey: live ? process.env.NEXCONN_APP_KEY : null });
}
