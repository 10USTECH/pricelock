#!/usr/bin/env node
// bin/check-parity.mjs — run the offline consistency check on YOUR site and YOUR snapshot.
//
//   node bin/check-parity.mjs --site <dir> --snapshot <file> [--site-wide]
//
// Both paths are required. There is no default: `node --test` in this repo proves the demo
// tree, and a green run there says nothing about any other site. This command prints the
// real paths it verified, so a CI log shows which tree a pass belongs to.
//
// Checks (lib/parity.mjs has the full list): every anchored visible price and every
// identified JSON-LD MenuItem equals the snapshot (price and currency); every snapshot id is
// on both surfaces; and, per page, the ids a page shows are exactly the ids its JSON-LD
// describes. --site-wide drops that last rule only.
//
// Read-only. No catalog, no network. It does NOT prove the snapshot matches the catalog —
// run `bake-prices --check --src <catalog>` for that. A pipeline needs both, blocking.
//
// Exit: 0 consistent · 1 not consistent, or an input that cannot be checked · 2 usage.

import process from 'node:process';
import { flagValue, UsageError } from '../lib/guards.mjs';
import { checkParity } from '../lib/parity.mjs';

const usage = msg => {
  console.error(`check-parity: ${msg}`);
  console.error('usage: check-parity --site <dir> --snapshot <file> [--site-wide]   (both paths are required; there is no default site)');
  process.exit(2);
};

const args = process.argv.slice(2);
const KNOWN = new Set(['--site', '--snapshot', '--site-wide']);
let site, snapshot;
try {
  site = flagValue(args, '--site', null);
  snapshot = flagValue(args, '--snapshot', null);
} catch (e) { if (e instanceof UsageError) usage(e.message); throw e; }
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--site' || args[i] === '--snapshot') { i++; continue; }
  if (!KNOWN.has(args[i])) usage(`unknown argument ${JSON.stringify(args[i])}`);
}
if (site === null || snapshot === null) usage(`${[site === null && '--site', snapshot === null && '--snapshot'].filter(Boolean).join(' and ')} required`);

const r = checkParity({ site, snapshot, siteWide: args.includes('--site-wide') });
console.log(`check-parity: site=${r.site}`);
console.log(`check-parity: snapshot=${r.snapshot}`);
console.log(`check-parity: pages=${r.pages} ids=${r.ids} visible=${r.visible} jsonld=${r.jsonld} mode=${r.mode}`);
if (!r.ok) {
  for (const e of r.errors) console.error(`check-parity FAIL: ${e}`);
  console.error(`check-parity: ${r.errors.length} failure(s) — this tree is NOT consistent with its snapshot.`);
  process.exit(1);
}
console.log('check-parity: OK — visible == JSON-LD == snapshot for every id on this tree. Consistency only: run bake-prices --check against the catalog to tie it to the source.');
