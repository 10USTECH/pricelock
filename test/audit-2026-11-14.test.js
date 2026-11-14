// test/audit-2026-11-14.test.js — regression tests from the 2026-11-14 correctness audit.
//
// Every "refused" / "anchors by section" case here PASSED both CI gates on main@025b885
// (v1.4.0) while a browser or JSON-LD consumer would read a different price or identity
// than the one checked. Finding ids match docs/AUDIT-2026-11-14.md. Nothing here touches the
// repo or the network.
//
// Run with: node --test   (from the repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visiblePrices, jsonLdPrices } from '../lib/extract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'bake-prices.mjs');

const LUNCH = 'HOUSESALADLUNCH0000000001', DINNER = 'HOUSESALADDINNER000000002';
const ID = 'PASTA0000000000000000001', ID2 = 'SOUP00000000000000000002';
const TWINS = { schemaVersion: 2, currency: 'USD', menu: [
  { name: 'Lunch',  items: [{ id: LUNCH,  name: 'House Salad', amountMinor: 1200 }] },
  { name: 'Dinner', items: [{ id: DINNER, name: 'House Salad', amountMinor: 1600 }] }] };
const PLAIN = { schemaVersion: 2, currency: 'USD', menu: [{ name: 'Lunch', items: [
  { id: ID, name: 'Pasta', amountMinor: 1300 }, { id: ID2, name: 'Soup', amountMinor: 600 }] }] };

function site(name, page, catalog) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pricelock-a1114-${name}-`));
  const s = path.join(dir, 'site');
  fs.mkdirSync(s);
  fs.writeFileSync(path.join(s, 'menu.html'), page);
  const t = { snapshot: path.join(dir, 'snap.json'), catalog: path.join(dir, 'catalog.json') };
  fs.writeFileSync(t.catalog, JSON.stringify(catalog));
  t.run = mode => spawnSync(process.execPath, [BIN, mode, '--src', t.catalog, '--site', s, '--snapshot', t.snapshot], { encoding: 'utf8', timeout: 30000 });
  t.read = () => fs.readFileSync(path.join(s, 'menu.html'), 'utf8');
  return t;
}
// Refused by --write: exit 1, page untouched, no snapshot.
function refused(name, page, catalog, why) {
  const t = site(name, page, catalog);
  const r = t.run('--write');
  assert.equal(r.status, 1, `expected a refusal; got exit ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, why);
  assert.equal(t.read(), page, 'nothing written');
  assert.equal(fs.existsSync(t.snapshot), false, 'no snapshot written');
}
function bakes(name, page, catalog) {
  const t = site(name, page, catalog);
  const r = t.run('--write');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.run('--check').status, 0);
  return t.read();
}

const LD = body => `<script type="application/ld+json">${body}</script>\n`;
const row = (name, price, attrs = '') => `<h3 class="item-name">${name}</h3><div class="item-price"${attrs}>$${price}</div>\n`;
const item = (name, price, extra = '', offerExtra = '') =>
  `{"@type":"MenuItem","name":"${name}"${extra},"offers":{"@type":"Offer","price":"${price}","priceCurrency":"USD"${offerExtra}}}`;
const anchored = `<h2 class="cat-title">Lunch</h2>\n${row('Pasta', '13.00', ` data-sq-item="${ID}"`)}${row('Soup', '6.00', ` data-sq-item="${ID2}"`)}`;
const ldPasta = (extra = '', offerExtra = '') => item('Pasta', '13.00', `,"identifier":"${ID}"${extra}`, offerExtra);
const ldSoup = item('Soup', '6.00', `,"identifier":"${ID2}"`);
const ctx = '"@context":"https://schema.org"';

test('baseline: the anchored scratch page bakes and is left byte-identical', () => {
  const page = anchored + LD(`{${ctx},"@graph":[${ldPasta()},${ldSoup}]}`);
  assert.equal(bakes('base', page, PLAIN), page);
});

// ── F1. identity must never be taken from the price on the page ─────────────
const twinsPage = (lunch, dinner) =>
  `<h2 class="cat-title">Lunch</h2>\n${row('House Salad', lunch)}<h2 class="cat-title">Dinner</h2>\n${row('House Salad', dinner)}`
  + LD(`{${ctx},"@type":"Menu","hasMenuSection":[`
    + `{"@type":"MenuSection","name":"Lunch","hasMenuItem":[${item('House Salad', lunch)}]},`
    + `{"@type":"MenuSection","name":"Dinner","hasMenuItem":[${item('House Salad', dinner)}]}]}`);

test('F1: unanchored twins showing each other\'s price are anchored by SECTION, and the price corrected', () => {
  const html = bakes('f1-swap', twinsPage('16.00', '12.00'), TWINS);
  assert.match(html, new RegExp(`Lunch</h2>\\n<h3 class="item-name">House Salad</h3><div class="item-price" data-sq-item="${LUNCH}">\\$12\\.00<`));
  assert.match(html, new RegExp(`Dinner</h2>\\n<h3 class="item-name">House Salad</h3><div class="item-price" data-sq-item="${DINNER}">\\$16\\.00<`));
  const ld = jsonLdPrices(html);
  assert.deepEqual(ld.map(x => [x.id, x.price]), [[LUNCH, '12.00'], [DINNER, '16.00']]);
});

test('F1: a twin with no section is refused even when its price matches exactly one candidate', () => {
  refused('f1-nosec', row('House Salad', '16.00'), TWINS, /ambiguous node "House Salad".*never by the price/);
});

