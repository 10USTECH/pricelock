// test/baker.test.js — the baker's behaviour on the fixtures in test/fixtures/.
//
// Each case copies its fixture site into a temp dir, so --write never touches the repo.
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
const FIX = path.join(ROOT, 'test', 'fixtures');

function tmpSite(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pricelock-${name}-`));
  fs.cpSync(path.join(FIX, name, 'site'), path.join(dir, 'site'), { recursive: true });
  const t = { site: path.join(dir, 'site'), snapshot: path.join(dir, 'snap.json'), catalog: path.join(FIX, name, 'catalog.json') };
  t.run = mode => spawnSync(process.execPath, [BIN, mode, '--src', t.catalog, '--site', t.site, '--snapshot', t.snapshot],
    { encoding: 'utf8', timeout: 30000 });
  t.read = f => fs.readFileSync(path.join(t.site, f), 'utf8');
  return t;
}

test('drift: a changed catalog price fails --check, --write fixes it, then --check passes', () => {
  const t = tmpSite('drift');
  let r = t.run('--check');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /files that would change: menu\.html/);
  assert.match(t.read('menu.html'), /\$12\.00/, '--check must not write');

  r = t.run('--write');
  assert.equal(r.status, 0, r.stderr);
  const html = t.read('menu.html');
  assert.match(html, /data-sq-item="PASTA0000000000000000001">\$13\.00</);
  assert.match(html, /"price": "13\.00"/);
  assert.equal(JSON.parse(fs.readFileSync(t.snapshot, 'utf8')).items.PASTA0000000000000000001.price, 13);

  r = t.run('--check');
  assert.equal(r.status, 0, r.stderr);
});

test('ambiguous name: two same-named items and no tie-break fail closed; no file is written', () => {
  const t = tmpSite('ambiguous');
  const a = t.read('a.html'), b = t.read('b.html');
  const r = t.run('--write');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ambiguous node "Soup" @ \$6\.00 .* 2 candidates/);
  // a.html bakes cleanly on its own (12.00 -> 13.00) and comes first; fail-closed means it
  // must still be untouched when b.html fails.
  assert.equal(t.read('a.html'), a, 'a.html must be unchanged after a failure in b.html');
  assert.equal(t.read('b.html'), b);
  assert.equal(fs.existsSync(t.snapshot), false, 'no snapshot may be written');
});

test('missing id: a page anchored to an id the catalog no longer has fails closed', () => {
  const t = tmpSite('missing-id');
  const before = t.read('menu.html');
  const r = t.run('--write');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /anchored id RETIREDDISH0000000000001 .* is not in the catalog/);
  assert.equal(t.read('menu.html'), before);
});

test('thousands: $1,000.00 is read and written back grouped; ungrouped stays ungrouped; JSON-LD stays numeric', () => {
  const t = tmpSite('thousands');
  const r = t.run('--write');
  assert.equal(r.status, 0, r.stderr);
  const html = t.read('menu.html');
  assert.match(html, /data-sq-item="PLATTER00000000000000001">\$1,250\.00</);
  assert.match(html, /data-sq-item="TRAY00000000000000000001">\$1100\.00</);
  assert.match(html, /"identifier": "PLATTER00000000000000001",\s*"offers": \{ "@type": "Offer", "price": "1250\.00"/);
  assert.match(html, /"identifier": "TRAY00000000000000000001",\s*"offers": \{ "@type": "Offer", "price": "1100\.00"/);
});

test('subfolders: pages below --site are baked', () => {
  const t = tmpSite('subfolder');
  let r = t.run('--check');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /files that would change: menus\/dinner\.html/);
  r = t.run('--write');
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.read(path.join('menus', 'dinner.html')), /\$13\.00/);
});

test('unreadable price-like markup is a warning with file:line, not a failure', () => {
  const t = tmpSite('warn');
  const lines = t.read('menu.html').split('\n');
  const want = lines.findIndex(l => l.includes('Specials from $5.00')) + 1;
  const r = t.run('--check');
  assert.equal(r.status, 1, 'no snapshot yet, so --check still reports drift');
  assert.ok(r.stderr.includes(`bake-prices WARN: menu.html:${want}:`), `expected a warning at menu.html:${want}\n${r.stderr}`);
  const w = t.run('--write');
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stderr, /WARN/);
  assert.match(t.read('menu.html'), /Specials from \$5\.00/, 'the unread markup is left as is');
});
