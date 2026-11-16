// test/audit-2026-11-16.test.js — regression tests from the 2026-11-16 audit.
//
// Every "refused" / "is present" case marked (G1)–(G4) here PASSED both CI gates, or was
// silently wrong, on main@47b05e5 (v1.5.0). Finding ids match docs/AUDIT-2026-11-16.md.
// The cases marked "control" passed before and must keep passing. Nothing here touches the
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
import { jsonLdPrices } from '../lib/extract.mjs';
import { squareToFeed } from '../lib/square.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'bake-prices.mjs');

const ID = 'PASTA0000000000000000001', ID2 = 'SOUP00000000000000000002';
const PLAIN = { schemaVersion: 2, currency: 'USD', menu: [{ name: 'Lunch', items: [
  { id: ID, name: 'Pasta', amountMinor: 1300 }, { id: ID2, name: 'Soup', amountMinor: 600 }] }] };

const LD = body => `<script type="application/ld+json">${body}</script>\n`;
const row = (name, price, attrs = '') => `<h3 class="item-name">${name}</h3><div class="item-price"${attrs}>$${price}</div>\n`;
const item = (name, price, extra = '', type = 'MenuItem', offerType = 'Offer') =>
  `{"@type":"${type}","name":"${name}"${extra},"offers":{"@type":"${offerType}","price":"${price}","priceCurrency":"USD"}}`;
const anchored = `<h2 class="cat-title">Lunch</h2>\n${row('Pasta', '13.00', ` data-sq-item="${ID}"`)}${row('Soup', '6.00', ` data-sq-item="${ID2}"`)}`;
const ldPasta = (type, offerType) => item('Pasta', '13.00', `,"identifier":"${ID}"`, type, offerType);
const ldSoup = item('Soup', '6.00', `,"identifier":"${ID2}"`);
const ctx = '"@context":"https://schema.org"';
const GOOD = anchored + LD(`{${ctx},"@graph":[${ldPasta()},${ldSoup}]}`);

// A scratch tree: <dir>/catalog.json, <dir>/site/menu.html, <dir>/snap.json (not yet written).
function tree(name, page = GOOD, catalog = PLAIN) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pricelock-a1116-${name}-`));
  const t = { dir, site: path.join(dir, 'site'), catalog: path.join(dir, 'catalog.json'), snapshot: path.join(dir, 'snap.json') };
  fs.mkdirSync(t.site);
  t.page = path.join(t.site, 'menu.html');
  fs.writeFileSync(t.page, page);
  fs.writeFileSync(t.catalog, JSON.stringify(catalog));
  t.run = (mode, over = {}, ...extra) => spawnSync(process.execPath,
    [BIN, mode, '--src', over.src || t.catalog, '--site', over.site || t.site, '--snapshot', over.snapshot || t.snapshot, ...extra],
    { encoding: 'utf8', timeout: 30000, cwd: over.cwd || ROOT });
  t.read = () => fs.readFileSync(t.page, 'utf8');
  return t;
}
function refused(name, page, why, catalog = PLAIN) {
  const t = tree(name, page, catalog);
  const r = t.run('--write');
  assert.equal(r.status, 1, `expected a refusal; got exit ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, why);
  assert.equal(t.read(), page, 'nothing written');
  assert.equal(fs.existsSync(t.snapshot), false, 'no snapshot written');
  return t;
}
function bakes(name, page, catalog = PLAIN) {
  const t = tree(name, page, catalog);
  const r = t.run('--write');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.run('--check').status, 0);
  return t;
}

test('control: the anchored scratch page bakes, is byte-identical, and a second bake changes nothing', () => {
  const t = bakes('base', GOOD);
  assert.equal(t.read(), GOOD);
  const snap = fs.readFileSync(t.snapshot, 'utf8');
  assert.equal(t.run('--write').status, 0);
  assert.equal(t.read(), GOOD, 'idempotent page');
  assert.equal(fs.readFileSync(t.snapshot, 'utf8'), snap, 'deterministic snapshot');
});

