// test/adversarial.test.js — regression tests from the 2026-10-30 adversarial audit.
//
// Every case here was reproduced against main@610d337 (v1.3.0) before the fix: each one
// either PASSED both CI gates while publishing a wrong or unchecked price, escaped the
// --site boundary, or refused valid markup. The finding ids match docs/AUDIT-2026-10-30.md.
// Nothing here touches the repo or the network.
//
// Run with: node --test   (from the repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'bake-prices.mjs');
const guards = () => import('../lib/guards.mjs');
const extract = () => import('../lib/extract.mjs');

const ID = 'PASTA0000000000000000001';
const ID2 = 'SOUP00000000000000000002';
const CATALOG = { menu: [{ name: 'Lunch', items: [{ id: ID, name: 'Pasta', price: 13 }, { id: ID2, name: 'Soup', price: 6 }] }] };

const VISIBLE = `<h2 class="cat-title">Lunch</h2>
<h3 class="item-name">Pasta</h3><div class="item-price" data-sq-item="${ID}">$13.00</div>
<h3 class="item-name">Soup</h3><div class="item-price" data-sq-item="${ID2}">$6.00</div>
`;
const LD_ITEMS = `{"@type":"MenuItem","name":"Pasta","identifier":"${ID}","offers":{"@type":"Offer","price":"13.00","priceCurrency":"USD"}},
{"@type":"MenuItem","name":"Soup","identifier":"${ID2}","offers":{"@type":"Offer","price":"6.00","priceCurrency":"USD"}}`;
const LD = body => `<script type="application/ld+json">${body}</script>\n`;
const PAGE = VISIBLE + LD(`[${LD_ITEMS}]`);

