#!/usr/bin/env node
// bin/bake-prices.mjs — write catalog prices into a static site's HTML when you run it.
//
// WHAT THIS DOES
//   Reads a catalog feed in a simplified menu-feed shape (a demo fixture — NOT the Square
//   Catalog API; a real POS needs an adapter to this shape), then rewrites the price on
//   every matched product node so the number a crawler sees is the number in the feed —
//   with NO database and NO price fetch at request time. A snapshot JSON is written
//   alongside for the offline consistency check. See README.md, incl. "Known limits".
//
// WHERE IT RUNS — when you run it, on your machine. NOT at deploy.
//   Baking at deploy would make every deploy depend on the POS being reachable, and would
//   diverge from whatever integrity gate seals your release. So: run this locally, commit
//   the regenerated tree + snapshot, and let the offline parity gate (test/parity.test.js)
//   prove — with no network — that visible price == JSON-LD price == snapshot for every id.
//
// KEYING — catalog item id, NEVER display name. This is the whole point.
//   Two menu items can share a display name and cost different amounts (a lunch/dinner
//   twin: "House Salad" is $12 at lunch and $16 at dinner — two distinct catalog objects).
//   A name-keyed map is last-wins: it silently overwrites the correct price with the other
//   twin's. So every price node is anchored to a stable catalog id:
//       visible HTML  ->  data-sq-item="<id>"
//       JSON-LD       ->  "identifier": "<id>"
//   Once anchored, a node is looked up BY THAT ID forever (unambiguous). The name resolver
//   below is used ONLY to attach an anchor to a still-unanchored node (first run / a newly
//   hand-added row) — and it FAILS CLOSED on any ambiguity rather than guessing.
//
// FAIL-CLOSED
//   Empty/malformed catalog, a feed id that is not a catalog id (it would be written into
//   HTML), a feed price toFixed(2) cannot render faithfully, one id with two prices, an
//   anchored id missing from the catalog, an unanchored node that resolves to more than one
//   candidate, an anchor attribute or JSON-LD shape the text transforms cannot handle
//   safely, a symlink under --site -> exit 1, write nothing. Every file is baked in memory
//   first and written only after the whole site has baked cleanly; each file is then
//   replaced atomically (temp + fsync + rename). README "Writes and recovery" has the limits.
//
// INPUT CHECKS (lib/guards.mjs)
//   --src as a URL must be https:, carry no credentials, and resolve only to public
//   addresses — checked before the fetch and again at connect time. Redirects are refused.
//   The snapshot records a URL source as origin + path only.
//
// USAGE
//   node bin/bake-prices.mjs --check                 # no write; exit 1 if anything would change (CI)
//   node bin/bake-prices.mjs --write                 # rewrite the site in place, emit the snapshot
//   node bin/bake-prices.mjs --check --src <file|url># read the catalog from a file or https: URL
//   node bin/bake-prices.mjs --write --site <dir> --snapshot <file>
//   node bin/bake-prices.mjs --check --strict        # also exit 1 on price-like markup it cannot read
//
//   Defaults are the bundled demo, so a bare `--check` / `--write` runs credential-free with
//   no arguments and no network. Point --src at your own catalog to use it for real.
//   --site is read recursively (every .html under it, subfolders included).

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  validateFeedId, validateFeedPrice, flagValue, UsageError, isUrlSource, checkSourceUrl, snapshotSource,
  assertPublicHost, guardedLookup, responseError, readBodyBounded, writeFileAtomic, listHtml,
  parsePriceText, formatPrice,
} from '../lib/guards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SRC      = path.join(ROOT, 'demo', 'catalog.json');
const DEFAULT_SITE     = path.join(ROOT, 'demo', 'site');
const DEFAULT_SNAPSHOT = path.join(ROOT, 'demo', 'prices.snapshot.json');

