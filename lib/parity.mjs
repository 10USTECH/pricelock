// lib/parity.mjs — the offline consistency check, for ANY site and snapshot.
//
// test/parity.test.js proves the demo tree. This is the same check as a function, so a site
// that uses pricelock can run it against its own tree (bin/check-parity.mjs is the command).
// It reads; it never writes. No catalog, no network.
//
// WHAT IT CHECKS, for the .html files under `site` (the set the baker reads: recursive, no
// symbolic links) and the snapshot the baker wrote:
//   1. the snapshot is a v2 snapshot: USD, at least one item, every id id-shaped, every
//      amountMinor a non-negative integer;
//   2. every anchored visible price (data-sq-item) is in the snapshot and equals it;
//   3. every identified JSON-LD MenuItem is in the snapshot, with a single readable offer
//      whose price and priceCurrency equal it;
//   4. every snapshot id has a visible node and a JSON-LD MenuItem somewhere on the site;
//   5. PER PAGE (the default): the ids a page shows as visible prices are exactly the ids its
//      JSON-LD describes. Site-wide pairing let page A carry an item's visible price and
//      page B its structured data, so neither page's markup described what that page shows.
//      An item need not be on every page; each page is checked for the items it carries.
//      `siteWide: true` drops rule 5 only (for a site that deliberately keeps its menu
//      markup on one page and shows prices on another).
// A page the extractors refuse (unparseable ld+json, markup inside a comment, a type from
// another vocabulary, …) is an error, never a skip.
//
// WHAT IT DOES NOT CHECK: that the snapshot matches the catalog (only `bake-prices --check`
// ties the site to its source — whoever can edit all three surfaces can make them agree),
// unanchored prices (the baker's strict default refuses those), or the name shown beside an id.

import fs from 'node:fs';
import path from 'node:path';
import { visiblePrices, jsonLdPrices } from './extract.mjs';
import { listHtml, centsToText, validateCurrency, CATALOG_ID_RE } from './guards.mjs';

/**
 * @param {{site: string, snapshot: string, siteWide?: boolean}} opts
 * @returns {{ok: boolean, errors: string[], site: string, snapshot: string, pages: number,
 *            ids: number, visible: number, jsonld: number, mode: 'per-page'|'site-wide'}}
 */
export function checkParity({ site, snapshot, siteWide = false }) {
  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const out = { ok: false, errors: [], site: real(site), snapshot: real(snapshot), pages: 0, ids: 0, visible: 0, jsonld: 0, mode: siteWide ? 'site-wide' : 'per-page' };
  const err = msg => { out.errors.push(msg); };

  // 1. the snapshot
  let snap;
  try { snap = JSON.parse(fs.readFileSync(snapshot, 'utf8')); }
  catch (e) { err(e instanceof SyntaxError ? `snapshot is not valid JSON: ${e.message}` : `cannot read the snapshot: ${e.message}`); return out; }
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) { err('snapshot is not a JSON object'); return out; }
  if (snap.schemaVersion !== 2) err(`snapshot schemaVersion is ${JSON.stringify(snap.schemaVersion)}, not 2 — re-run bake-prices --write`);
  try { validateCurrency(snap.currency); } catch (e) { err(`snapshot currency: ${e.message}`); }
  const items = snap.items && typeof snap.items === 'object' && !Array.isArray(snap.items) ? snap.items : {};
  const ids = Object.keys(items).sort();
  if (ids.length === 0) err('snapshot has no items — run bake-prices --write');
  const want = new Map();   // id -> "12.00"
  for (const id of ids) {
    if (!CATALOG_ID_RE.test(id)) { err(`snapshot id ${JSON.stringify(id).slice(0, 60)} is not a catalog id`); continue; }
    const v = items[id];
    if (!v || !Number.isInteger(v.amountMinor) || v.amountMinor < 0) { err(`snapshot ${id}: amountMinor must be a non-negative integer`); continue; }
    want.set(id, centsToText(v.amountMinor));
  }
  out.ids = ids.length;
  if (out.errors.length) return out;

  // the pages
  let pages;
  try { pages = listHtml(site); } catch (e) { err(`--site ${site}: ${e.message}`); return out; }
  if (pages.length === 0) { err(`no .html files under ${site}`); return out; }
  out.pages = pages.length;

  const seenVisible = new Set(), seenLd = new Set();
  for (const f of pages) {
    const html = fs.readFileSync(path.join(site, f), 'utf8');
    let vis = null, ld = null;
    try { vis = visiblePrices(html); } catch (e) { err(`${f}: ${e.message}`); }
    try { ld = jsonLdPrices(html); } catch (e) { err(`${f}: ${e.message}`); }
    // 2. visible
    for (const { id, price } of vis || []) {
      out.visible++; seenVisible.add(id);
      if (!want.has(id)) err(`${f}: visible id ${id} is not in the snapshot`);
      else if (price !== want.get(id)) err(`${f}: visible price $${price} for ${id} != snapshot $${want.get(id)}`);
    }
    // 3. JSON-LD
    for (const { id, price, currency } of ld || []) {
      out.jsonld++; seenLd.add(id);
      if (!want.has(id)) { err(`${f}: JSON-LD id ${id} is not in the snapshot`); continue; }
      if (price === null) err(`${f}: JSON-LD MenuItem ${id} has no readable single offer (exactly one Offer with a "price" string like "12.00")`);
      else if (price !== want.get(id)) err(`${f}: JSON-LD price $${price} for ${id} != snapshot $${want.get(id)}`);
      if (currency !== snap.currency) err(`${f}: JSON-LD priceCurrency ${currency} for ${id} != snapshot ${snap.currency}`);
    }
    // 5. per page: the ids shown == the ids described (skipped if either side was refused above)
    if (!siteWide && vis && ld) {
      const v = new Set(vis.map(x => x.id)), l = new Set(ld.map(x => x.id));
      for (const id of [...v].sort()) if (!l.has(id)) err(`${f}: ${id} has a visible price but no JSON-LD MenuItem on this page (--site-wide allows it on another page)`);
      for (const id of [...l].sort()) if (!v.has(id)) err(`${f}: ${id} has a JSON-LD MenuItem but no visible price on this page (--site-wide allows it on another page)`);
    }
  }
  // 4. coverage
  for (const id of ids) {
    if (!seenVisible.has(id)) err(`snapshot id ${id} (${items[id].name}) has no visible price node on any page`);
    if (!seenLd.has(id)) err(`snapshot id ${id} (${items[id].name}) has no JSON-LD MenuItem on any page`);
  }
  out.ok = out.errors.length === 0;
  return out;
}