// A scratch site already baked and sealed (snapshot written), so --check passes on it.
function sealed(name, page = PAGE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pricelock-adv-${name}-`));
  const site = path.join(dir, 'site');
  fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'menu.html'), page);
  const t = { dir, site, snapshot: path.join(dir, 'snap.json'), catalog: path.join(dir, 'catalog.json') };
  fs.writeFileSync(t.catalog, JSON.stringify(CATALOG));
  t.run = (mode, ...flags) => spawnSync(process.execPath, [BIN, mode, ...flags, '--src', t.catalog, '--site', t.site, '--snapshot', t.snapshot],
    { encoding: 'utf8', timeout: 30000 });
  t.read = (f = 'menu.html') => fs.readFileSync(path.join(t.site, f), 'utf8');
  t.write = (html, f = 'menu.html') => fs.writeFileSync(path.join(t.site, f), html);
  const r = t.run('--write');
  assert.equal(r.status, 0, `baseline must bake: ${r.stderr}`);
  return t;
}

test('baseline: the sealed scratch site passes --check (the probes below start from here)', () => {
  const t = sealed('baseline');
  const r = t.run('--check');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.read(), PAGE, 'an already-correct page is not rewritten');
});

// ── H1. a symlinked DIRECTORY under --site must not be followed ─────────────
test('H1: a symlinked directory under --site is refused; the file it points at is untouched', () => {
  const t = sealed('dirlink');
  const outside = path.join(t.dir, 'outside');
  fs.mkdirSync(outside);
  const victim = PAGE.replace('$13.00', '$1.00');
  fs.writeFileSync(path.join(outside, 'victim.html'), victim);
  try { fs.symlinkSync(outside, path.join(t.site, 'linkdir'), 'dir'); }
  catch (e) { if (e.code === 'EPERM') return; throw e; }
  const r = t.run('--write');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /symbolic link/);
  assert.equal(fs.readFileSync(path.join(outside, 'victim.html'), 'utf8'), victim, 'nothing outside --site may be written');
});

test('H1: --site may itself be reached through a symlink (only links INSIDE it are refused)', () => {
  const t = sealed('rootlink');
  const alias = path.join(t.dir, 'alias');
  try { fs.symlinkSync(t.site, alias, 'dir'); }
  catch (e) { if (e.code === 'EPERM') return; throw e; }
  const r = spawnSync(process.execPath, [BIN, '--check', '--src', t.catalog, '--site', alias, '--snapshot', t.snapshot], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

// ── H2. duplicate JSON keys: parsers keep the LAST value ─────────────────────
test('H2: a duplicate "identifier" key in a MenuItem is refused', () => {
  const t = sealed('dupid');
  t.write(t.read().replace(`"identifier":"${ID}",`, `"identifier":"${ID}","identifier":"${ID2}",`));
  const r = t.run('--check');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /duplicate key "identifier"/);
});

test('H2: a duplicate "price" key inside an offer is refused', () => {
  const t = sealed('dupprice');
  t.write(t.read().replace('"price":"13.00",', '"price":"13.00","price":"1.00",'));
  const r = t.run('--check');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /duplicate key "price"/);
});

// ── H3. the offer is (id, price, currency) — all three are checked ───────────
test('H3: priceCurrency changed to EUR fails --check; --write restores USD', () => {
  const t = sealed('eur');
  t.write(t.read().replace('"price":"13.00","priceCurrency":"USD"', '"price":"13.00","priceCurrency":"EUR"'));
  assert.equal(t.run('--check').status, 1);
  const r = t.run('--write');
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.read(), /"price":"13\.00","priceCurrency":"USD"/);
  assert.equal(t.run('--check').status, 0);
});

test('H3: priceCurrency removed fails --check; --write puts it back next to the price', () => {
  const t = sealed('nocur');
  t.write(t.read().replace('"price":"13.00","priceCurrency":"USD"', '"price":"13.00"'));
  assert.equal(t.run('--check').status, 1);
  assert.equal(t.run('--write').status, 0);
  assert.match(t.read(), /"price":"13\.00", "priceCurrency": "USD"/);
  assert.equal(t.run('--check').status, 0);
});

test('H3: the parity extractor reports each offer\'s currency', async () => {
  const { jsonLdPrices } = await extract();
  const eur = PAGE.replace('"priceCurrency":"USD"', '"priceCurrency":"EUR"');
  const got = jsonLdPrices(eur).find(x => x.id === ID);
  assert.deepEqual(got, { id: ID, price: '13.00', currency: 'EUR' });
});

test('H2/H3: the parity extractor refuses duplicate keys instead of reading the first one', async () => {
  const { jsonLdPrices } = await extract();
  assert.throws(() => jsonLdPrices(PAGE.replace(`"identifier":"${ID}",`, `"identifier":"${ID}","identifier":"${ID2}",`)), /duplicate key "identifier"/);
});

test('H3: a managed item whose offer is an AggregateOffer (no single price) is refused', () => {
  const t = sealed('aggr');
  t.write(t.read().replace('{"@type":"Offer","price":"13.00","priceCurrency":"USD"}',
    '{"@type":"AggregateOffer","lowPrice":"1.00","highPrice":"13.00","priceCurrency":"USD"}'));
  const r = t.run('--check');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Pasta.*(offer|price)/i);
});

// ── M1. price-like markup the old lexical detector could not see ─────────────
const unread = [
  ['a second MenuItem for a managed id with a \\u-escaped "price" key',
    html => html + LD(`{"@type":"MenuItem","name":"Pasta","identifier":"${ID}","offers":{"@type":"Offer","\\u0070rice":"1.00","priceCurrency":"USD"}}`)],
  ['a Product with an AggregateOffer (lowPrice / highPrice, no "price" key)',
    html => html + LD(`{"@type":"Product","name":"Pasta","offers":{"@type":"AggregateOffer","lowPrice":"1.00","highPrice":"2.00","priceCurrency":"USD"}}`)],
  ['a \\u-escaped "@type" hiding an unanchored catalog MenuItem with an escaped price',
    html => html + LD(`{"@type":"Menu\\u0049tem","name":"Soup","offers":{"@type":"Offer","\\u0070rice":"1.00","priceCurrency":"USD"}}`)],
  ['a visible price written as an HTML entity (&#36;1.00)', html => html + '<p>Pasta today &#36;1.00</p>\n'],
  ['a visible price written as &#x24;1.00', html => html + '<p>Pasta today &#x24;1.00</p>\n'],
  ['a visible price written as &dollar;1.00', html => html + '<p>Pasta today &dollar;1.00</p>\n'],
  ['a visible price split across tags ($<span>1.00</span>)', html => html + '<p>Pasta today $<span>1.00</span></p>\n'],
  ['a visible price with a full-width dollar sign (＄1.00)', html => html + '<p>Pasta today ＄1.00</p>\n'],
  ['a microdata price (itemprop="price")', html => html + '<span itemprop="price" content="1.00">1</span>\n'],
  ['an Open Graph price (product:price:amount)', html => html + '<meta property="product:price:amount" content="1.00">\n'],
];
for (const [name, mutate] of unread) {
  test(`M1: ${name} fails --check (strict default)`, () => {
    const t = sealed('unread');
    t.write(mutate(t.read()));
    const r = t.run('--check');
    assert.equal(r.status, 1, `must be caught: ${r.stdout}${r.stderr}`);
  });
}

// ── M2. valid markup the regex transform used to refuse ──────────────────────
test('M2: "name" before "@type" in a MenuItem is valid JSON-LD and bakes', () => {
  const page = VISIBLE + LD(`{"name":"Pasta","@type":"MenuItem","identifier":"${ID}","offers":{"@type":"Offer","price":"12.00","priceCurrency":"USD"}}`
    ) + LD(`{"@type":"MenuItem","name":"Soup","identifier":"${ID2}","offers":{"@type":"Offer","price":"6.00","priceCurrency":"USD"}}`);
  const t = sealed('reorder', page);
  assert.match(t.read(), /"price":"13\.00"/);
  assert.equal(t.run('--check').status, 0);
});

test('M2: "identifier" after "offers" bakes, keeping exactly one identifier key', () => {
  const page = VISIBLE + LD(`[{"@type":"MenuItem","name":"Pasta","offers":{"@type":"Offer","price":"12.00","priceCurrency":"USD"},"identifier":"${ID}"},`
    + `{"@type":"MenuItem","name":"Soup","identifier":"${ID2}","offers":{"@type":"Offer","price":"6.00","priceCurrency":"USD"}}]`);
  const t = sealed('idafter', page);
  const html = t.read();
  assert.match(html, /"price":"13\.00"/);
  assert.equal((html.match(/"identifier"/g) || []).length, 2, 'one identifier per item, none added');
  assert.equal(t.run('--check').status, 0);
});

// ── L1. IPv6 forms that embed or route to a non-public address ───────────────
test('L1: SIIT, NAT64 local-use, site-local, Teredo and 6to4-relay addresses are blocked', async () => {
  const { isBlockedAddress } = await guards();
  for (const a of ['::ffff:0:7f00:1', '::ffff:0:a9fe:a9fe', '64:ff9b:1::7f00:1', '64:ff9b:1::a9fe:a9fe',
    'fec0::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '192.88.99.1', '3fff::1', '5f00::1', '2001:2::1']) {
    assert.equal(isBlockedAddress(a), true, `${a} must be blocked`);
  }
  for (const a of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '64:ff9b::808:808', '2002:808:808::1', '8.8.8.8']) {
    assert.equal(isBlockedAddress(a), false, `${a} must be allowed`);
  }
});

// ── L3. Square money with no currency is refused, not assumed ────────────────
test('L3: a Square variation price with no currency is refused', async () => {
  const { squareToFeed } = await import('../lib/square.mjs');
  const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'square', 'search-response.json'), 'utf8'));
  const v = fixture.objects.find(o => o.type === 'ITEM').item_data.variations[0];
  delete v.item_variation_data.price_money.currency;
  assert.throws(() => squareToFeed(fixture, { locationId: 'LDEVON0000000001' }), /no currency/);
});

// ── Red-team round 2 (against the first v1.4 fix, before merge) ─────────────
// A focused red-team of this branch found seven more bypasses. Each passed both gates.
const T_LD = (typeAttr, body) => `<script type="${typeAttr}">${body}</script>\n`;
const ESCAPED_ITEM = `{"@type":"Menu\\u0049tem","name":"Pasta","identifier":"${ID}","offers":{"@type":"Offer","pr\\u0069ce":"1.00","priceCurrency":"USD"}}`;
const round2 = [
  ['R1: a live ld+json block whose type is entity-encoded (ld&#x2B;json), with escaped keys',
    html => html + T_LD('application/ld&#x2B;json', ESCAPED_ITEM)],
  ['R1: a live ld+json block with type " application/LD+JSON; charset=utf-8"',
    html => html + T_LD(' application/LD+JSON; charset=utf-8', ESCAPED_ITEM)],
  ['R2: an ld+json block that is not valid JSON is refused even when its keys are escaped',
    html => html + LD(`{"@type":"\\u004denuItem","name":"Pasta","identifier":"${ID}","offers":{"pr\\u0069ce":"1.00"},}`)],
  ['R3: a separate node sharing the offer\'s @id adds priceCurrency EUR (JSON-LD node merging)',
    html => html.replace('"offers":{"@type":"Offer","price":"13.00"', '"offers":{"@id":"#o1","@type":"Offer","price":"13.00"')
      + LD('{"@id":"#o1","priceCurrency":"EUR"}')],
  ['R4: &#36 with no semicolon before a tag (renders "$1.00")', html => html + '<p>Pasta today &#36<b>1.00</b></p>\n'],
  ['R4: a zero-width space between $ and the digit', html => html + '<p>Pasta today $​1.00</p>\n'],
  ['R4: &#160; between $ and the digit', html => html + '<p>Pasta today $&#160;1.00</p>\n'],
  ['R4: full-width digits ($１.００)', html => html + '<p>Pasta today $１.００</p>\n'],
  ['R4: digits written as character references ($&#49;.00)', html => html + '<p>Pasta today $&#49;.00</p>\n'],
];
for (const [name, mutate] of round2) {
  test(`${name} fails --check`, () => {
    const t = sealed('round2');
    t.write(mutate(t.read()));
    const r = t.run('--check');
    assert.equal(r.status, 1, `must be caught: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stderr, /\n\s+at .*\.mjs:\d+/, 'a clean FAIL, not a stack trace');
  });
}

