#!/usr/bin/env node
// Cut a person's live access. Needs NEXCONN_APP_KEY and NEXCONN_APP_SECRET in the environment.
// node scripts/revoke-user.mjs --user-id outp1a2b3c4d5e6f --ward wardx
// Afterwards add the key id (printed by issue-credential.mjs) to SS_REVOKED and redeploy.
import { revokeUser } from '../server/nexconn.mjs';
const a = Object.fromEntries(process.argv.slice(2).reduce((r, x, i, all) => (x.startsWith('--') ? [...r, [x.slice(2), all[i + 1]]] : r), []));
try {
  const r = await revokeUser({ baseUrl: process.env.NEXCONN_BASE_URL || 'https://api.sg-light-api.com', appKey: process.env.NEXCONN_APP_KEY, appSecret: process.env.NEXCONN_APP_SECRET, userId: a['user-id'], wardId: a.ward });
  console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1);
} catch (e) { console.error('error: ' + e.message); process.exit(1); }
