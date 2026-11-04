#!/usr/bin/env node
// Issue one personal access key. Prints it once; it is not stored anywhere.
// SS_SIGNING_KEY=<32+ chars> node scripts/issue-credential.mjs --name Priya --role out --ward wardx [--days 14]
// A key's id (jti) is printed to stderr so it can be revoked later through SS_REVOKED.
import { signCredential } from '../server/auth.mjs';
const a = Object.fromEntries(process.argv.slice(2).reduce((r, x, i, all) => (x.startsWith('--') ? [...r, [x.slice(2), all[i + 1]]] : r), []));
try {
  const { credential, payload } = signCredential({ key: process.env.SS_SIGNING_KEY, name: a.name, role: a.role, ward: a.ward, days: a.days ? Number(a.days) : 14 });
  process.stderr.write(`issued for ${payload.name} (${payload.role}, ward ${payload.ward}) jti=${payload.jti} expires ${new Date(payload.exp).toISOString()}\n`);
  console.log(credential);
} catch (e) { console.error('error: ' + e.message); process.exit(1); }
