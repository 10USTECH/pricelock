// lib/jsonld.mjs — the JSON-LD layer the baker and the parity gate share.
//
// Why a parser and not regexes: JSON objects are unordered, keys may be \u-escaped, and a
// duplicate key is legal to most parsers (they keep the LAST value). A text pattern sees
// none of that, so a page can carry a price that the pattern never reads (v1.3.0 audit,
// docs/AUDIT-2026-10-30.md H2/H3/M1). parseStrict reads JSON exactly, refuses duplicate keys,
// and records the source span of every value so the baker can edit ONE value in place and
// leave every other byte of the block — and the page — untouched.
//
// Scope: <script> elements are still found by a pattern (RE_SCRIPT), with their type decoded
// as a browser would. Parsing HTML in general is out of scope for this tool; see GUARANTEES.md.

export class JsonError extends Error {
  constructor(msg, offset) { super(`${msg} at offset ${offset}`); this.offset = offset; }
}

const WS = /[ \t\n\r]*/y;
const NUM = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const STR = /"(?:[^"\\\u0000-\u001f]|\\.)*"/y;

// Parse `text` as JSON. Returns a node tree:
//   { kind: 'object', start, end, members: [{ key, keyStart, keyEnd, value }], get(key) }
//   { kind: 'array',  start, end, items: [node] }
//   { kind: 'string' | 'number' | 'true' | 'false' | 'null', start, end, value }
// start/end are offsets into `text` (end exclusive). Throws JsonError on any syntax error or
// duplicate key (after unescaping: "price" and "price" are the same key).
export function parseStrict(text) {
  let i = 0;
  const ws = () => { WS.lastIndex = i; WS.exec(text); i = WS.lastIndex; };
  const fail = msg => { throw new JsonError(msg, i); };
  const str = () => {
    STR.lastIndex = i;
    const m = STR.exec(text);
    if (!m) fail('invalid string');
    let value;
    try { value = JSON.parse(m[0]); } catch { fail('invalid string escape'); }
    const node = { kind: 'string', start: i, end: i + m[0].length, value };
    i = node.end;
    return node;
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      const node = { kind: 'object', start: i, members: [], map: new Map() };
      i++; ws();
      if (text[i] === '}') { i++; node.end = i; return finishObject(node); }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected a key');
        const k = str();
        if (node.map.has(k.value)) { i = k.start; fail(`duplicate key ${JSON.stringify(k.value)}`); }
        ws();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        const v = value();
        node.map.set(k.value, v);
        node.members.push({ key: k.value, keyStart: k.start, keyEnd: k.end, value: v });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; node.end = i; return finishObject(node); }
        fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      const node = { kind: 'array', start: i, items: [] };
      i++; ws();
      if (text[i] === ']') { i++; node.end = i; return node; }
      for (;;) {
        node.items.push(value());
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; node.end = i; return node; }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') return str();
    for (const [lit, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(lit, i)) { const node = { kind: lit, start: i, end: i + lit.length, value: v }; i = node.end; return node; }
    }
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (m) { const node = { kind: 'number', start: i, end: i + m[0].length, value: Number(m[0]) }; i = node.end; return node; }
    fail('unexpected character');
  };
  const finishObject = node => { node.get = k => node.map.get(k); return node; };
  const root = value();
  ws();
  if (i !== text.length) fail('trailing content');
  return root;
}

// Every object node in the tree, depth-first, with its ancestor chain.
export function* objects(node, ancestors = []) {
  if (!node) return;
  if (node.kind === 'object') {
    yield { node, ancestors };
    for (const m of node.members) yield* objects(m.value, [...ancestors, node]);
  } else if (node.kind === 'array') {
    for (const it of node.items) yield* objects(it, ancestors);
  }
}

// schema.org properties that carry a price. A key in this set anywhere in a JSON-LD block is
// a price the baker must either own (the one managed offer of a managed item) or report.
export const PRICE_KEYS = new Set(['price', 'lowPrice', 'highPrice', 'minPrice', 'maxPrice']);
// Keys that change what a price MEANS. A "priceCurrency" outside the managed offer can still
// reach it: JSON-LD merges every node that shares an "@id", so a separate
// {"@id": "#offer", "priceCurrency": "EUR"} gives the managed offer a second currency (R3).
export const PRICE_FACT_KEYS = new Set([...PRICE_KEYS, 'priceCurrency']);