const die   = msg => { console.error('bake-prices FAIL: ' + msg); process.exit(1); };
const usage = msg => { console.error('bake-prices: ' + msg); process.exit(2); };

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = f => args.includes(f);
const MODE_CHECK = has('--check');
const MODE_WRITE = has('--write');
const STRICT     = has('--strict');   // unread price-like markup is an error, not a warning
if (MODE_CHECK === MODE_WRITE) usage('pass exactly one of --check (no write) or --write. See the header.');
let SRC, SITE, SNAPSHOT;
try {
  SRC      = flagValue(args, '--src', DEFAULT_SRC);
  SITE     = flagValue(args, '--site', DEFAULT_SITE);
  SNAPSHOT = flagValue(args, '--snapshot', DEFAULT_SNAPSHOT);
} catch (e) {
  if (e instanceof UsageError) usage(e.message);
  throw e;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const isId  = s => /^[A-Z0-9]{20,}$/.test(s);          // catalog id shape (opaque, uppercase)
const nkey  = s => String(s).toLowerCase().trim().replace(/\s+/g, ' ');
const money = n => n.toFixed(2);

// ── catalog ──────────────────────────────────────────────────────────────────
// Fetch over https only, through the connect-time address check, refusing redirects.
// Two clocks: a 15 s idle timeout on the socket, and a 30 s hard deadline for the whole
// exchange (an idle timeout alone lets a server that drips one byte at a time run forever).
// The body is read through readBodyBounded, so it can never be buffered without limit.
const FETCH_IDLE_MS = 15000, FETCH_DEADLINE_MS = 30000;
function fetchJson(u) {
  return new Promise((resolve, reject) => {
    const req = https.get(u, { lookup: guardedLookup(), agent: false, headers: { accept: 'application/json' } }, res => {
      const err = responseError(res.statusCode, res.headers.location);
      if (err) { res.resume(); return reject(err); }
      readBodyBounded(res).then(text => {
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`catalog is not valid JSON: ${e.message}`)); }
      }, reject);
    });
    const deadline = setTimeout(() => req.destroy(new Error(`exceeded the ${FETCH_DEADLINE_MS / 1000} s deadline`)), FETCH_DEADLINE_MS);
    req.setTimeout(FETCH_IDLE_MS, () => req.destroy(new Error(`idle for ${FETCH_IDLE_MS / 1000} s`)));
    req.on('error', reject);
    req.on('close', () => clearTimeout(deadline));
  });
}

