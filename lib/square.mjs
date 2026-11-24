// lib/square.mjs — Square Catalog objects -> the v2 menu feed bin/bake-prices.mjs reads.
//
// This is the adapter the README has always said a real POS needs. It is a PURE transform:
// Square's catalog objects in (as returned by POST /v2/catalog/search), a v2 feed out. No
// network, no credentials — bin/square-to-feed.mjs owns the fetch and hands the pages here.
//
// WHAT IS EMITTED
//   One feed item per sellable, fixed-priced ITEM_VARIATION present at the chosen location:
//     id          the VARIATION id (the object that carries the price — never the parent
//                 item's, which can have several prices)
//     name        the item name, plus " (<variation name>)" when the item has more than one
//                 variation and the variation is not the default ("Regular", "Standard", "")
//     amountMinor the location override's price_money.amount when one exists for that
//                 location, otherwise the variation's price_money.amount
//   grouped into sections by the item's first category (name from the CATEGORY objects),
//   "Uncategorized" when it has none. Sections keep their order of first appearance; items
//   keep Square's ordinal order within an item, and item order within a section.
//
// WHAT IS LEFT OUT, and why the baker is told
//   - a variation whose effective pricing at that location is VARIABLE_PRICING is emitted
//     WITHOUT amountMinor: the baker skips it (same as before) but it is visibly present;
//   - items / variations not present at the location, deleted, archived, or not sellable
//     are dropped — they are not on that location's menu (presence follows Square's
//     documented default: an object with no present_at_all_locations is present everywhere
//     except where absent_at_location_ids says otherwise — see presentAt);
//   - a price in a currency other than the feed's is refused, not converted.
//
// NOT HANDLED HERE (documented, deliberately): modifier pricing, scheduled pricing rules
// (PRICING_RULE), tax-inclusive display, item options. Those change the price a customer
// pays, not the list price of a variation; if the estate needs them, they are an adapter
// extension with their own tests, not an implicit conversion.

import { CATALOG_ID_RE } from './guards.mjs';

const DEFAULT_VARIATION_NAMES = new Set(['', 'regular', 'standard', 'default']);

// Is `obj` on this location's menu? Returns null when it is, otherwise the reason it is not.
// Square's CatalogObject reference: present_at_all_locations — "If not specified, defaults to
// true"; absent_at_location_ids applies when it is true, present_at_location_ids when it is
// false. An omitted (or null) flag is therefore TRUE (audit 2026-11-16 G2: it was read as
// false, which dropped every object that relies on the default). Two rules are stricter than
// Square, both on the side of leaving an item OFF the menu:
//   - a location in absent_at_location_ids is absent whatever else the object says, so one
//     listed as both present and absent is not emitted (and is reported as such);
//   - a flag that is not a boolean, or a list that is not an array of non-empty strings, is
//     refused: availability is never guessed from malformed data.
function presentAt(obj, locationId, what) {
  const bad = why => new Error(`Square ${what} ${JSON.stringify(String(obj.id)).slice(0, 60)}: ${why} — refusing to guess its location availability`);
  const all = obj.present_at_all_locations;
  if (all !== undefined && all !== null && typeof all !== 'boolean') throw bad(`present_at_all_locations is ${JSON.stringify(all)}, not a boolean`);
  const list = key => {
    const v = obj[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x)) throw bad(`${key} is not a list of location ids`);
    return v;
  };
  const present = list('present_at_location_ids'), absent = list('absent_at_location_ids');
  if (absent.includes(locationId)) {
    return present.includes(locationId) ? `listed as both present and absent at ${locationId}` : `not present at ${locationId}`;
  }
  if (all === false && !present.includes(locationId)) return `not present at ${locationId}`;
  return null;
}

function assertSquareId(id, what) {
  if (typeof id !== 'string' || !CATALOG_ID_RE.test(id)) {
    throw new Error(`Square ${what} id ${JSON.stringify(String(id)).slice(0, 60)} does not match /^[A-Z0-9]{20,}$/ — refusing to emit it`);
  }
  return id;
}

// Effective pricing for one variation at one location: the override wins when present.
function effectivePricing(variationData, locationId) {
  const ov = (variationData.location_overrides || []).find(o => o.location_id === locationId);
  const pricingType = (ov && ov.pricing_type) || variationData.pricing_type || (variationData.price_money ? 'FIXED_PRICING' : 'VARIABLE_PRICING');
  const priceMoney = (ov && ov.price_money) || variationData.price_money || null;
  return { pricingType, priceMoney, overridden: !!(ov && ov.price_money) };
}

/**
 * @param {{objects?: object[], related_objects?: object[]}|object[]} pages  one search
 *        response, or an array of them (all pages), or a flat array of objects
 * @param {{locationId: string, currency?: string, cachedAt?: string}} opts
 * @returns {object} v2 feed
 */