// "MenuItem", "schema:MenuItem", "https://schema.org/MenuItem", or an array containing one.
const isTypeName = (v, t) => typeof v === 'string' && (v === t || new RegExp(`(?:^|[/:#])${t}$`).test(v));
export function hasType(obj, t) {
  const n = obj.get('@type');
  if (!n) return false;
  if (n.kind === 'string') return isTypeName(n.value, t);
  if (n.kind === 'array') return n.items.some(x => x.kind === 'string' && isTypeName(x.value, t));
  return false;
}

export const PRICE_TEXT_RE = /^[0-9]+\.[0-9]{2}$/;

// The single offer of a MenuItem, or why there is not one. A managed item must carry
// exactly one Offer with a "price" string like "12.00"; anything else (no offers, several,
// an AggregateOffer, a numeric price, a priceSpecification) cannot be baked or checked
// safely, so the caller refuses it.
export function singleOffer(item) {
  let o = item.get('offers');
  if (!o) return { why: 'has no "offers"' };
  if (o.kind === 'array') {
    if (o.items.length !== 1) return { why: `has ${o.items.length} offers (exactly one is supported)` };
    o = o.items[0];
  }
  if (o.kind !== 'object') return { why: '"offers" is not an object' };
  const t = o.get('@type');
  if (t && !hasType(o, 'Offer')) return { why: `offer @type is ${JSON.stringify(t.value ?? t.kind)}, not "Offer"` };
  const price = o.get('price');
  if (!price) return { why: 'offer has no "price"' };
  if (price.kind !== 'string' || !PRICE_TEXT_RE.test(price.value)) {
    return { why: `offer "price" must be a string like "12.00" (got ${JSON.stringify(price.value)})` };
  }
  return { offer: o, price, currency: o.get('priceCurrency') || null };
}

// The <script type="application/ld+json"> blocks of a page: content offsets and text.
// Browsers decide a script's type from the FIRST `type` attribute, after decoding character
// references and trimming whitespace, and ignoring parameters (`; charset=…`). A pattern on
// the raw attribute text missed `type="application/ld&#x2B;json"` — a live block that
// neither gate read (docs/AUDIT-2026-10-30.md R1). So every <script> element is found, and
// its type is decoded the way a browser would before it is compared.
const RE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi;
const RE_TYPE_ATTR = /(?:^|[\s/])type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
const NAMED_REFS = { amp: '&', plus: '+', sol: '/', period: '.', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0', dollar: '$', semi: ';', colon: ':' };
export function decodeCharRefs(s) {
  return s.replace(/&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z]+));?/g, (m, dec, hex, name) => {
    if (dec || hex) {
      const cp = parseInt(dec || hex, dec ? 10 : 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '\uFFFD';
    }
    const v = NAMED_REFS[name.toLowerCase()];
    return v === undefined || (!m.endsWith(';') && !/^(amp|lt|gt|quot|nbsp)$/i.test(name)) ? m : v;
  });
}
export function scriptType(attrs) {
  const m = RE_TYPE_ATTR.exec(attrs);
  if (!m) return '';
  const raw = m[1] ?? m[2] ?? m[3] ?? '';
  return decodeCharRefs(raw).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '').split(';')[0].trim().toLowerCase();
}
export function ldBlocks(html) {
  const out = [];
  RE_SCRIPT.lastIndex = 0;
  let b;
  while ((b = RE_SCRIPT.exec(html))) {
    if (scriptType(b[1]) !== 'application/ld+json') continue;
    const start = b.index + '<script'.length + b[1].length + 1;
    out.push({ outerStart: b.index, outerEnd: b.index + b[0].length, start, end: start + b[2].length, text: b[2] });
  }
  return out;
}

// Used only to word the error for a block that does NOT parse (every such block is refused).
export const looksLikeMenuItem = s => /MenuItem|Menu\\u0049tem/i.test(s);