test('R1: <script type="text/plain"> with JSON inside is not JSON-LD (and data-type does not count)', async () => {
  const { ldBlocks } = await import('../lib/jsonld.mjs');
  assert.equal(ldBlocks('<script data-type="application/ld+json" type="text/plain">{}</script>').length, 0);
  assert.equal(ldBlocks('<script type="text/plain" type="application/ld+json">{}</script>').length, 0, 'the FIRST type attribute decides');
  assert.equal(ldBlocks('<SCRIPT TYPE=application/ld+json>{}</SCRIPT >').length, 1);
});

test('R2: the parity extractor refuses an unparseable ld+json block instead of skipping it', async () => {
  const { jsonLdPrices } = await extract();
  assert.throws(() => jsonLdPrices(LD('{"@type":"Thing",}')), /not valid JSON/);
});

test('R2: a deeply nested block is a clean refusal, not a crash', () => {
  const t = sealed('deep');
  t.write(t.read() + LD('['.repeat(20000) + ']'.repeat(20000)));
  const r = t.run('--check');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^bake-prices FAIL: .*not valid JSON/m);
});

test('R5: the visible-price detector is linear on a pathological page ("$<" with no ">")', () => {
  // The first v1.4 detector skipped tags with an unbounded <[^>]*> and took 61 s on 400 KB.
  const t = sealed('slow');
  t.write(t.read() + '<p>' + '$<'.repeat(100000) + '</p>\n');
  const t0 = Date.now();
  const r = t.run('--check', '--allow-unread');
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  assert.equal(r.error, undefined, String(r.error));
});