// Catalog shape (the demo fixture's simplified menu-feed format; not a vendor API):
//   { cachedAt?: string, menu: [ { name: <section>, items: [ { id, name, price:Number } ] } ] }
async function loadCatalog(src) {
  let raw, label;
  if (isUrlSource(src)) {
    let u;
    try { u = checkSourceUrl(src); } catch (e) { die(e.message); }
    label = snapshotSource(u);
    try { await assertPublicHost(u.hostname); } catch (e) { die(e.message); }
    try { raw = await fetchJson(u); } catch (e) { die(`catalog fetch failed (${label}): ${e.message}`); }
  } else {
    label = src === DEFAULT_SRC ? 'demo/catalog.json' : src;
    let text;
    try { text = fs.readFileSync(src, 'utf8'); } catch (e) { die(`cannot read --src ${src}: ${e.message}`); }
    try { raw = JSON.parse(text); } catch (e) { die(`catalog is not valid JSON (${label}): ${e.message}`); }
  }
  if (!raw || !Array.isArray(raw.menu) || raw.menu.length === 0) die('catalog empty or malformed (no menu[])');

  const byId = new Map();       // id -> { id, name, price, cat }
  const byName = new Map();     // nkey(name) -> [ rec, ... ]
  const sections = new Map();   // lower(section) -> exact section name (for the section tie-break)
  for (const cat of raw.menu) {
    if (cat && cat.name) sections.set(nkey(cat.name), cat.name);
    for (const it of (cat.items || [])) {
      if (typeof it.price !== 'number' || !it.id) continue;   // variable-priced / malformed -> skip
      try { validateFeedId(it.id, it.name); validateFeedPrice(it.price, it.id); } catch (e) { die(e.message); }
      const rec = { id: it.id, name: it.name, price: it.price, cat: cat.name };
      // One id, one price. The same id listed twice with identical name+price (an item
      // shown under two sections) is one record; the same id with a different price or
      // name is a feed defect — last-wins would bake one price into the HTML and write the
      // other into the snapshot, so refuse it.
      const prev = byId.get(it.id);
      if (prev) {
        if (prev.price !== rec.price || nkey(prev.name) !== nkey(rec.name)) {
          die(`feed id ${it.id} appears more than once with different data: `
            + `"${prev.name}" $${money(prev.price)} (${prev.cat}) vs "${rec.name}" $${money(rec.price)} (${rec.cat})`);
        }
        continue;
      }
      byId.set(it.id, rec);
      const k = nkey(it.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(rec);
    }
  }
  return { byId, byName, sections, cachedAt: raw.cachedAt || null, label };
}

// Resolve an UNANCHORED node to a catalog record. Throws on ambiguity (fail-closed).
// Returns null when the node is not an orderable catalog item (leave it alone).
function resolveUnanchored(cat, name, price, section) {
  const cands = cat.byName.get(nkey(name));
  if (!cands) return null;                                     // not in catalog -> leave alone
  if (cands.length === 1) return cands[0];
  const byPrice = cands.filter(c => Math.abs(c.price - price) < 0.001);
  if (byPrice.length === 1) return byPrice[0];                 // tie-break 1: the price on the page today
  if (section) {
    const exact = cat.sections.get(nkey(section));
    if (exact) {
      const bySec = cands.filter(c => c.cat === exact);
      if (bySec.length === 1) return bySec[0];                 // tie-break 2: the section it sits in
    }
  }
  die(`ambiguous node "${name}" @ $${money(price)} (section=${section || '?'}) — ${cands.length} candidates: `
    + cands.map(c => `${c.cat}/$${money(c.price)}`).join(', '));
}

// Look up an anchored id; fail-closed if the catalog no longer has it.
function priceForId(cat, id, where) {
  const rec = cat.byId.get(id);
  if (!rec) die(`anchored id ${id} (${where}) is not in the catalog — item removed or renamed in the POS?`);
  return rec.price;
}

// ── transforms ───────────────────────────────────────────────────────────────
// Each transform returns the new HTML and records every touched id into `seen`.

// VISIBLE price nodes, section-aware. Ensures data-sq-item="<id>" and the correct price,
// preserving the surrounding markup byte-for-byte when nothing needs to change. A price
// written with a thousands separator ($1,000.00) is read, and written back with one.
const RE_VISIBLE = /(<h2 class="cat-title">([^<]+)<\/h2>)|((<h3 class="item-name"[^>]*>([^<]+)<\/h3>)(\s*)<div class="item-price"([^>]*)>\$([0-9]{1,3}(?:,[0-9]{3})+\.[0-9]{2}|[0-9]+\.[0-9]{2})<\/div>)/g;
function tVisible(html, cat, seen) {
  let section = null;
  return html.replace(RE_VISIBLE, (m, h2, secName, _blk, h3, name, gap, attrs, price) => {
    if (h2) { section = secName.trim(); return m; }
    const cur = parsePriceText(price);
    const anchors = attrs.match(/data-sq-item\b/g) || [];
    const exact = attrs.match(/data-sq-item="([^"]*)"/g) || [];
    // A node that carries data-sq-item in a form other than exactly data-sq-item="…" (single
    // quotes, unquoted, or twice) would end up with two anchors, and the browser keeps the
    // FIRST — not the one this run wrote. Refuse rather than emit it.
    if (anchors.length !== exact.length || anchors.length > 1) {
      die(`visible "${name}": data-sq-item must appear exactly once as data-sq-item="…" (got: ${attrs.trim()})`);
    }
    let id = (attrs.match(/data-sq-item="([^"]+)"/) || [])[1];
    let rec;
    if (id && isId(id)) { rec = { id, price: priceForId(cat, id, `visible "${name}"`) }; }
    else {
      rec = resolveUnanchored(cat, name, cur, section);
      if (!rec) return m;                                      // leave-alone node
    }
    seen.add(rec.id);
    const newAttrs = /data-sq-item="/.test(attrs)
      ? attrs.replace(/data-sq-item="[^"]*"/, `data-sq-item="${rec.id}"`)
      : `${attrs} data-sq-item="${rec.id}"`;
    return `${h3}${gap}<div class="item-price"${newAttrs}>$${formatPrice(rec.price, price.includes(','))}</div>`;
  });
}