export function squareToFeed(pages, { locationId, currency = 'USD', cachedAt }) {
  if (typeof locationId !== 'string' || !locationId) throw new Error('locationId is required');
  const objects = [];
  const pageList = Array.isArray(pages) && !pages.some(p => p && p.type) ? pages : [pages];
  pageList.forEach((page, n) => {
    if (Array.isArray(page)) { objects.push(...page); return; }
    // A response that still carries a cursor is not the end of the catalog. The live fetch
    // follows it; a SAVED response cannot, so the last page given must have none — otherwise
    // every item on the pages that were not saved would be missing from the feed, silently
    // (audit 2026-11-24 H3). Square omits the field on the final page; null and "" are read
    // as omitted, anything else that is not a string is malformed and refused.
    const cursor = page.cursor;
    if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
      throw new Error(`Square response page ${n + 1} has a cursor that is not a string — refusing to guess whether the catalog is complete`);
    }
    if (cursor && n === pageList.length - 1) {
      throw new Error(`Square response is incomplete: ${pageList.length === 1 ? 'it' : `the last of ${pageList.length} pages`} still carries a cursor, so more catalog pages exist that were not provided — fetch every page (until a response has no cursor) and pass them all, in order`);
    }
    objects.push(...(page.objects || []), ...(page.related_objects || []));
  });

  const categoryName = new Map();
  for (const o of objects) {
    if (o.type === 'CATEGORY' && !o.is_deleted && o.category_data) categoryName.set(o.id, o.category_data.name);
  }

  const sections = new Map();   // section name -> items[]
  const sectionOf = name => { if (!sections.has(name)) sections.set(name, []); return sections.get(name); };
  const seenVariation = new Set();
  const skipped = [];           // { id, name, why } — reported by the CLI, never silently dropped

  for (const item of objects) {
    if (item.type !== 'ITEM' || !item.item_data) continue;
    const d = item.item_data;
    if (item.is_deleted) { skipped.push({ id: item.id, name: d.name, why: 'deleted' }); continue; }
    if (d.is_archived) { skipped.push({ id: item.id, name: d.name, why: 'archived' }); continue; }
    const itemAway = presentAt(item, locationId, 'item');
    if (itemAway) { skipped.push({ id: item.id, name: d.name, why: itemAway }); continue; }

    const catId = (d.categories && d.categories[0] && d.categories[0].id) || d.category_id || null;
    const section = (catId && categoryName.get(catId)) || 'Uncategorized';
    const variations = (d.variations || []).filter(v => v.type === 'ITEM_VARIATION' && v.item_variation_data);
    const multi = variations.filter(v => !v.is_deleted).length > 1;

    for (const v of variations.slice().sort((a, b) => (a.item_variation_data.ordinal || 0) - (b.item_variation_data.ordinal || 0))) {
      const vd = v.item_variation_data;
      const vName = vd.name || '';
      const label = multi && !DEFAULT_VARIATION_NAMES.has(vName.trim().toLowerCase()) ? `${d.name} (${vName.trim()})` : d.name;
      if (v.is_deleted) { skipped.push({ id: v.id, name: label, why: 'deleted' }); continue; }
      if (vd.sellable === false) { skipped.push({ id: v.id, name: label, why: 'not sellable' }); continue; }
      const varAway = presentAt(v, locationId, 'variation');
      if (varAway) { skipped.push({ id: v.id, name: label, why: varAway }); continue; }
      assertSquareId(v.id, 'variation');
      if (seenVariation.has(v.id)) throw new Error(`Square variation ${v.id} appears twice in the catalog pages — refusing (pages overlap?)`);
      seenVariation.add(v.id);

      const { pricingType, priceMoney } = effectivePricing(vd, locationId);
      const rec = { id: v.id, name: label, squareItemId: item.id };
      if (pricingType === 'FIXED_PRICING' && priceMoney) {
        if (!priceMoney.currency) {
          throw new Error(`Square variation ${v.id} ("${label}") has a price with no currency — refusing to assume ${currency}`);
        }
        if (priceMoney.currency !== currency) {
          throw new Error(`Square variation ${v.id} ("${label}") is priced in ${priceMoney.currency}, feed currency is ${currency} — refusing to convert`);
        }
        if (!Number.isInteger(priceMoney.amount) || priceMoney.amount < 0) {
          throw new Error(`Square variation ${v.id} ("${label}") has a non-integer or negative amount ${JSON.stringify(priceMoney.amount)}`);
        }
        rec.amountMinor = priceMoney.amount;
      } else {
        rec.pricing = 'VARIABLE';   // present on the menu, priced at the register; baker skips it
      }
      sectionOf(section).push(rec);
    }
  }

  // cachedAt is the catalog's own latest updated_at, not "now": a re-fetch of an unchanged
  // catalog yields a byte-identical feed, so --check stays green until a price moves.
  let latest = null;
  for (const o of objects) {
    if (typeof o.updated_at === 'string' && (!latest || o.updated_at > latest)) latest = o.updated_at;
    for (const v of (o.item_data && o.item_data.variations) || []) {
      if (typeof v.updated_at === 'string' && (!latest || v.updated_at > latest)) latest = v.updated_at;
    }
  }
  const feed = {
    schemaVersion: 2,
    source: { provider: 'square', locationId },
    cachedAt: cachedAt || latest,
    locationId,
    currency,
    menu: [...sections.entries()].map(([name, items]) => ({ name, items })),
  };
  return { feed, skipped };
}

// When the catalog was FETCHED, as opposed to when it last CHANGED (cachedAt). cachedAt alone
// cannot tell a feed fetched today from one fetched a year ago out of a catalog nobody has
// edited since (audit 2026-11-24 H5). bin/square-to-feed.mjs stamps a live fetch with this;
// an offline --input run is not stamped — the tool did not fetch anything and will not
// invent a time. The baker reports fetchedAt and keeps it out of the snapshot, so the
// snapshot of an unchanged catalog is still byte-identical from one fetch to the next.
// Returns a new feed; the input is not modified.
export function withFetchedAt(feed, when) {
  if (!(when instanceof Date) || Number.isNaN(when.getTime())) throw new Error('fetch time must be a valid Date');
  const { menu, ...head } = feed;
  return { ...head, fetchedAt: when.toISOString(), menu };
}
