#!/usr/bin/env node
// bin/bake-prices.mjs — write catalog prices into a static site's HTML when you run it.
//
// WHAT THIS DOES
//   Reads a catalog feed in a simplified menu-feed shape (bin/square-to-feed.mjs produces it
//   from a Square location; other POS systems need an adapter), then rewrites the price on
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
//   candidate, an anchor attribute the visible transform cannot handle safely, a JSON-LD
//   block with a duplicate key or a managed offer that is not one Offer with a "price"
//   string, a symlinked file or directory under --site -> exit 1, write nothing. Every file is baked in memory
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
//   node bin/bake-prices.mjs --check --allow-unread  # downgrade unread price-like markup to a WARN
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
  validateFeedId, validateFeedPrice, validateAmountMinor, validateCurrency, dollarsToCents,
  flagValue, UsageError, isUrlSource, checkSourceUrl, snapshotSource,
  assertPublicHost, guardedLookup, responseError, readBodyBounded, writeFileAtomic, listHtml,
  centsToText, textToCents, formatPrice,
} from '../lib/guards.mjs';
import { parseStrict, objects, hasType, singleOffer, ldBlocks, PRICE_KEYS, looksLikeMenuItem, looksLikePrice } from '../lib/jsonld.mjs';

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
// Unread price-like markup is an error unless --allow-unread downgrades it to a warning.
// (--strict is accepted for compatibility; it is the default.)
const STRICT     = !has('--allow-unread');
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
const money = centsToText;                              // integer cents -> "12.00"; the only formatter

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

