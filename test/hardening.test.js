// test/hardening.test.js — regression tests from the October 2026 independent audit.
//
// Each test reproduces a defect that was confirmed against main@d821d9b before the fix
// (the finding number matches docs/AUDIT-2026-10.md). Every CLI case builds its page and
// catalog in a temp dir; nothing here touches the repo or the network.
//
// Run with: node --test   (from the repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'bake-prices.mjs');
const guards = () => import('../lib/guards.mjs');
const extract = () => import('../lib/extract.mjs');

const ID = 'PASTA0000000000000000001';
const catalog = (items, extra = []) => ({ menu: [{ name: 'Lunch', items }, ...extra] });

// A scratch site: { site, snapshot, catalog } plus run(mode, ...flags) and read().
function scratch(name, pages, cat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pricelock-h-${name}-`));
  const site = path.join(dir, 'site');
  fs.mkdirSync(site);
  for (const [f, html] of Object.entries(pages)) {
    fs.mkdirSync(path.dirname(path.join(site, f)), { recursive: true });
    fs.writeFileSync(path.join(site, f), html);
  }
  const t = { dir, site, snapshot: path.join(dir, 'snap.json'), catalog: path.join(dir, 'catalog.json') };
  fs.writeFileSync(t.catalog, JSON.stringify(cat));
  t.run = (mode, ...flags) => spawnSync(process.execPath, [BIN, mode, ...flags, '--src', t.catalog, '--site', t.site, '--snapshot', t.snapshot],
    { encoding: 'utf8', timeout: 30000 });
  t.read = f => fs.readFileSync(path.join(t.site, f), 'utf8');
  return t;
}

const VISIBLE = (price = '12.00', attrs = '') =>
  `<h2 class="cat-title">Lunch</h2>\n<h3 class="item-name">Pasta</h3><div class="item-price"${attrs}>$${price}</div>\n`;
const LD = body => `<script type="application/ld+json">${body}</script>\n`;

// ── F1. duplicate feed id, different prices ──────────────────────────────────
test('F1: the same feed id with two prices is refused (not last-wins into HTML vs snapshot)', () => {
  const t = scratch('dup-id', { 'menu.html': VISIBLE() + LD(`{"@type":"MenuItem","name":"Pasta","offers":{"@type":"Offer","price":"12.00"}}`) },
    catalog([{ id: ID, name: 'Pasta', price: 12 }], [{ name: 'Dinner', items: [{ id: ID, name: 'Pasta', price: 15 }] }]));
  const before = t.read('menu.html');
  const r = t.run('--write');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /appears more than once with different data/);
  assert.match(r.stderr, /\$12\.00 \(Lunch\) vs "Pasta" \$15\.00 \(Dinner\)/);
  assert.equal(t.read('menu.html'), before, 'nothing may be written');
  assert.equal(fs.existsSync(t.snapshot), false);
});

test('F1: the same feed id listed twice with identical name and price is one record', () => {
  const t = scratch('dup-same', { 'menu.html': VISIBLE('11.00') },
    catalog([{ id: ID, name: 'Pasta', price: 12 }], [{ name: 'Dinner', items: [{ id: ID, name: 'Pasta', price: 12 }] }]));
  const r = t.run('--write');
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.read('menu.html'), new RegExp(`data-sq-item="${ID}">\\$12\\.00<`));
  assert.match(r.stdout, /catalog items=1 /);
});

// ── F2. prices toFixed(2) cannot render faithfully ──────────────────────────
for (const [price, why] of [[-3, 'negative'], [1e21, '>= 1000000000'], [12.005, 'not a whole number of cents'], [Infinity, 'not a finite number']]) {
  test(`F2: feed price ${price} is refused as ${why}`, async () => {
    const { validateFeedPrice } = await guards();
    assert.throws(() => validateFeedPrice(price, ID), new RegExp(why));
  });
}
test('F2: 0, 0.5, 12, 12.1 and 1000 are accepted', async () => {
  const { validateFeedPrice } = await guards();
  for (const p of [0, 0.5, 12, 12.1, 1000, 999999999.99]) assert.equal(validateFeedPrice(p, ID), p);
});
test('F2: a negative price in the feed stops the bake; "$-3.00" never reaches HTML', () => {
  const t = scratch('neg', { 'menu.html': VISIBLE('1.00') }, catalog([{ id: ID, name: 'Pasta', price: -3 }]));
  const r = t.run('--write');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /feed price -3 for PASTA0000000000000000001 is negative/);
  assert.doesNotMatch(t.read('menu.html'), /-3/);
});

// ── F3. JSON-LD shapes the text transform cannot handle ─────────────────────
test('F3a: a MenuItem whose "identifier" follows "offers" is refused (no duplicate identifier key)', () => {
  const page = LD(`{"@type":"MenuItem","name":"Pasta","offers":{"@type":"Offer","price":"12.00"},"identifier":"${ID}"}`);
  const t = scratch('id-after', { 'menu.html': page }, catalog([{ id: ID, name: 'Pasta', price: 13 }]));
  const r = t.run('--write');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /lists "identifier" after "offers"/);
  assert.equal((t.read('menu.html').match(/"identifier"/g) || []).length, 1, 'exactly one identifier key, untouched');
});

test('F3b: MenuItem text outside an ld+json script (a <pre> sample) is refused, not baked', () => {
  const page = `<pre>{"@type":"MenuItem","name":"Pasta","offers":{"@type":"Offer","price":"12.00"}}</pre>\n`;
  const t = scratch('pre', { 'menu.html': page }, catalog([{ id: ID, name: 'Pasta', price: 13 }]));
  const r = t.run('--write');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /menu\.html:1: MenuItem markup outside a <script type="application\/ld\+json"> block/);
  assert.equal(t.read('menu.html'), page);
});

test('F3c: an ld+json block with MenuItem text that is not valid JSON is refused', () => {
  const page = LD(`{"@type":"MenuItem","name":"Pasta","offers":{"@type":"Offer","price":"12.00"},}`);
  const t = scratch('badjson', { 'menu.html': page }, catalog([{ id: ID, name: 'Pasta', price: 13 }]));
  const r = t.run('--write');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /containing MenuItem is not valid JSON/);
  assert.equal(t.read('menu.html'), page);
});

test('F3: a well-formed block with identifier before offers, and a script tag with extra attributes, still bakes', () => {
  const page = `<script id="menu" type='application/ld+json' data-x="1">\n{"@type":"MenuItem","name":"Pasta","identifier":"${ID}","offers":{"@type":"Offer","price":"12.00"}}\n</script>\n`;
  const t = scratch('ok-ld', { 'menu.html': page }, catalog([{ id: ID, name: 'Pasta', price: 13 }]));
  const r = t.run('--write');
  assert.equal(r.status, 0, r.stderr);
  assert.match(t.read('menu.html'), /"price":"13\.00"/);
});

// ── F4. an anchor attribute the baker cannot read exactly ────────────────────
test("F4: data-sq-item='…' (single quotes) is refused rather than doubled", () => {
  const t = scratch('squote', { 'menu.html': VISIBLE('12.00', ` data-sq-item='${ID}'`) }, catalog([{ id: ID, name: 'Pasta', price: 13 }]));
  const before = t.read('menu.html');
  const r = t.run('--write');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /data-sq-item must appear exactly once as data-sq-item="…"/);
  assert.equal(t.read('menu.html'), before);
  assert.equal((before.match(/data-sq-item/g) || []).length, 1);
});

test('F4: two data-sq-item attributes on one node are refused', () => {
  const t = scratch('twice', { 'menu.html': VISIBLE('12.00', ` data-sq-item="${ID}" data-sq-item="${ID}"`) }, catalog([{ id: ID, name: 'Pasta', price: 13 }]));
  const r = t.run('--check');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /data-sq-item must appear exactly once/);
});

// ── F5. --strict: unread price-like markup is an error ───────────────────────
test('F5: without --strict, an unanchored <span>$12.00</span> whose id lives in JSON-LD passes --check with only a WARN (documented)', () => {
  const page = `<span class="price">$12.00</span>\n` + LD(`{"@type":"MenuItem","name":"Pasta","identifier":"${ID}","offers":{"@type":"Offer","price":"13.00"}}`);
  const t = scratch('strict-off', { 'menu.html': page }, catalog([{ id: ID, name: 'Pasta', price: 13 }]));
  assert.equal(t.run('--write').status, 0);
  const r = t.run('--check');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARN: menu\.html:1/);
});

test('F5: with --strict the same page fails --check and --write writes nothing', () => {
  const page = `<span class="price">$12.00</span>\n` + LD(`{"@type":"MenuItem","name":"Pasta","identifier":"${ID}","offers":{"@type":"Offer","price":"12.00"}}`);
  const t = scratch('strict-on', { 'menu.html': page }, catalog([{ id: ID, name: 'Pasta', price: 13 }]));
  let r = t.run('--check', '--strict');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /FAIL: menu\.html:1: .*refused \(--strict\)/);
  r = t.run('--write', '--strict');
  assert.equal(r.status, 1, r.stderr);
  assert.equal(t.read('menu.html'), page, 'nothing written under --strict');
  assert.equal(fs.existsSync(t.snapshot), false);
});

test('F5: --strict on the bundled demo passes (CI runs it)', () => {
  const r = spawnSync(process.execPath, [BIN, '--check', '--strict'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
});

// ── F6. parity extractor paired one item's id with the next item's price ────
test('F6: jsonLdPrices never reads a price from a later MenuItem', async () => {
  const { jsonLdPrices } = await extract();
  const html = `{"@type":"MenuItem","name":"Market Fish","identifier":"MARKETFISH00000000000001"},
{"@type":"MenuItem","name":"Soup","identifier":"SOUP00000000000000000001","offers":{"price":"9.00"}}`;
  assert.deepEqual(jsonLdPrices(html), [{ id: 'SOUP00000000000000000001', price: '9.00' }]);
});

test('F6: jsonLdPrices never reads an identifier from a later MenuItem', async () => {
  const { jsonLdPrices } = await extract();
  const html = `{"@type":"MenuItem","name":"A","offers":{"price":"1.00"}},
{"@type":"MenuItem","name":"B","identifier":"BBBBBBBBBBBBBBBBBBBB0001","offers":{"price":"2.00"}}`;
  assert.deepEqual(jsonLdPrices(html), [{ id: 'BBBBBBBBBBBBBBBBBBBB0001', price: '2.00' }]);
});

test('F6: the demo page still yields all four pairs', async () => {
  const { jsonLdPrices, visiblePrices } = await extract();
  const html = fs.readFileSync(path.join(ROOT, 'demo', 'site', 'menu.html'), 'utf8');
  assert.equal(jsonLdPrices(html).length, 4);
  assert.equal(visiblePrices(html).length, 4);
});

// ── F7. response body ceiling ────────────────────────────────────────────────
test('F7: a body past the byte ceiling rejects and destroys the stream', async () => {
  const { readBodyBounded } = await guards();
  const res = new PassThrough();
  const p = readBodyBounded(res, 100);
  res.write(Buffer.alloc(60));
  res.write(Buffer.alloc(60));
  await assert.rejects(p, /exceeds 100 bytes/);
  assert.equal(res.destroyed, true);
});

test('F7: a body under the ceiling resolves to its text', async () => {
  const { readBodyBounded } = await guards();
  const res = new PassThrough();
  const p = readBodyBounded(res, 100);
  res.end('{"menu":[]}');
  assert.equal(await p, '{"menu":[]}');
});

// ── F8. address blocklist gaps ───────────────────────────────────────────────
test('F8: reserved, documentation, multicast, NAT64, 6to4 and IPv4-compatible forms are blocked', async () => {
  const { isBlockedAddress, unmapIPv4 } = await guards();
  for (const a of ['224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '192.0.0.1', '192.0.2.1', '198.18.0.1',
    '198.51.100.7', '203.0.113.9', '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::1',
    '2002:c0a8:101::', '::7f00:1', '::127.0.0.1', '2001:db8::1', '100::1', 'ff02::1']) {
    assert.equal(isBlockedAddress(a), true, `${a} must be blocked`);
  }
  assert.equal(unmapIPv4('64:ff9b::808:808'), '8.8.8.8');
  assert.equal(unmapIPv4('2002:808:808::1'), '8.8.8.8');
  assert.equal(unmapIPv4('::808:808'), '8.8.8.8');
  for (const a of ['8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '2606:4700:4700::1111', '172.32.0.1']) {
    assert.equal(isBlockedAddress(a), false, `${a} must be allowed`);
  }
});

// ── F9. writes: atomic per file; symlinks refused ────────────────────────────
test('F9: writeFileAtomic leaves no temp file behind and replaces the target in full', async () => {
  const { writeFileAtomic } = await guards();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelock-atomic-'));
  const p = path.join(dir, 'page.html');
  fs.writeFileSync(p, 'old');
  writeFileAtomic(p, 'new content');
  assert.equal(fs.readFileSync(p, 'utf8'), 'new content');
  assert.deepEqual(fs.readdirSync(dir), ['page.html']);
});

test('F9: when the rename fails the temp file is removed and the target is untouched', async () => {
  const { writeFileAtomic } = await guards();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelock-atomic-'));
  const p = path.join(dir, 'page.html');
  fs.writeFileSync(p, 'old');
  const failing = { ...fs, renameSync: () => { throw new Error('EXDEV simulated'); } };
  assert.throws(() => writeFileAtomic(p, 'new', failing), /EXDEV simulated/);
  assert.equal(fs.readFileSync(p, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['page.html'], 'temp file must be cleaned up');
});

test('F9: a symlinked .html under --site is refused before anything is written', () => {
  const t = scratch('symlink', { 'menu.html': VISIBLE('12.00') }, catalog([{ id: ID, name: 'Pasta', price: 13 }]));
  const outside = path.join(t.dir, 'outside.html');
  fs.writeFileSync(outside, VISIBLE('12.00'));
  try { fs.symlinkSync(outside, path.join(t.site, 'link.html')); }
  catch (e) { if (e.code === 'EPERM') return; throw e; }   // no symlink privilege on this runner
  const r = t.run('--write');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /link\.html is a symbolic link — refused/);
  assert.match(t.read('menu.html'), /\$12\.00/, 'nothing written');
  assert.match(fs.readFileSync(outside, 'utf8'), /\$12\.00/);
});

// ── F10. unreadable or malformed --src file is a clean FAIL, not a stack trace ─
test('F10: a missing --src file exits 1 with a one-line message', () => {
  const t = scratch('nosrc', { 'menu.html': VISIBLE() }, catalog([]));
  fs.unlinkSync(t.catalog);
  const r = t.run('--check');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^bake-prices FAIL: cannot read --src/);
  assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/, 'no stack trace');
});
