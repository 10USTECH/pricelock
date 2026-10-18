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

// JSON-LD: one MenuItem's identifier paired with THAT item's price. Each span is bounded so
// neither the identifier nor the price can be read from a later MenuItem (an unbounded lazy
// match pairs one item's id with the next item's price when the first has no price, or lists
// "identifier" after "offers"). An item the bound cannot pair is not checked — the baker
// refuses those shapes before they are written (see checkJsonLdStructure).
const NOT_NEXT = '(?:(?!"@type":\\s*"MenuItem")[\\s\\S])*?';
const RE_LD = new RegExp(`"@type":\\s*"MenuItem"\\s*,${NOT_NEXT}"identifier":\\s*"([A-Z0-9]{20,})"${NOT_NEXT}"price":\\s*"([0-9]+\\.[0-9]{2})"`, 'g');
export function jsonLdPrices(html) {
  const out = [];
  let m;
  RE_LD.lastIndex = 0;
  while ((m = RE_LD.exec(html))) out.push({ id: m[1], price: m[2] });
  return out;
}