test('F1: a JSON-LD twin outside any MenuSection is refused (price is not a tie-break)', () => {
  refused('f1-ld', LD(`{${ctx},"@graph":[${item('House Salad', '16.00')}]}`), TWINS, /ambiguous node "House Salad".*never by the price/);
});

// ── F2. one effective price property: only plain schema.org terms ───────────
for (const key of ['https://schema.org/price', 'http://schema.org/price', 'schema:price']) {
  test(`F2: a second price under the key "${key}" is refused by the baker and the parity extractor`, () => {
    const page = anchored + LD(`{${ctx},"@graph":[${ldPasta('', `,"${key}":"1.00"`)},${ldSoup}]}`);
    refused('f2-key', page, PLAIN, /JSON-LD key .* is not a plain schema\.org term/);
    assert.throws(() => jsonLdPrices(page), /not a plain schema\.org term/);
  });
}

test('F2: a local @context that aliases a term to price is refused', () => {
  const page = anchored + LD(`{"@context":["https://schema.org",{"cost":"http://schema.org/price"}],"@graph":[${ldPasta('', ',"cost":"1.00"')},${ldSoup}]}`);
  refused('f2-alias', page, PLAIN, /"@context" must be the string "https:\/\/schema\.org"/);
  assert.throws(() => jsonLdPrices(page), /@context/);
});

test('F2: a nested @context and an unsupported keyword (@reverse) are refused', () => {
  refused('f2-nested', anchored + LD(`{${ctx},"@graph":[${ldPasta(',"@context":{"price":"http://example.com/x"}')},${ldSoup}]}`), PLAIN, /"@context" is only supported at the top of a block/);
  refused('f2-kw', anchored + LD(`{${ctx},"@graph":[${ldPasta()},${ldSoup}],"@reverse":{}}`), PLAIN, /JSON-LD keyword "@reverse" is not supported/);
});

test('F2: "http://schema.org", a trailing slash, and no @context at all still bake', () => {
  for (const c of ['"@context":"http://schema.org",', '"@context":"https://schema.org/",', '']) {
    const page = anchored + LD(`{${c}"@graph":[${ldPasta()},${ldSoup}]}`);
    assert.equal(bakes('f2-ok', page, PLAIN), page);
  }
});

// ── F3. the anchor the baker reads is the anchor the browser keeps ──────────
test('F3: DATA-SQ-ITEM before data-sq-item (attribute names are case-insensitive; the browser keeps the first) is refused', () => {
  const page = `<h2 class="cat-title">Lunch</h2>\n${row('Pasta', '13.00', ` data-sq-item="${ID}"`)}${row('Soup', '6.00', ` DATA-SQ-ITEM="${ID}" data-sq-item="${ID2}"`)}`
    + LD(`{${ctx},"@graph":[${ldPasta()},${ldSoup}]}`);
  refused('f3', page, PLAIN, /data-sq-item must appear exactly once/);
});

// ── F4. nothing can merge a second offer onto a managed item ────────────────
test('F4: a managed MenuItem or its Offer carrying "@id" is refused (a node sharing the @id would merge into it)', () => {
  const other = LD(`{${ctx},"@id":"#pasta","offers":{"@type":"Offer"}}`);
  refused('f4-item', anchored + LD(`{${ctx},"@graph":[${ldPasta(',"@id":"#pasta"')},${ldSoup}]}`) + other, PLAIN, /must not carry "@id"/);
  refused('f4-offer', anchored + LD(`{${ctx},"@graph":[${ldPasta('', ',"@id":"#o"')},${ldSoup}]}`), PLAIN, /must not carry "@id"/);
});

test('F4: "@id" on unmanaged nodes (the Menu, an Organization) is fine', () => {
  const page = anchored + LD(`{${ctx},"@type":"Menu","@id":"#menu","hasMenuItem":[${ldPasta()},${ldSoup}]}`) + LD(`{${ctx},"@type":"Restaurant","@id":"#org","hasMenu":{"@id":"#menu"}}`);
  assert.equal(bakes('f4-ok', page, PLAIN), page);
});

// ── F5. markup a browser does not render is not published content ───────────
const ldPlain = LD(`{${ctx},"@graph":[${ldPasta()},${ldSoup}]}`);
for (const [what, open, close] of [
  ['an HTML comment', '<!--', '-->'], ['<template>', '<template>', '</template>'],
  ['<noscript>', '<noscript>', '</noscript>'], ['<textarea>', '<textarea>', '</textarea>'],
  ['a non-JSON-LD <script>', '<script type="text/x-tmpl">', '</script>'],
]) {
  test(`F5: visible price nodes inside ${what} are refused by the baker and the parity extractor`, () => {
    const page = `${open}\n${anchored}${close}\n` + ldPlain;
    refused('f5-vis', page, PLAIN, /a browser does not render it/);
    assert.throws(() => visiblePrices(page), /does not render/);
  });
}

test('F5: an ld+json block inside an HTML comment or a <template> is refused, not processed as live', () => {
  for (const [open, close] of [['<!--', '-->'], ['<template>', '</template>']]) {
    const page = anchored + `${open}${ldPlain}${close}\n`;
    refused('f5-ld', page, PLAIN, /a browser does not render it/);
    assert.throws(() => jsonLdPrices(page), /does not render/);
  }
});

test('F5: ordinary comments, and "<!--" inside a JSON-LD string, do not trip the check', () => {
  const page = `<!-- prices carry data-sq-item; see the README -->\n<title>Menu</title>\n` + anchored
    + LD(`{${ctx},"description":"<!-- not a comment","@graph":[${ldPasta()},${ldSoup}]}`) + '<!-- end -->\n';
  assert.equal(bakes('f5-ok', page, PLAIN), page);
});
