// test/parity.test.js — the offline three-way consistency check.
//
// Proves, with NO catalog and NO network, that for every price on the site the three
// surfaces agree: the visible node (data-sq-item), the JSON-LD MenuItem (identifier),
// and the committed snapshot. Editing any one price without resealing the snapshot fails
// this check. It is NOT a seal: whoever edits a price can reseal it (change the catalog
// and run --write, or edit all three surfaces). Only `bake-prices --check` ties the site
// back to the catalog feed. See README.md "Known limits".
//
// Run with: node --test   (from the repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visiblePrices, jsonLdPrices } from '../lib/extract.mjs';
import { centsToText } from '../lib/guards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'demo', 'site');
const SNAPSHOT = path.join(ROOT, 'demo', 'prices.snapshot.json');

const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
const items = snapshot.items || {};
// Every .html under the site, subfolders included (the baker reads the same set).
const htmlFiles = fs.readdirSync(SITE, { recursive: true }).map(String).filter(f => f.endsWith('.html')).sort();

// id -> "12.00" (the snapshot stores integer cents; no float is formatted)
const snapPrice = id => (items[id] ? centsToText(items[id].amountMinor) : undefined);

test('snapshot is non-empty, v2, and every amount is an integer', () => {
  assert.ok(Object.keys(items).length > 0, 'snapshot has no items — run: node bin/bake-prices.mjs --write');
  assert.equal(snapshot.schemaVersion, 2, 'snapshot must be schemaVersion 2 — re-run --write');
  assert.equal(snapshot.currency, 'USD');
  for (const [id, v] of Object.entries(items)) assert.ok(Number.isInteger(v.amountMinor), `${id}: amountMinor must be an integer`);
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

test('every snapshot id has BOTH a visible node and a JSON-LD entry somewhere on the site', () => {
  // A price that exists on only one surface cannot be cross-checked, so an id that is
  // visible but absent from JSON-LD (or the reverse) is a gap in the check, not a pass.
  const seenVisible = new Set(), seenLd = new Set();
  for (const f of htmlFiles) {
    const html = fs.readFileSync(path.join(SITE, f), 'utf8');
    for (const { id } of visiblePrices(html)) seenVisible.add(id);
    for (const { id } of jsonLdPrices(html)) seenLd.add(id);
  }
  for (const id of Object.keys(items)) {
    assert.ok(seenVisible.has(id), `snapshot id ${id} (${items[id].name}) has no visible price node on any page`);
    assert.ok(seenLd.has(id), `snapshot id ${id} (${items[id].name}) has no JSON-LD MenuItem on any page`);
  }
});

test('the two same-named twins keep distinct prices (the collision that name-keying breaks)', () => {
  // Both "House Salad" objects must survive with their own price. A name-keyed map would
  // have collapsed them to one; id-keying keeps both.
  const named = Object.entries(items).filter(([, v]) => v.name === 'House Salad').map(([id, v]) => ({ id, price: v.amountMinor }));
  assert.equal(named.length, 2, 'expected two distinct House Salad ids in the snapshot');
  assert.notEqual(named[0].price, named[1].price, 'the twins must hold different prices');
});
