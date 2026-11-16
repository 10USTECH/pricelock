// test/check-parity.test.js — the parity runner (bin/check-parity.mjs, lib/parity.mjs).
//
// test/parity.test.js proves the DEMO tree. A site that uses pricelock needs the same check
// against ITS tree and ITS snapshot; this is that check as a command, and these are its
// tests. The runner has no default paths: a run that names nothing verifies nothing and
// says so (exit 2), so a green demo can never stand in for a consumer's site.
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
import { checkParity } from '../lib/parity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'check-parity.mjs');
const DEMO = ['--site', path.join(ROOT, 'demo', 'site'), '--snapshot', path.join(ROOT, 'demo', 'prices.snapshot.json')];
const run = (args, cwd = os.tmpdir()) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 30000, cwd });

const A = 'PASTA0000000000000000001', B = 'SOUP00000000000000000002';
const SNAP = { schemaVersion: 2, source: 'catalog.json', cachedAt: null, locationId: null, currency: 'USD',
  items: { [A]: { name: 'Pasta', amountMinor: 1300 }, [B]: { name: 'Soup', amountMinor: 600 } } };
const vis = (id, price, name = 'x') => `<h3 class="item-name">${name}</h3><div class="item-price" data-sq-item="${id}">$${price}</div>\n`;
const ld = (...items) => `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[${items.join(',')}]}</script>\n`;
const mi = (id, price, cur = 'USD') => `{"@type":"MenuItem","name":"x","identifier":"${id}","offers":{"@type":"Offer","price":"${price}","priceCurrency":"${cur}"}}`;
const GOOD = vis(A, '13.00') + vis(B, '6.00') + ld(mi(A, '13.00'), mi(B, '6.00'));