// Catalog shape (a simplified menu feed; not a vendor API). Two versions are read:
//   v2 (schemaVersion: 2) { cachedAt?, locationId?, currency: "USD",
//                           menu: [ { name: <section>, items: [ { id, name, amountMinor: Integer } ] } ] }
//   v1 (no schemaVersion)  { cachedAt?, menu: [ { name, items: [ { id, name, price: Number } ] } ] }
// Prices become integer cents at load; nothing downstream sees a float. An item without a
// numeric amountMinor/price (variable-priced) is skipped in both versions.
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
  const v = raw.schemaVersion === undefined ? 1 : raw.schemaVersion;
  if (v !== 1 && v !== 2) die(`catalog schemaVersion ${JSON.stringify(raw.schemaVersion)} is not supported (1 or 2)`);
  let currency = 'USD';
  if (v === 2) { try { currency = validateCurrency(raw.currency); } catch (e) { die(e.message); } }
  const locationId = v === 2 && typeof raw.locationId === 'string' ? raw.locationId : null;

  const byId = new Map();       // id -> { id, name, price (integer cents), cat }
  const byName = new Map();     // nkey(name) -> [ rec, ... ]
  const sections = new Map();   // lower(section) -> exact section name (for the section tie-break)
  for (const cat of raw.menu) {
    if (cat && cat.name) sections.set(nkey(cat.name), cat.name);
    for (const it of (cat.items || [])) {
      const amountField = v === 2 ? it.amountMinor : it.price;
      if (typeof amountField !== 'number' || !it.id) continue;   // variable-priced / malformed -> skip
      let cents;
      try {
        validateFeedId(it.id, it.name);
        cents = v === 2 ? validateAmountMinor(it.amountMinor, it.id) : dollarsToCents(validateFeedPrice(it.price, it.id));
      } catch (e) { die(e.message); }
      const rec = { id: it.id, name: it.name, price: cents, cat: cat.name };
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
  return { byId, byName, sections, cachedAt: raw.cachedAt || null, label, currency, locationId, schemaVersion: v };
}

// Resolve an UNANCHORED node to a catalog record. Throws on ambiguity (fail-closed).
// Returns null when the node is not an orderable catalog item (leave it alone).
function resolveUnanchored(cat, name, price, section) {
  const cands = cat.byName.get(nkey(name));
  if (!cands) return null;                                     // not in catalog -> leave alone
  if (cands.length === 1) return cands[0];
  const byPrice = cands.filter(c => c.price === price);      // integer cents: exact
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
    const cur = textToCents(price);
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

// JSON-LD (lib/jsonld.mjs): every ld+json block is PARSED, not pattern-matched. Each
// MenuItem is resolved to a catalog record (by "identifier", else by name with the same
// fail-closed tie-break as the visible side), and the three facts of its one Offer are made
// to match the catalog: the id ("identifier"), the price, and the currency
// ("priceCurrency"). Edits are made to the value spans only, so key order, whitespace and
// every unrelated byte are preserved, and an already-correct block is left byte-identical.
//
// Refused (exit 1, nothing written): a block that mentions a MenuItem or a price but is
// not valid JSON; a duplicate key anywhere in a block (parsers keep the LAST value, so the
// value a crawler reads would differ from the one checked); a managed MenuItem whose offer
// is not a single Offer with a "price" string; MenuItem text outside an ld+json block.
//
// Reported as unread (strict default: refused): any price-bearing key (PRICE_KEYS) that is
// not the "price" of a managed item's single offer — a Product's AggregateOffer, a second
// price inside a managed item, a priceSpecification, and so on.
const RE_MENUITEM_TEXT = /"@type"\s*:\s*"(?:[^"]*[/:#])?MenuItem"/g;
const lineAt = (s, idx) => s.slice(0, idx).split('\n').length;

function tJsonLd(html, f, cat, seen, unreadLines) {
  const blocks = ldBlocks(html);
  // MenuItem text outside any ld+json block is not structured data: refuse to bake it.
  RE_MENUITEM_TEXT.lastIndex = 0;
  let mt;
  while ((mt = RE_MENUITEM_TEXT.exec(html))) {
    if (!blocks.some(k => mt.index >= k.outerStart && mt.index < k.outerEnd)) {
      die(`${f}:${lineAt(html, mt.index)}: MenuItem markup outside a <script type="application/ld+json"> block — not structured data; refusing to bake it`);
    }
  }
  const edits = [];   // { start, end, text } — absolute offsets into html
  for (const b of blocks) {
    let tree;
    try { tree = parseStrict(b.text); }
    catch (e) {
      const at = Number.isInteger(e.offset) ? `:${lineAt(html, b.start + e.offset)}` : '';
      if (/duplicate key/.test(e.message)) {
        die(`${f}${at}: JSON-LD ${e.message.replace(/ at offset \d+$/, '')} — parsers keep the LAST value, so a crawler would read a different value than the one checked; remove the duplicate`);
      }
      if (looksLikeMenuItem(b.text)) die(`${f}: a JSON-LD block containing MenuItem is not valid JSON (${e.message})`);
      if (looksLikePrice(b.text)) die(`${f}: a JSON-LD block containing a price is not valid JSON (${e.message})`);
      continue;                                                  // broken but price-free: not ours
    }
    const owned = new Set();                                     // keyStart of price keys this run reads
    const ownSubtree = node => { for (const { node: o } of objects(node)) for (const m of o.members) if (PRICE_KEYS.has(m.key)) owned.add(m.keyStart); };
    for (const { node: item } of objects(tree)) {
      if (!hasType(item, 'MenuItem')) continue;
      const nameNode = item.get('name');
      const name = nameNode && nameNode.kind === 'string' ? nameNode.value : null;
      const idNode = item.get('identifier');
      const id = idNode && idNode.kind === 'string' ? idNode.value : null;
      const off = singleOffer(item);
      let rec;
      if (id && isId(id)) rec = { id, price: priceForId(cat, id, `JSON-LD "${name}"`) };
      else {
        const cur = off.price ? textToCents(off.price.value) : NaN;
        rec = name ? resolveUnanchored(cat, name, cur, null) : null;   // JSON-LD has no section; price tie-break
        if (!rec) { ownSubtree(item); continue; }                // not a catalog item: leave alone
      }
      if (!off.offer) die(`${f}: JSON-LD MenuItem "${name}" (${rec.id}) ${off.why} — a managed item needs exactly one Offer with a "price" string; refusing to bake it`);
      seen.add(rec.id);
      owned.add(off.offer.members.find(m => m.key === 'price').keyStart);
      const abs = n => ({ start: b.start + n.start, end: b.start + n.end });
      // price
      const want = money(rec.price);
      if (off.price.value !== want) edits.push({ ...abs(off.price), text: JSON.stringify(want) });
      // currency: the offer is (id, price, currency) — all three come from the catalog
      if (off.currency) {
        if (off.currency.kind !== 'string' || off.currency.value !== cat.currency) edits.push({ ...abs(off.currency), text: JSON.stringify(cat.currency) });
      } else {
        const at = b.start + off.price.end;
        edits.push({ start: at, end: at, text: `, "priceCurrency": ${JSON.stringify(cat.currency)}` });
      }
      // identifier
      if (idNode) {
        if (id !== rec.id) edits.push({ ...abs(idNode), text: JSON.stringify(rec.id) });
      } else {
        const after = item.members.find(m => m.key === 'name') || item.members.find(m => m.key === '@type');
        const at = b.start + after.value.end;
        const nextKey = item.members[item.members.indexOf(after) + 1];
        const gap = nextKey ? b.text.slice(after.value.end, nextKey.keyStart) : '';
        const nl = gap.lastIndexOf('\n');
        edits.push({ start: at, end: at, text: nl > -1 ? `,\n${gap.slice(nl + 1)}"identifier": "${rec.id}"` : `, "identifier": "${rec.id}"` });
      }
    }
    for (const { node: o } of objects(tree)) {
      for (const m of o.members) if (PRICE_KEYS.has(m.key) && !owned.has(m.keyStart)) unreadLines.push(lineAt(html, b.start + m.keyStart));
    }
  }
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) html = html.slice(0, e.start) + e.text + html.slice(e.end);
  return html;
}

// Price-like markup OUTSIDE JSON-LD that the visible transform did not read. This is a
// lexical detector (it does not render the page): it looks for a dollar sign — written
// literally, as an HTML entity (&#36; &#x24; &dollar;) or full-width/small form (＄ ﹩) —
// followed by a digit, allowing whitespace, &nbsp; and inline tags in between; a "price":
// key outside JSON-LD; and microdata / Open Graph price properties. GUARANTEES.md lists
// what it cannot see.
const VISIBLE_PRICE_PATTERNS = [
  /\$(?:[\s ]|&nbsp;|<[^>]*>)*[0-9]/g,
  /"price"\s*:/g,
  /\bitemprop\s*=\s*["']?(?:price|lowPrice|highPrice|minPrice|maxPrice)\b/gi,
  /\b(?:property|name)\s*=\s*["']?(?:product|og):price:amount\b/gi,
];
function unreadPrices(html) {
  const blank = s => s.replace(/[^\n]/g, ' ');
  let masked = html;
  for (const k of ldBlocks(html).reverse()) masked = masked.slice(0, k.start) + blank(masked.slice(k.start, k.end)) + masked.slice(k.end);
  masked = masked.replace(RE_VISIBLE, blank)
    .replace(/&(?:#0*36|#x0*24|dollar);/gi, '$')
    .replace(/[＄﹩]/g, '$');
  const hits = [];
  for (const re of VISIBLE_PRICE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked))) hits.push(lineAt(masked, m.index));
  }
  return hits;
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
  let after = tVisible(before, cat, seen);
  const ldUnread = [];
  after = tJsonLd(after, f, cat, seen, ldUnread);
  for (const line of [...new Set([...ldUnread, ...unreadPrices(after)])].sort((a, b) => a - b)) {
    unread++;
    console.error(`bake-prices ${STRICT ? 'FAIL' : 'WARN'}: ${f}:${line}: price-like markup the baker cannot read — ${STRICT ? 'refused' : 'left as is (--allow-unread)'}`);
  }
  if (after !== before) pending.push({ f, p, after });
}
if (STRICT && unread) die(`${unread} price-like node(s) the baker cannot read; nothing written. Anchor them, or pass --allow-unread to leave them as is.`);
const changedFiles = pending.map(x => x.f);

// snapshot (v2): sorted { id: { name, amountMinor } } — input to the offline consistency check
const snap = {};
for (const id of [...seen].sort()) { const r = cat.byId.get(id); snap[id] = { name: r.name, amountMinor: r.price }; }
const snapText = JSON.stringify({
  schemaVersion: 2, source: cat.label, cachedAt: cat.cachedAt, locationId: cat.locationId, currency: cat.currency, items: snap,
}, null, 2) + '\n';
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
