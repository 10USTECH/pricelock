// test/square.test.js — the Square adapter (lib/square.mjs, bin/square-to-feed.mjs) on a
// recorded-shape fixture. No network, no token: --input runs the CLI fully offline, and
// the pure transform is exercised directly. The fixture covers the cases that bite:
// same-name twins, a per-location price override, multi-variation items, variable pricing,
// deleted/archived/absent objects, and ids/currencies the feed must refuse.
//
// Run with: node --test   (from the repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { squareToFeed } from '../lib/square.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'square-to-feed.mjs');
const BAKER = path.join(ROOT, 'bin', 'bake-prices.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'square', 'search-response.json');
const page = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const DEVON = 'LDEVON0000000001', TRUCK = 'LTRUCK0000000001';
const flat = feed => Object.fromEntries(feed.menu.flatMap(s => s.items.map(i => [i.id, { ...i, section: s.name }])));
const run = (...a) => spawnSync(process.execPath, [BIN, ...a], { encoding: 'utf8', timeout: 30000, env: { ...process.env, SQUARE_ACCESS_TOKEN: '' } });

test('ids are VARIATION ids; twins with the same name keep distinct ids and prices', () => {
  const { feed } = squareToFeed(page(), { locationId: DEVON });
  const f = flat(feed);
  assert.equal(f.VARHSLUNCH000000000000001.amountMinor, 1200);
  assert.equal(f.VARHSLUNCH000000000000001.section, 'Lunch');
  assert.equal(f.VARHSDINNER00000000000002.amountMinor, 1600);
  assert.equal(f.VARHSDINNER00000000000002.section, 'Dinner');
  assert.equal(f.VARHSLUNCH000000000000001.name, f.VARHSDINNER00000000000002.name);
  assert.ok(!('ITEMHSLUNCH00000000000001' in f), 'parent item ids are never feed ids');
});

test('a location override applies only at that location', () => {
  const devon = flat(squareToFeed(page(), { locationId: DEVON }).feed);
  const truck = flat(squareToFeed(page(), { locationId: TRUCK }).feed);
  assert.equal(devon.VARHSLUNCH000000000000001.amountMinor, 1200);
  assert.equal(truck.VARHSLUNCH000000000000001.amountMinor, 1100);
  assert.ok(!('VARTRUCKONLY0000000000010' in devon));
  assert.equal(truck.VARTRUCKONLY0000000000010.amountMinor, 800);
  assert.equal(truck.VARTRUCKONLY0000000000010.section, 'Uncategorized');
});

test('multi-variation items are named "Item (Variation)" in ordinal order; a lone default variation keeps the item name', () => {
  const { feed } = squareToFeed(page(), { locationId: DEVON });
  const dinner = feed.menu.find(s => s.name === 'Dinner').items.map(i => i.name);
  assert.deepEqual(dinner, ['House Salad', 'Chicken Biryani (Full)', 'Chicken Biryani (Half)', 'Market Fish']);
});

test('variable pricing is emitted without amountMinor; deleted, archived and absent objects are skipped with a reason', () => {
  const { feed, skipped } = squareToFeed(page(), { locationId: DEVON });
  const f = flat(feed);
  assert.equal(f.VARMARKETFISH000000000008.pricing, 'VARIABLE');
  assert.ok(!('amountMinor' in f.VARMARKETFISH000000000008));
  const why = Object.fromEntries(skipped.map(s => [s.id, s.why]));
  assert.equal(why.VARBIRYANIOLD0000000000006, 'deleted');
  assert.equal(why.ITEMARCHIVED000000000011, 'archived');
  assert.match(why.ITEMNOTHERE00000000000013, /not present at LDEVON/);
  assert.match(why.ITEMTRUCKONLY000000000009, /not present at LDEVON/);
  assert.ok(!('VARARCHIVED00000000000012' in f) && !('VARNOTHERE000000000000014' in f));
});

test('cachedAt is the catalog\'s latest updated_at (deterministic), null when none is present', () => {
  assert.equal(squareToFeed(page(), { locationId: DEVON }).feed.cachedAt, null);
  const p = page();
  p.objects[3].updated_at = '2026-03-01T00:00:00Z';
  p.objects[3].item_data.variations[0].updated_at = '2026-05-01T00:00:00Z';
  p.objects[4].updated_at = '2026-04-01T00:00:00Z';
  assert.equal(squareToFeed(p, { locationId: DEVON }).feed.cachedAt, '2026-05-01T00:00:00Z');
  assert.equal(squareToFeed(p, { locationId: DEVON }).feed.cachedAt, squareToFeed(p, { locationId: DEVON }).feed.cachedAt);
});

test('a foreign currency, a bad variation id, or a variation seen twice is refused', () => {
  let p = page();
  p.objects[4].item_data.variations[0].item_variation_data.price_money.currency = 'CAD';
  assert.throws(() => squareToFeed(p, { locationId: DEVON }), /priced in CAD, feed currency is USD/);
  p = page();
  p.objects[4].item_data.variations[0].id = 'short<script>';
  assert.throws(() => squareToFeed(p, { locationId: DEVON }), /does not match .* refusing to emit/);
  p = page();
  assert.throws(() => squareToFeed([p, p], { locationId: DEVON }), /appears twice/);
});

test('several pages and related_objects are merged', () => {
  const p = page();
  const cats = { objects: p.objects.filter(o => o.type === 'CATEGORY') };
  const items = { objects: p.objects.filter(o => o.type === 'ITEM').slice(0, 2), related_objects: p.objects.filter(o => o.type === 'ITEM').slice(2) };
  const f = flat(squareToFeed([cats, items], { locationId: DEVON }).feed);
  assert.equal(f.VARHSLUNCH000000000000001.section, 'Lunch');
  assert.equal(f.VARBIRYANIFULL000000000005.amountMinor, 1699);
});

test('CLI: --input is fully offline, reports SKIPs on stderr, and the feed bakes end-to-end into a v2 snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelock-square-'));
  const feedPath = path.join(dir, 'feed.json');
  const r = run('--location', DEVON, '--input', FIXTURE, '--out', feedPath);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /SKIP: ITEMARCHIVED000000000011/);
  assert.match(r.stderr, /priced=4 variable=1 skipped=4/);
  assert.equal(r.stdout, '', 'nothing on stdout when --out is given');
  const feed = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
  assert.equal(feed.schemaVersion, 2);

  const site = path.join(dir, 'site'); fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, 'menu.html'),
    '<h2 class="cat-title">Lunch</h2>\n<h3 class="item-name">House Salad</h3><div class="item-price">$1.00</div>\n'
    + '<h2 class="cat-title">Dinner</h2>\n<h3 class="item-name">House Salad</h3><div class="item-price">$1.00</div>\n'
    + '<h3 class="item-name">Chicken Biryani (Half)</h3><div class="item-price">$1.00</div>\n'
    + '<script type="application/ld+json">{"@type":"MenuItem","name":"Chicken Biryani (Half)","offers":{"@type":"Offer","price":"1.00","priceCurrency":"USD"}}</script>\n');
  const snap = path.join(dir, 'snap.json');
  const b = spawnSync(process.execPath, [BAKER, '--write', '--src', feedPath, '--site', site, '--snapshot', snap], { encoding: 'utf8', timeout: 30000 });
  assert.equal(b.status, 0, b.stderr);
  const html = fs.readFileSync(path.join(site, 'menu.html'), 'utf8');
  assert.match(html, /data-sq-item="VARHSLUNCH000000000000001">\$12\.00</);
  assert.match(html, /data-sq-item="VARHSDINNER00000000000002">\$16\.00</);
  assert.match(html, /data-sq-item="VARBIRYANIHALF000000000004">\$9\.99</);
  assert.match(html, /"identifier": "VARBIRYANIHALF000000000004".*"price":"9\.99"/);
  const s = JSON.parse(fs.readFileSync(snap, 'utf8'));
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.locationId, DEVON);
  assert.equal(s.items.VARBIRYANIHALF000000000004.amountMinor, 999);
  // Re-check is clean, and a re-generated feed from the same input is byte-identical.
  const c = spawnSync(process.execPath, [BAKER, '--check', '--src', feedPath, '--site', site, '--snapshot', snap], { encoding: 'utf8', timeout: 30000 });
  assert.equal(c.status, 0, c.stderr);
  const again = run('--location', DEVON, '--input', FIXTURE);
  assert.equal(again.stdout, fs.readFileSync(feedPath, 'utf8'));
});

test('CLI: no token and no --input is a clean FAIL that names neither flag values nor secrets', () => {
  const r = run('--location', DEVON);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SQUARE_ACCESS_TOKEN is not set/);
  assert.doesNotMatch(r.stderr, /Bearer/);
});

test('CLI: --location is required and shape-checked', () => {
  assert.equal(run('--input', FIXTURE).status, 2);
  assert.equal(run('--location', 'nope', '--input', FIXTURE).status, 2);
});