// ── G1. --snapshot must never replace an input ───────────────────────────────
// On v1.5.0 every one of these exited 0 and replaced the catalog (or the page) with a
// snapshot. Refused now (usage error, exit 2) in --write AND --check, before anything is read
// into a write; the would-be victim is byte-identical afterwards.
function collides(name, pick, mode = '--write') {
  const t = tree(name);
  const { snapshot, victim, cwd } = pick(t);
  const before = victim && fs.existsSync(victim) ? fs.readFileSync(victim) : null;
  const pageBefore = t.read();
  const r = t.run(mode, { snapshot, cwd });
  assert.equal(r.status, 2, `expected exit 2; got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /--snapshot/);
  if (before) assert.deepEqual(fs.readFileSync(victim), before, 'the colliding file is untouched');
  assert.equal(t.read(), pageBefore, 'the page is untouched');
  return t;
}
test('G1: --snapshot equal to --src is refused; the catalog is untouched', () => {
  collides('same-src', t => ({ snapshot: t.catalog, victim: t.catalog }));
  collides('same-src-check', t => ({ snapshot: t.catalog, victim: t.catalog }), '--check');
});
test('G1: --snapshot reaching --src through a path alias, a relative path, a symlink or a hard link is refused', () => {
  collides('alias', t => ({ snapshot: path.join(t.site, '..', 'catalog.json'), victim: t.catalog }));
  collides('relative', t => ({ snapshot: 'catalog.json', victim: t.catalog, cwd: t.dir }));
  collides('symlink', t => { const l = path.join(t.dir, 'link.json'); fs.symlinkSync(t.catalog, l); return { snapshot: l, victim: t.catalog }; });
  collides('hardlink', t => { const l = path.join(t.dir, 'hard.json'); fs.linkSync(t.catalog, l); return { snapshot: l, victim: t.catalog }; });
});
test('G1: --snapshot naming a page of the site — existing, new, or nested — is refused', () => {
  collides('page', t => ({ snapshot: t.page, victim: t.page }));
  const t = collides('new-page', x => ({ snapshot: path.join(x.site, 'prices.html') }));
  assert.equal(fs.existsSync(path.join(t.site, 'prices.html')), false, 'no page was created');
  collides('nested-page', x => { fs.mkdirSync(path.join(x.site, 'menus')); return { snapshot: path.join(x.site, 'menus', 'x.html') }; });
  collides('page-symlink', x => { const l = path.join(x.dir, 'p.json'); fs.symlinkSync(x.page, l); return { snapshot: l, victim: x.page }; });
});
test('G1: --snapshot naming a directory is refused', () => {
  collides('dir', t => ({ snapshot: t.site }));
});
test('G1 control: a snapshot beside the catalog, inside the site as .json, or not yet existing still works', () => {
  for (const pick of [t => t.snapshot, t => path.join(t.site, 'prices.snapshot.json'), t => path.join(t.dir, 'out.json')]) {
    const t = tree('legit');
    const snapshot = pick(t);
    assert.equal(t.run('--write', { snapshot }).status, 0);
    assert.equal(t.run('--check', { snapshot }).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(snapshot, 'utf8')).items[ID].amountMinor, 1300);
    assert.equal(JSON.parse(fs.readFileSync(t.catalog, 'utf8')).menu.length, 1, 'catalog intact');
  }
});

// ── G2. Square: present_at_all_locations defaults to TRUE when unspecified ───
// developer.squareup.com/reference/square/objects/CatalogObject. v1.5.0 read an omitted flag
// as false and dropped the object as "not present".
const L = 'LDEVON0000000001', OTHER = 'LTRUCK0000000001';
const VID = 'VARCHAI00000000000000001', IID = 'ITEMCHAI0000000000000001';
const sq = (itemAvail = {}, varAvail = {}) => [{ type: 'ITEM', id: IID, ...itemAvail, item_data: { name: 'Chai', variations: [
  { type: 'ITEM_VARIATION', id: VID, ...varAvail, item_variation_data: { name: 'Regular', pricing_type: 'FIXED_PRICING', price_money: { amount: 300, currency: 'USD' } } }] } }];
const emitted = (i, v) => { const { feed, skipped } = squareToFeed(sq(i, v), { locationId: L }); return { ids: feed.menu.flatMap(s => s.items.map(x => x.id)), skipped }; };
const present = (i, v) => assert.deepEqual(emitted(i, v).ids, [VID]);
const absent = (i, v) => { const r = emitted(i, v); assert.deepEqual(r.ids, []); assert.equal(r.skipped.length, 1, 'reported, not silently dropped'); assert.match(r.skipped[0].why, /not present|both/); };

test('G2: an object with no present_at_all_locations is present (Square default: true)', () => {
  present({}, {});
  present({ present_at_all_locations: null }, { present_at_all_locations: null });
  present({ present_at_all_locations: true }, {});
  present({}, { present_at_all_locations: true });
});
test('G2: the default still honours absent_at_location_ids, at item and variation level', () => {
  absent({ absent_at_location_ids: [L] }, {});
  absent({}, { absent_at_location_ids: [L] });
  present({ absent_at_location_ids: [OTHER] }, { absent_at_location_ids: [OTHER] });
});
test('G2 control: explicit true / false and the inclusion / exclusion lists', () => {
  present({ present_at_all_locations: true }, { present_at_all_locations: true });
  absent({ present_at_all_locations: true, absent_at_location_ids: [L] }, {});
  absent({ present_at_all_locations: false }, {});
  absent({ present_at_all_locations: false, present_at_location_ids: [OTHER] }, {});
  present({ present_at_all_locations: false, present_at_location_ids: [L] }, { present_at_all_locations: false, present_at_location_ids: [L, OTHER] });
  absent({ present_at_all_locations: true }, { present_at_all_locations: false });
  absent({ present_at_all_locations: true }, { present_at_all_locations: false, present_at_location_ids: [OTHER] });
});
test('G2: a location listed as both present and absent is absent (never emitted), and reported', () => {
  absent({ present_at_all_locations: false, present_at_location_ids: [L], absent_at_location_ids: [L] }, {});
  absent({}, { present_at_location_ids: [L], absent_at_location_ids: [L] });
});
test('G2: malformed availability data is refused, not guessed', () => {
  for (const bad of [{ present_at_all_locations: 'true' }, { present_at_all_locations: 1 }, { present_at_location_ids: L },
    { absent_at_location_ids: { [L]: true } }, { present_at_all_locations: false, present_at_location_ids: [''] }, { absent_at_location_ids: [null] }]) {
    assert.throws(() => squareToFeed(sq(bad, {}), { locationId: L }), /availability|location/i, JSON.stringify(bad));
    assert.throws(() => squareToFeed(sq({}, bad), { locationId: L }), /availability|location/i, JSON.stringify(bad));
  }
  assert.throws(() => squareToFeed(sq(), { locationId: '' }), /locationId/);
});

// ── G3. vocabulary: a managed type is a schema.org type, under a schema.org context ──
// v1.5.0 matched any "@type" ENDING in /MenuItem, :MenuItem or #MenuItem, and read a block
// with no "@context" at all.
const graph = (...items) => anchored + LD(`{${ctx},"@graph":[${items.join(',')}]}`);
test('G3: a MenuItem or Offer "@type" from another vocabulary is refused by the baker and the parity extractor', () => {
  for (const [type, offerType] of [
    ['https://unrelated.example/MenuItem'], ['http://schema.org.evil.example/MenuItem'], ['ex:MenuItem'], ['#MenuItem'],
    ['https://schema.org/MenuItem#x'], ['MenuItem', 'https://unrelated.example/Offer'], ['MenuItem', 'ex:Offer']]) {
    const page = graph(ldPasta(type, offerType), ldSoup);
    refused('g3-type', page, /"@type"/);
    assert.throws(() => jsonLdPrices(page), /"@type"/, `${type} / ${offerType}`);
  }
});
test('G3: a foreign "@type" inside an array of types is refused too', () => {
  const page = anchored + LD(`{${ctx},"@graph":[{"@type":["Thing","https://unrelated.example/MenuItem"],"name":"Pasta","identifier":"${ID}","offers":{"@type":"Offer","price":"13.00","priceCurrency":"USD"}},${ldSoup}]}`);
  refused('g3-type-array', page, /"@type"/);
});
// G3b (not changed, held for an owner ruling): a block with no "@context" is still read.
// Requiring one was drafted and withdrawn — it reverses a decision merged on 2026-11-14
// ("no @context at all still bake"), and the prices in such a block are checked all the same.
// This control pins the current behaviour so a change to it is deliberate.
test('G3b control: a block with no "@context" is still baked and still checked', () => {
  const page = anchored + LD(`{"@graph":[${ldPasta()},${ldSoup}]}`);
  assert.equal(bakes('g3-noctx', page).read(), page);
  const stale = page.replace('"price":"13.00"', '"price":"1.00"');
  const t = tree('g3-noctx-stale', stale);
  assert.equal(t.run('--check').status, 1, 'a stale price in a context-less block still fails --check');
});
test('G3 control: every supported schema.org spelling of the type and the context still bakes byte-identically', () => {
  for (const type of ['MenuItem', 'schema:MenuItem', 'https://schema.org/MenuItem', 'http://schema.org/MenuItem']) {
    const page = graph(ldPasta(type, type.replace('MenuItem', 'Offer')), ldSoup);
    assert.equal(bakes('g3-ok-type', page).read(), page, type);
    assert.deepEqual(jsonLdPrices(page).map(x => x.id), [ID, ID2]);
  }
  for (const c of ['https://schema.org', 'http://schema.org', 'https://schema.org/']) {
    const page = anchored + LD(`{"@context":"${c}","@graph":[${ldPasta()},${ldSoup}]}`);
    assert.equal(bakes('g3-ok-ctx', page).read(), page, c);
  }
  // a block with no MenuItem (an Organization) needs no context of ours
  const page = GOOD + LD('{"@type":"Organization","name":"Demo Eatery"}');
  assert.equal(bakes('g3-ok-other', page).read(), page);
});

// ── G4. a priced menu row the catalog does not know is unread, not "left alone" ──
// v1.5.0: a row in the menu's own markup whose name is not in the catalog was skipped on
// both surfaces — and hidden from the unread-price report — so `--check` (strict) exited 0
// with any price on it, and the two surfaces could disagree.
const ldPage = (...extra) => LD(`{${ctx},"@graph":[${[ldPasta(), ldSoup, ...extra].join(',')}]}`);
test('G4: an unknown visible row with a price is refused in strict mode', () => {
  refused('g4-vis', anchored + row('Mystery Soup', '99.00') + ldPage(), /"Mystery Soup".*not in the catalog/s);
});
test('G4: an unknown JSON-LD MenuItem with a price is refused in strict mode', () => {
  refused('g4-ld', anchored + ldPage(item('Mystery Soup', '99.00')), /"Mystery Soup".*not in the catalog/s);
});
test('G4: an unknown item whose two surfaces disagree is refused, and both are named', () => {
  const t = refused('g4-both', anchored + row('Mystery Soup', '99.00') + ldPage(item('Mystery Soup', '1.00')), /2 price-like/);
  const r = t.run('--check');
  assert.equal(r.status, 1, '--check refuses it as well');
  assert.equal((r.stderr.match(/"Mystery Soup"/g) || []).length, 2);
});
test('G4: a variable-priced catalog item printed with a price is refused (the catalog cannot back it)', () => {
  const cat = { schemaVersion: 2, currency: 'USD', menu: [{ name: 'Lunch', items: [...PLAIN.menu[0].items, { id: 'CATCH000000000000000003', name: 'Catch of the Day', pricing: 'VARIABLE' }] }] };
  refused('g4-variable', anchored + row('Catch of the Day', '24.00') + ldPage(), /"Catch of the Day".*not in the catalog/s, cat);
});
test('G4: --allow-unread is the explicit opt-out — the row is reported, left byte-identical, and never enters the snapshot', () => {
  const page = anchored + row('Mystery Soup', '99.00') + ldPage(item('Mystery Soup', '1.00'));
  const t = tree('g4-allow', page);
  const r = t.run('--write', {}, '--allow-unread');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN.*"Mystery Soup".*not in the catalog/s);
  assert.equal(t.read(), page);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(t.snapshot, 'utf8')).items).sort(), [ID, ID2].sort());
  assert.equal(t.run('--check').status, 1, 'strict --check still refuses the same tree');
});
test('G4 control: an unknown MenuItem that carries no price is still left alone', () => {
  const page = anchored + ldPage('{"@type":"MenuItem","name":"Seasonal Special"}');
  assert.equal(bakes('g4-noprice', page).read(), page);
});
test('G4 control: a zero-price item is a price, baked as $0.00 on both surfaces', () => {
  const cat = { schemaVersion: 2, currency: 'USD', menu: [{ name: 'Lunch', items: [{ id: ID, name: 'Pasta', amountMinor: 0 }, PLAIN.menu[0].items[1]] }] };
  const t = bakes('g4-zero', GOOD, cat);
  assert.match(t.read(), new RegExp(`data-sq-item="${ID}">\\$0\\.00<`));
  assert.equal(jsonLdPrices(t.read()).find(x => x.id === ID).price, '0.00');
});