// JSON-LD MenuItems (pretty OR minified). Ensures "identifier":"<id>" and offers.price.
// Bounded so one item's span can never bleed into the next MenuItem.
const RE_JSONLD = /("@type":\s*"MenuItem"\s*,\s*)((?:"@id":\s*"[^"]*"\s*,\s*)?)("name":\s*")([^"]+)(")((?:(?!"@type":\s*"MenuItem")[\s\S])*?)("price":\s*")([0-9]+\.[0-9]{2})(")/g;
function tJsonLd(html, cat, seen) {
  return html.replace(RE_JSONLD, (m, head, atId, nOpen, name, nClose, mid, pOpen, price, pClose) => {
    const cur = parseFloat(price);
    let id = (m.match(/"identifier":\s*"([^"]+)"/) || [])[1];
    let rec;
    if (id && isId(id)) { rec = { id, price: priceForId(cat, id, `JSON-LD "${name}"`) }; }
    else {
      rec = resolveUnanchored(cat, name, cur, null);           // JSON-LD has no section; price tie-break suffices
      if (!rec) return m;                                      // leave-alone node
    }
    seen.add(rec.id);
    const pretty = /\n/.test(mid) || /\n/.test(head);
    let out = head + atId + nOpen + name + nClose;
    if (/"identifier":/.test(m)) {
      out += mid.replace(/"identifier":\s*"[^"]*"/, `"identifier": "${rec.id}"`);
    } else if (pretty) {
      const indent = (mid.match(/\n(\s*)"/) || [, '        '])[1];
      out += `,\n${indent}"identifier": "${rec.id}"` + mid;
    } else {
      out += `, "identifier": "${rec.id}"` + mid;
    }
    out += pOpen + money(rec.price) + pClose;
    return out;
  });
}

// JSON-LD structure the regex transform above relies on. RE_JSONLD rewrites a MenuItem by
// text, so three shapes it cannot handle safely are refused before anything is written:
//   1. a MenuItem whose "identifier" comes AFTER its offers.price — the transform would not
//      see it and would insert a second "identifier" key (a duplicate key; parsers keep the
//      last one, i.e. the stale one);
//   2. MenuItem text that is not inside a <script type="application/ld+json"> block (an
//      HTML comment, a <pre> code sample) — it is not structured data and must not be baked;
//   3. an ld+json block that contains MenuItem text but is not valid JSON — the regex would
//      still rewrite inside it, and nothing would parse the result.
const RE_LDJSON_BLOCK = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
const RE_MENUITEM = /"@type":\s*"MenuItem"/g;
function checkJsonLdStructure(html, f) {
  const blocks = [];
  let b;
  while ((b = RE_LDJSON_BLOCK.exec(html))) blocks.push({ start: b.index, end: b.index + b[0].length, text: b[1] });
  let m;
  while ((m = RE_MENUITEM.exec(html))) {
    const line = html.slice(0, m.index).split('\n').length;
    if (!blocks.some(k => m.index >= k.start && m.index < k.end)) {
      die(`${f}:${line}: MenuItem markup outside a <script type="application/ld+json"> block — not structured data; refusing to bake it`);
    }
  }
  for (const k of blocks) {
    if (!/"@type":\s*"MenuItem"/.test(k.text)) continue;
    let doc;
    try { doc = JSON.parse(k.text); }
    catch (e) { die(`${f}: a JSON-LD block containing MenuItem is not valid JSON (${e.message})`); }
    const walk = node => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      if (node['@type'] === 'MenuItem') {
        const keys = Object.keys(node);
        const iId = keys.indexOf('identifier'), iOff = keys.indexOf('offers');
        if (iId > -1 && iOff > -1 && iId > iOff) {
          die(`${f}: MenuItem "${node.name}" lists "identifier" after "offers" — the baker reads "identifier" before the price; move it above "offers"`);
        }
      }
      Object.values(node).forEach(walk);
    };
    walk(doc);
  }
}

// Price-like markup the transforms above did not read: a "$<digit>" outside a visible price
// node, or a "price": key outside a JSON-LD MenuItem. Reported as file:line; never fails.
function unreadPrices(html) {
  const blank = s => s.replace(/[^\n]/g, ' ');
  let masked = html.replace(RE_VISIBLE, blank).replace(RE_JSONLD, blank);
  const hits = [];
  for (const re of [/\$\s*[0-9]/g, /"price"\s*:/g]) {
    let m;
    while ((m = re.exec(masked))) hits.push(masked.slice(0, m.index).split('\n').length);
  }
  return [...new Set(hits)].sort((a, b) => a - b);
}

// ── main ─────────────────────────────────────────────────────────────────────
const cat = await loadCatalog(SRC);
const seen = new Set();

let htmlFiles;
try { htmlFiles = listHtml(SITE); } catch (e) { die(`--site ${SITE}: ${e.message}`); }
if (htmlFiles.length === 0) die(`no .html files found in site dir: ${SITE}`);

// Bake every file in memory first; a die() part-way leaves every file untouched.
const pending = [];
let unread = 0;
for (const f of htmlFiles) {
  const p = path.join(SITE, f);
  const before = fs.readFileSync(p, 'utf8');
  checkJsonLdStructure(before, f);
  let after = before;
  after = tVisible(after, cat, seen);
  after = tJsonLd(after, cat, seen);
  for (const line of unreadPrices(after)) {
    unread++;
    console.error(`bake-prices ${STRICT ? 'FAIL' : 'WARN'}: ${f}:${line}: price-like markup the baker cannot read — ${STRICT ? 'refused (--strict)' : 'left as is'}`);
  }
  if (after !== before) pending.push({ f, p, after });
}
if (STRICT && unread) die(`${unread} price-like node(s) the baker cannot read; nothing written. Anchor them or drop --strict.`);
const changedFiles = pending.map(x => x.f);

// snapshot: sorted { id: { name, price } } — input to the offline consistency check
const snap = {};
for (const id of [...seen].sort()) { const r = cat.byId.get(id); snap[id] = { name: r.name, price: r.price }; }
const snapText = JSON.stringify({ source: cat.label, cachedAt: cat.cachedAt, items: snap }, null, 2) + '\n';
const snapBefore = fs.existsSync(SNAPSHOT) ? fs.readFileSync(SNAPSHOT, 'utf8') : '';
const snapChanged = snapText !== snapBefore;

if (MODE_WRITE) {
  // Each file is replaced atomically (temp + fsync + rename). The set of files is NOT
  // atomic as a whole: the committed tree is the unit of rollback (git checkout -- <site>).
  try {
    for (const { p, after } of pending) writeFileAtomic(p, after);   // repo is LF; Node writes \n as-is
    if (snapChanged) writeFileAtomic(SNAPSHOT, snapText);
  } catch (e) { die(`write failed: ${e.message} — restore with git checkout, fix the cause, re-run --write`); }
}

console.log(`bake-prices: source=${cat.label}`);
console.log(`bake-prices: catalog items=${cat.byId.size} anchored=${seen.size}`);
console.log(`bake-prices: files ${MODE_WRITE ? 'written' : 'that would change'}: ${changedFiles.length ? changedFiles.join(', ') : '(none)'}`);
console.log(`bake-prices: snapshot ${snapChanged ? (MODE_WRITE ? 'written' : 'would change') : 'unchanged'}`);

if (MODE_CHECK && (changedFiles.length || snapChanged)) {
  console.error('bake-prices --check: the committed tree is NOT in sync with the catalog. Run --write, then commit.');
  process.exit(1);
}
