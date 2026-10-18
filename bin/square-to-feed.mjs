#!/usr/bin/env node
// bin/square-to-feed.mjs — read a Square location's catalog and write the v2 menu feed.
//
//   SQUARE_ACCESS_TOKEN=… node bin/square-to-feed.mjs --location <LOCATION_ID> --out my-catalog.json
//   node bin/square-to-feed.mjs --location <LOCATION_ID> --input saved-response.json --out my-catalog.json
//
// The token comes from the environment only — never a flag, never a file in the repo —
// and is never printed. With --input, nothing is fetched: the file is one or more saved
// POST /v2/catalog/search responses (an object, or an array of them), and this run is
// fully offline. That is how the adapter is tested, and how you can review exactly what
// Square returned before any price reaches a page.
//
// Network boundary (the only outbound call this repo makes besides --src):
//   host      connect.squareup.com, or connect.squareupsandbox.com with --sandbox — fixed,
//             not configurable: this is an allowlist, not a validator
//   request   POST /v2/catalog/search, object_types ITEM + CATEGORY, paginated by cursor
//   limits    15 s idle, 60 s hard deadline per page, 8 MiB per page body, redirects refused
//
// Then: node bin/bake-prices.mjs --check --src my-catalog.json --site … --snapshot …

import fs from 'node:fs';
import https from 'node:https';
import process from 'node:process';
import { flagValue, UsageError, readBodyBounded, responseError, writeFileAtomic } from '../lib/guards.mjs';
import { squareToFeed } from '../lib/square.mjs';

const die   = msg => { console.error('square-to-feed FAIL: ' + msg); process.exit(1); };
const usage = msg => { console.error('square-to-feed: ' + msg); process.exit(2); };

const args = process.argv.slice(2);
let LOCATION, INPUT, OUT;
try {
  LOCATION = flagValue(args, '--location', null);
  INPUT    = flagValue(args, '--input', null);
  OUT      = flagValue(args, '--out', null);
} catch (e) { if (e instanceof UsageError) usage(e.message); throw e; }
if (!LOCATION) usage('--location <SQUARE_LOCATION_ID> is required');
if (!/^[A-Z0-9]{8,}$/.test(LOCATION)) usage('--location does not look like a Square location id');
const SANDBOX = args.includes('--sandbox');
const HOST = SANDBOX ? 'connect.squareupsandbox.com' : 'connect.squareup.com';
// A released API version. Override with SQUARE_VERSION if Square retires this one.
const SQUARE_VERSION = process.env.SQUARE_VERSION || '2025-01-23';
const IDLE_MS = 15000, DEADLINE_MS = 60000, MAX_PAGES = 200;

function postJson(path, token, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request({
      host: HOST, path, method: 'POST', agent: false,
      headers: {
        'content-type': 'application/json', 'content-length': data.length, accept: 'application/json',
        'square-version': SQUARE_VERSION, authorization: `Bearer ${token}`,
      },
    }, res => {
      const err = responseError(res.statusCode, res.headers.location);
      if (err) {
        // Read a bounded slice of the error body for the message; never echo headers.
        readBodyBounded(res, 64 * 1024).then(t => {
          let detail = '';
          try { detail = (JSON.parse(t).errors || []).map(e => `${e.category}/${e.code}: ${e.detail || ''}`).join('; '); } catch { /* not JSON */ }
          reject(new Error(`${err.message}${detail ? ` — ${detail}` : ''}`));
        }, () => reject(err));
        return;
      }
      readBodyBounded(res).then(text => {
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(`response is not valid JSON: ${e.message}`)); }
      }, reject);
    });
    const deadline = setTimeout(() => req.destroy(new Error(`exceeded the ${DEADLINE_MS / 1000} s deadline`)), DEADLINE_MS);
    req.setTimeout(IDLE_MS, () => req.destroy(new Error(`idle for ${IDLE_MS / 1000} s`)));
    req.on('error', reject);
    req.on('close', () => clearTimeout(deadline));
    req.end(data);
  });
}

async function fetchAllPages(token) {
  const pages = [];
  let cursor;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await postJson('/v2/catalog/search', token, {
      object_types: ['ITEM', 'CATEGORY'], include_deleted_objects: false, limit: 1000, ...(cursor ? { cursor } : {}),
    });
    pages.push(page);
    if (!page.cursor) return pages;
    cursor = page.cursor;
  }
  throw new Error(`more than ${MAX_PAGES} catalog pages — refusing to continue`);
}

let pages;
if (INPUT) {
  let text;
  try { text = fs.readFileSync(INPUT, 'utf8'); } catch (e) { die(`cannot read --input ${INPUT}: ${e.message}`); }
  try { pages = JSON.parse(text); } catch (e) { die(`--input is not valid JSON: ${e.message}`); }
} else {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) die('SQUARE_ACCESS_TOKEN is not set (env only; never a flag). Or pass --input <saved-response.json> to run offline.');
  try { pages = await fetchAllPages(token); } catch (e) { die(`Square catalog fetch failed (${HOST}): ${e.message}`); }
}

let result;
try { result = squareToFeed(pages, { locationId: LOCATION }); } catch (e) { die(e.message); }
const { feed, skipped } = result;

for (const s of skipped) console.error(`square-to-feed SKIP: ${s.id} "${s.name}" — ${s.why}`);
const priced = feed.menu.reduce((n, sec) => n + sec.items.filter(i => Number.isInteger(i.amountMinor)).length, 0);
const variable = feed.menu.reduce((n, sec) => n + sec.items.filter(i => i.pricing === 'VARIABLE').length, 0);
console.error(`square-to-feed: location=${LOCATION} sections=${feed.menu.length} priced=${priced} variable=${variable} skipped=${skipped.length}`);
if (priced === 0) die('no fixed-priced variations at this location — nothing to bake; is --location right?');

const text = JSON.stringify(feed, null, 2) + '\n';
if (OUT) { try { writeFileAtomic(OUT, text); } catch (e) { die(`cannot write --out ${OUT}: ${e.message}`); } console.error(`square-to-feed: wrote ${OUT}`); }
else process.stdout.write(text);