// A scratch consumer tree: <dir>/public/<pages…>, <dir>/snap.json.
function prod(pages, snapshot = SNAP) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelock-parity-'));
  const site = path.join(dir, 'public');
  for (const [rel, html] of Object.entries(pages)) {
    fs.mkdirSync(path.dirname(path.join(site, rel)), { recursive: true });
    fs.writeFileSync(path.join(site, rel), html);
  }
  fs.mkdirSync(site, { recursive: true });
  const snap = path.join(dir, 'snap.json');
  fs.writeFileSync(snap, typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot));
  return { dir, site, snap, args: ['--site', site, '--snapshot', snap], run: (...extra) => run(['--site', site, '--snapshot', snap, ...extra]) };
}
const passes = (pages, snapshot, ...extra) => { const r = prod(pages, snapshot).run(...extra); assert.equal(r.status, 0, r.stdout + r.stderr); return r; };
const fails = (pages, why, snapshot, ...extra) => {
  const r = prod(pages, snapshot).run(...extra);
  assert.equal(r.status, 1, `expected exit 1; got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, why);
  assert.doesNotMatch(r.stdout, /check-parity: OK/);
  return r;
};

// ── it verifies what it is pointed at, and nothing by default ────────────────
test('no default paths: without --site and --snapshot the runner refuses (exit 2), from any directory', () => {
  for (const args of [[], ['--site', DEMO[1]], ['--snapshot', DEMO[3]], ['--site'], ['--site', DEMO[1], '--snapshot']]) {
    for (const cwd of [os.tmpdir(), ROOT]) {
      const r = run(args, cwd);
      assert.equal(r.status, 2, `${JSON.stringify(args)} in ${cwd}: ${r.stdout}${r.stderr}`);
      assert.doesNotMatch(r.stdout, /OK/);
    }
  }
  assert.match(run([]).stderr, /--site/);
  assert.match(run([]).stderr, /--snapshot/);
  assert.equal(run([...DEMO, '--bogus']).status, 2, 'an unknown flag is refused, not ignored');
});
test('the demo passes when named explicitly, and the report states exactly what was verified', () => {
  const r = run(DEMO);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(fs.realpathSync(DEMO[1])), 'the real site path is printed');
  assert.ok(r.stdout.includes(fs.realpathSync(DEMO[3])), 'the real snapshot path is printed');
  assert.match(r.stdout, /pages=1 ids=4 visible=4 jsonld=4 mode=per-page/);
  assert.match(r.stdout, /check-parity: OK/);
  assert.match(r.stdout, /bake-prices --check/, 'says what it does NOT prove');
});
test('a green demo does not vouch for a consumer site: the same runner fails the broken site', () => {
  const broken = prod({ 'menu.html': GOOD.replace('>$13.00<', '>$11.00<') });
  assert.equal(run(DEMO).status, 0);
  const r = broken.run();
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes(fs.realpathSync(broken.site)), 'the failing report names the consumer site, not the demo');
  assert.ok(!r.stdout.includes(fs.realpathSync(DEMO[1])));
});
test('the report is deterministic: two runs print the same bytes', () => {
  const t = prod({ 'b.html': GOOD, 'a/x.html': GOOD });
  assert.equal(t.run().stdout, t.run().stdout);
  const bad = prod({ 'b.html': GOOD.replace('"13.00"', '"1.00"'), 'a.html': GOOD.replace('>$6.00<', '>$7.00<') });
  const r1 = bad.run(), r2 = bad.run();
  assert.equal(r1.stderr, r2.stderr);
  assert.ok(r1.stderr.indexOf('a.html') < r1.stderr.indexOf('b.html'), 'failures are listed in page order');
});

// ── price, currency and identity against the snapshot ────────────────────────
test('control: a correct consumer site passes', () => {
  passes({ 'menu.html': GOOD });
  passes({ 'index.html': '<p>no prices here</p>', 'menus/dinner.html': GOOD });
});
test('a stale visible price fails, naming the page and the id', () => {
  fails({ 'menu.html': GOOD.replace('>$13.00<', '>$11.00<') }, new RegExp(`menu\\.html: visible price \\$11\\.00 for ${A} != snapshot \\$13\\.00`));
});
test('a stale JSON-LD price, a wrong currency, and an unreadable offer each fail', () => {
  fails({ 'menu.html': GOOD.replace('"13.00"', '"11.00"') }, new RegExp(`JSON-LD price \\$11\\.00 for ${A} != snapshot \\$13\\.00`));
  fails({ 'menu.html': vis(A, '13.00') + vis(B, '6.00') + ld(mi(A, '13.00', 'EUR'), mi(B, '6.00')) }, /priceCurrency EUR/);
  fails({ 'menu.html': GOOD.replace('"price":"13.00"', '"price":13') }, new RegExp(`${A}.*no readable single offer`));
});
test('an id on the page that the snapshot does not hold fails, on either surface', () => {
  const C = 'GHOST0000000000000000003';
  fails({ 'menu.html': GOOD + vis(C, '5.00') + ld(mi(C, '5.00')) }, new RegExp(`visible id ${C} is not in the snapshot`));
  fails({ 'menu.html': GOOD + vis(C, '5.00') + ld(mi(C, '5.00')) }, new RegExp(`JSON-LD id ${C} is not in the snapshot`));
});
test('a snapshot id missing from the site fails, on either surface', () => {
  fails({ 'menu.html': vis(A, '13.00') + ld(mi(A, '13.00')) }, new RegExp(`${B} \\(Soup\\) has no visible price node`));
  fails({ 'menu.html': vis(A, '13.00') + vis(B, '6.00') + ld(mi(A, '13.00')) }, new RegExp(`${B} \\(Soup\\) has no JSON-LD MenuItem`));
});
test('a zero-price item is a price like any other', () => {
  const snap = { ...SNAP, items: { ...SNAP.items, [A]: { name: 'Pasta', amountMinor: 0 } } };
  passes({ 'menu.html': GOOD.replaceAll('13.00', '0.00') }, snap);
  fails({ 'menu.html': GOOD }, /!= snapshot \$0\.00/, snap);
});
test('a grouped visible price ($1,300.00) compares equal to the snapshot amount', () => {
  const snap = { ...SNAP, items: { ...SNAP.items, [A]: { name: 'Pasta', amountMinor: 130000 } } };
  passes({ 'menu.html': vis(A, '1,300.00') + vis(B, '6.00') + ld(mi(A, '1300.00'), mi(B, '6.00')) }, snap);
});

// ── page-level parity (the default) ──────────────────────────────────────────
// Site-wide parity let page A carry an item's visible price and page B its JSON-LD: neither
// page's structured data described what that page shows.
const SPLIT = { 'a.html': vis(A, '13.00') + vis(B, '6.00') + ld(mi(B, '6.00')), 'b.html': ld(mi(A, '13.00')) };
test('an id visible on one page with its JSON-LD only on another fails by default, naming both gaps', () => {
  const r = fails(SPLIT, new RegExp(`a\\.html: ${A} has a visible price but no JSON-LD MenuItem on this page`));
  assert.match(r.stderr, new RegExp(`b\\.html: ${A} has a JSON-LD MenuItem but no visible price on this page`));
});
test('--site-wide is the explicit opt-out: the same split site passes, and the report says which mode ran', () => {
  const r = passes(SPLIT, SNAP, '--site-wide');
  assert.match(r.stdout, /mode=site-wide/);
});
test('--site-wide relaxes only the pairing: prices, currency and coverage are still enforced', () => {
  fails({ ...SPLIT, 'b.html': ld(mi(A, '11.00')) }, /JSON-LD price \$11\.00/, SNAP, '--site-wide');
  fails({ 'a.html': vis(A, '13.00') + vis(B, '6.00') + ld(mi(B, '6.00')) }, /no JSON-LD MenuItem/, SNAP, '--site-wide');
});
test('control: an item need not be on every page — each page is checked for the items IT shows', () => {
  passes({ 'lunch.html': vis(A, '13.00') + ld(mi(A, '13.00')), 'dinner.html': vis(B, '6.00') + ld(mi(B, '6.00')) });
  passes({ 'menu.html': GOOD, 'specials.html': vis(A, '13.00') + ld(mi(A, '13.00')) });
});

// ── inputs that cannot be checked are failures, never passes ─────────────────
test('a snapshot that is missing, not JSON, not v2, empty, or holds a non-integer amount fails', () => {
  const t = prod({ 'menu.html': GOOD });
  assert.equal(run(['--site', t.site, '--snapshot', path.join(t.dir, 'nope.json')]).status, 1);
  fails({ 'menu.html': GOOD }, /not valid JSON/, '{');
  fails({ 'menu.html': GOOD }, /schemaVersion/, { ...SNAP, schemaVersion: 1 });
  fails({ 'menu.html': GOOD }, /no items/, { ...SNAP, items: {} });
  fails({ 'menu.html': GOOD }, /amountMinor/, { ...SNAP, items: { ...SNAP.items, [A]: { name: 'Pasta', amountMinor: 13.5 } } });
  fails({ 'menu.html': GOOD }, /amountMinor/, { ...SNAP, items: { ...SNAP.items, [A]: { name: 'Pasta', amountMinor: -1 } } });
  fails({ 'menu.html': GOOD }, /currency/, { ...SNAP, currency: 'EUR' });
  fails({ 'menu.html': GOOD }, /not a catalog id/, { ...SNAP, items: { ...SNAP.items, short: { name: 'x', amountMinor: 1 } } });
});
test('a site that is missing, has no pages, or has no managed prices fails', () => {
  const t = prod({ 'menu.html': GOOD });
  assert.equal(run(['--site', path.join(t.dir, 'nope'), '--snapshot', t.snap]).status, 1);
  fails({}, /no \.html files/);
  fails({ 'index.html': '<p>hello</p>' }, /no visible price node/);
});
test('a page the extractors refuse fails with its name: unparseable JSON-LD, inert markup, a foreign type', () => {
  fails({ 'menu.html': GOOD + '<script type="application/ld+json">{oops</script>' }, /menu\.html: .*not valid JSON/);
  fails({ 'menu.html': `<!-- ${vis(A, '13.00')} -->` + GOOD }, /menu\.html: .*HTML comment/);
  fails({ 'menu.html': GOOD.replace('"@type":"MenuItem"', '"@type":"https://unrelated.example/MenuItem"') }, /menu\.html: .*"@type"/);
});
test('a symlinked page is refused, as the baker refuses it', () => {
  const t = prod({ 'menu.html': GOOD });
  fs.symlinkSync(path.join(t.site, 'menu.html'), path.join(t.site, 'alias.html'));
  const r = t.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /symbolic link/);
});
test('the runner never writes: the site and snapshot are byte-identical after a pass and after a fail', () => {
  for (const page of [GOOD, GOOD.replace('>$13.00<', '>$11.00<')]) {
    const t = prod({ 'menu.html': page });
    const before = [fs.readFileSync(path.join(t.site, 'menu.html'), 'utf8'), fs.readFileSync(t.snap, 'utf8'), fs.readdirSync(t.site).join(), fs.readdirSync(t.dir).join()];
    t.run();
    assert.deepEqual([fs.readFileSync(path.join(t.site, 'menu.html'), 'utf8'), fs.readFileSync(t.snap, 'utf8'), fs.readdirSync(t.site).join(), fs.readdirSync(t.dir).join()], before);
  }
});

// ── the library behind the command ───────────────────────────────────────────
test('checkParity returns the same verdict as the command, as data', () => {
  const ok = prod({ 'menu.html': GOOD });
  const r = checkParity({ site: ok.site, snapshot: ok.snap });
  assert.deepEqual({ ok: r.ok, errors: r.errors, pages: r.pages, ids: r.ids, visible: r.visible, jsonld: r.jsonld, mode: r.mode },
    { ok: true, errors: [], pages: 1, ids: 2, visible: 2, jsonld: 2, mode: 'per-page' });
  const split = prod(SPLIT);
  assert.equal(checkParity({ site: split.site, snapshot: split.snap }).ok, false);
  assert.equal(checkParity({ site: split.site, snapshot: split.snap, siteWide: true }).ok, true);
});
test('the demo tree satisfies page-level parity (what CI proves about the demo, now per page)', () => {
  const r = checkParity({ site: DEMO[1], snapshot: DEMO[3] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});
