// test/parity.test.js — the offline trust anchor.
//
// Proves, with NO catalog and NO network, that for every price on the site the three
// surfaces agree: the visible node (data-sq-item), the JSON-LD MenuItem (identifier),
// and the committed snapshot. Editing any one price without resealing the snapshot fails
// this gate — which is what makes the baked prices tamper-evident.
//
// Run with: node --test   (from the repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'demo', 'site');
const SNAPSHOT = path.join(ROOT, 'demo', 'prices.snapshot.json');

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
const items = snapshot.items || {};
const htmlFiles = fs.readdirSync(SITE).filter(f => f.endsWith('.html')).sort();

// id -> "12.00"
const snapPrice = id => (items[id] ? items[id].price.toFixed(2) : undefined);

// Pull every visible price node: data-sq-item="<id>" ...>$<price>
function visiblePrices(html) {
  const re = /data-sq-item="([A-Z0-9]{20,})"[^>]*>\s*\$([0-9]+\.[0-9]{2})/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ id: m[1], price: m[2] });
  return out;
}

// Pull every JSON-LD MenuItem price, bounded per item, keyed by its identifier.
function jsonLdPrices(html) {
  const re = /"@type":\s*"MenuItem"\s*,[\s\S]*?"identifier":\s*"([A-Z0-9]{20,})"[\s\S]*?"price":\s*"([0-9]+\.[0-9]{2})"/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push({ id: m[1], price: m[2] });
  return out;
}

test('snapshot is non-empty', () => {
  assert.ok(Object.keys(items).length > 0, 'snapshot has no items — run: node bin/bake-prices.mjs --write');
});

test('every visible price matches the snapshot', () => {
  let checked = 0;
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(SITE, f), 'utf8');
    for (const { id, price } of visiblePrices(html)) {
      const want = snapPrice(id);
      assert.ok(want !== undefined, `${f}: visible id ${id} is not in the snapshot`);
      assert.equal(price, want, `${f}: visible price $${price} for ${id} != snapshot $${want}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no visible price nodes found — is the site anchored?');
});

test('every JSON-LD price matches the snapshot', () => {
  let checked = 0;
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(SITE, f), 'utf8');
    for (const { id, price } of jsonLdPrices(html)) {
      const want = snapPrice(id);
      assert.ok(want !== undefined, `${f}: JSON-LD id ${id} is not in the snapshot`);
      assert.equal(price, want, `${f}: JSON-LD price $${price} for ${id} != snapshot $${want}`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no JSON-LD MenuItem prices found');
});

test('every snapshot id is used somewhere on the site', () => {
  const usedIds = new Set();
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(SITE, f), 'utf8');
    for (const { id } of visiblePrices(html)) usedIds.add(id);
    for (const { id } of jsonLdPrices(html)) usedIds.add(id);
  }
  for (const id of Object.keys(items)) {
    assert.ok(usedIds.has(id), `snapshot id ${id} (${items[id].name}) appears on no page — stale snapshot entry`);
  }
});

test('the two same-named twins keep distinct prices (the collision that name-keying breaks)', () => {
  // Both "Margherita" objects must survive with their own price. A name-keyed map would
  // have collapsed them to one; id-keying keeps both.
  const named = Object.entries(items).filter(([, v]) => v.name === 'Margherita').map(([id, v]) => ({ id, price: v.price }));
  assert.equal(named.length, 2, 'expected two distinct Margherita ids in the snapshot');
  assert.notEqual(named[0].price, named[1].price, 'the twins must hold different prices');
});
