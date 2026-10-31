// lib/extract.mjs — the read-only extractors behind test/parity.test.js.
//
// They pull every ANCHORED price off a page: the visible node (data-sq-item="<id>") and the
// JSON-LD MenuItem ("identifier": "<id>"). They read; they never write. Kept out of the
// test file so the extractors themselves can be regression-tested.

// Visible: data-sq-item="<id>" ...>$<price>. A grouped price ($1,000.00) is read without its
// separators, so it compares equal to the snapshot's 1000.00.
export function visiblePrices(html) {
  const re = /data-sq-item="([A-Z0-9]{20,})"[^>]*>\s*\$([0-9]{1,3}(?:,[0-9]{3})+\.[0-9]{2}|[0-9]+\.[0-9]{2})/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ id: m[1], price: m[2].replace(/,/g, '') });
  return out;
}

// JSON-LD: every MenuItem that carries an id-shaped "identifier", with ITS offer's price and
// currency, read by PARSING each ld+json block (lib/jsonld.mjs) — so key order, escaped keys
// and nesting cannot pair one item's id with another item's price. A block with a duplicate
// key throws (a parser would keep the last value; which one a crawler reads is not the one a
// pattern reads). An identified item whose offer is not a single Offer with a "price" string
// is returned with price: null, so the parity check fails on it instead of skipping it.
import { parseStrict, objects, hasType, singleOffer, ldBlocks } from './jsonld.mjs';

const ID_RE = /^[A-Z0-9]{20,}$/;
export function jsonLdPrices(html) {
  const out = [];
  for (const b of ldBlocks(html)) {
    let tree;
    try { tree = parseStrict(b.text); }
    catch (e) { throw new Error(`a JSON-LD block is not valid JSON: ${e.message}`); }   // never skipped (R2)
    for (const { node } of objects(tree)) {
      if (!hasType(node, 'MenuItem')) continue;
      const idNode = node.get('identifier');
      if (!idNode || idNode.kind !== 'string' || !ID_RE.test(idNode.value)) continue;
      const off = singleOffer(node);
      out.push({
        id: idNode.value,
        price: off.price ? off.price.value : null,
        currency: off.currency && off.currency.kind === 'string' ? off.currency.value : null,
      });
    }
  }
  return out;
}
