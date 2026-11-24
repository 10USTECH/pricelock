// test/audit-2026-11-24.test.js — regression tests from the 2026-11-24 audit.
//
// Every case marked (H1)–(H5) here was silently wrong, or passed where it should have been
// refused, on main@6cf58d8 (v1.7.0). Finding ids match docs/AUDIT-2026-11-24.md. The cases
// marked "control" passed before and must keep passing. Nothing here touches the repo's
// files or the network.
//
// Run with: node --test   (from the repo root)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsonld from '../lib/jsonld.mjs';
import * as square from '../lib/square.mjs';
import { checkParity } from '../lib/parity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BAKER = path.join(ROOT, 'bin', 'bake-prices.mjs');
const ADAPTER = path.join(ROOT, 'bin', 'square-to-feed.mjs');

const A = 'SALADLUNCH00000000000001', B = 'SALADDINNER0000000000002', C = 'SOUP00000000000000000003';
const salad = (id, cents) => ({ id, name: 'House Salad', amountMinor: cents });
const feed = (menu, extra = {}) => ({ schemaVersion: 2, currency: 'USD', ...extra, menu });

const LD = body => `<script type="application/ld+json">${body}</script>\n`;
const h2 = name => `<h2 class="cat-title">${name}</h2>\n`;
const row = (name, price, attrs = '') => `<h3 class="item-name">${name}</h3><div class="item-price"${attrs}>$${price}</div>\n`;
const ldSection = (section, name, price) => LD(`{"@context":"https://schema.org","@type":"Menu","hasMenuSection":[{"@type":"MenuSection","name":"${section}","hasMenuItem":[{"@type":"MenuItem","name":"${name}","offers":{"@type":"Offer","price":"${price}","priceCurrency":"USD"}}]}]}`);

// A scratch tree: <dir>/catalog.json, <dir>/site/menu.html, <dir>/snap.json (not yet written).
// `catalog` is an object (serialised) or a string (written as is — for duplicate-key text).
function tree(name, page, catalog) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pricelock-a1124-${name}-`));
  const t = { dir, site: path.join(dir, 'site'), catalog: path.join(dir, 'catalog.json'), snapshot: path.join(dir, 'snap.json') };
  fs.mkdirSync(t.site);
  t.page = path.join(t.site, 'menu.html');
  fs.writeFileSync(t.page, page);
  fs.writeFileSync(t.catalog, typeof catalog === 'string' ? catalog : JSON.stringify(catalog));
  t.run = (mode, ...extra) => spawnSync(process.execPath,
    [BAKER, mode, '--src', t.catalog, '--site', t.site, '--snapshot', t.snapshot, ...extra],
    { encoding: 'utf8', timeout: 30000, cwd: ROOT });
  t.read = () => fs.readFileSync(t.page, 'utf8');
  t.snap = () => JSON.parse(fs.readFileSync(t.snapshot, 'utf8'));
  return t;
}
function refused(name, page, catalog, why, ...extra) {
  const t = tree(name, page, catalog);
  const r = t.run('--write', ...extra);
  assert.equal(r.status, 1, `expected a refusal; got exit ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, why);
  assert.equal(t.read(), page, 'nothing written');
  assert.equal(fs.existsSync(t.snapshot), false, 'no snapshot written');
  return t;
}
function bakes(name, page, catalog, ...extra) {
  const t = tree(name, page, catalog);
  const r = t.run('--write', ...extra);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.run('--check', ...extra).status, 0);
  return t;
}

// ── H1. an id listed under two sections keeps BOTH memberships ───────────────
// loadCatalog kept only the first section an id appeared in. The section tie-break then ran
// on half the truth: a name that was ambiguous inside a section resolved silently (fail-open),
// and a name that was unique inside a section was refused.
const TWO_HOMES = feed([
  { name: 'Lunch', items: [salad(A, 1200)] },
  { name: 'Dinner', items: [salad(A, 1200), salad(B, 1600)] },   // A is on the dinner menu too
]);
test('H1: a name shared by two ids in the SAME section is refused, even when one id was first listed elsewhere (visible)', () => {
  // v1.7.0: resolved to B, wrote data-sq-item=B and $16.00, exit 0 — and an anchored id is trusted forever after.
  refused('h1-vis', h2('Dinner') + row('House Salad', '12.00'), TWO_HOMES, /ambiguous node "House Salad"/);
});
test('H1: the same on the JSON-LD side (MenuSection)', () => {
  refused('h1-ld', ldSection('Dinner', 'House Salad', '12.00'), TWO_HOMES, /ambiguous node "House Salad"/);
});
test('H1: order independence — the refusal does not depend on which section lists the shared id first', () => {
  const flipped = feed([TWO_HOMES.menu[1], TWO_HOMES.menu[0]]);
  refused('h1-flip', h2('Dinner') + row('House Salad', '12.00'), flipped, /ambiguous node "House Salad"/);
  const inner = feed([{ name: 'Lunch', items: [salad(A, 1200)] }, { name: 'Dinner', items: [salad(B, 1600), salad(A, 1200)] }]);
  refused('h1-inner', h2('Dinner') + row('House Salad', '12.00'), inner, /ambiguous node "House Salad"/);
});
test('H1: a name that IS unique within a later section of a two-section id resolves there (was a false refusal)', () => {
  const cat = feed([
    { name: 'Lunch', items: [salad(A, 1200)] },
    { name: 'Specials', items: [salad(A, 1200)] },
    { name: 'Dinner', items: [salad(B, 1600)] },
  ]);
  const t = bakes('h1-second-home', h2('Specials') + row('House Salad', '99.00'), cat);
  assert.match(t.read(), new RegExp(`data-sq-item="${A}">\\$12\\.00<`));
  assert.deepEqual(Object.keys(t.snap().items), [A]);
});
test('H1: sections whose names differ only by case or spacing are one section for the tie-break', () => {
  // v1.7.0: the page said "Lunch"; the last-listed spelling ("lunch") won and B was chosen.
  const cat = feed([{ name: 'Lunch', items: [salad(A, 1200)] }, { name: 'lunch ', items: [salad(B, 1600)] }]);
  refused('h1-case', h2('Lunch') + row('House Salad', '12.00'), cat, /ambiguous node "House Salad"/);
});
test('H1: the ambiguity error names every section each candidate sits in', () => {
  const t = tree('h1-msg', h2('Dinner') + row('House Salad', '12.00'), TWO_HOMES);
  const r = t.run('--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Lunch\+Dinner\/\$12\.00/);
  assert.match(r.stderr, /Dinner\/\$16\.00/);
});
test('H1 control: lunch/dinner twins in different sections still resolve by section, on both surfaces', () => {
  const cat = feed([{ name: 'Lunch', items: [salad(A, 1200)] }, { name: 'Dinner', items: [salad(B, 1600)] }]);
  const page = h2('Lunch') + row('House Salad', '1.00') + h2('Dinner') + row('House Salad', '1.00')
    + LD(`{"@context":"https://schema.org","@type":"Menu","hasMenuSection":[`
      + `{"@type":"MenuSection","name":"Lunch","hasMenuItem":[{"@type":"MenuItem","name":"House Salad","offers":{"@type":"Offer","price":"1.00","priceCurrency":"USD"}}]},`
      + `{"@type":"MenuSection","name":"Dinner","hasMenuItem":[{"@type":"MenuItem","name":"House Salad","offers":{"@type":"Offer","price":"1.00","priceCurrency":"USD"}}]}]}`);
  const t = bakes('h1-control', page, cat);
  const out = t.read();
  assert.match(out, new RegExp(`data-sq-item="${A}">\\$12\\.00<[\\s\\S]*data-sq-item="${B}">\\$16\\.00<`));
  assert.match(out, new RegExp(`"identifier": "${A}"[\\s\\S]*"price":"12.00"[\\s\\S]*"identifier": "${B}"[\\s\\S]*"price":"16.00"`));
  assert.equal(t.run('--write').status, 0);
  assert.equal(t.read(), out, 'idempotent');
});
test('H1 control: one id under two sections with a different price is still a feed defect', () => {
  const cat = feed([{ name: 'Lunch', items: [salad(A, 1200)] }, { name: 'Dinner', items: [salad(A, 1600)] }]);
  refused('h1-two-prices', h2('Lunch') + row('House Salad', '12.00'), cat, /appears more than once with different data/);
});

// ── H2. the catalog's location is checked against the one the site expects ───
// The baker copied the feed's locationId into the snapshot and compared it with nothing: a
// feed for another location baked cleanly.
const DEVON = 'LDEVON0000000001', TRUCK = 'LTRUCK0000000001';
const AT = loc => feed([{ name: 'Lunch', items: [salad(A, 1200)] }], loc === null ? {} : { locationId: loc });
const anchoredA = h2('Lunch') + row('House Salad', '12.00', ` data-sq-item="${A}"`);
test('H2: --location refuses a catalog for another location, in --write and --check', () => {
  const t = refused('h2-other', anchoredA, AT(TRUCK), /location/, '--location', DEVON);
  const r = t.run('--check', '--location', DEVON);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`${TRUCK}[\\s\\S]*${DEVON}|${DEVON}[\\s\\S]*${TRUCK}`));
});
test('H2: --location refuses a catalog that states no location (v2 without locationId, and v1)', () => {
  refused('h2-none', anchoredA, AT(null), /states no location/, '--location', DEVON);
  const v1 = { menu: [{ name: 'Lunch', items: [{ id: A, name: 'House Salad', price: 12 }] }] };
  refused('h2-v1', anchoredA, v1, /states no location/, '--location', DEVON);
  refused('h2-nonstring', anchoredA, AT(42), /states no location/, '--location', '42');
});
test('H2: --location needs a value (usage error, exit 2)', () => {
  const t = tree('h2-usage', anchoredA, AT(DEVON));
  assert.equal(t.run('--check', '--location').status, 2);
});
test('H2 control: the matching location bakes, and the snapshot records it', () => {
  const t = bakes('h2-match', anchoredA, AT(DEVON), '--location', DEVON);
  assert.equal(t.snap().locationId, DEVON);
});
test('H2 control: without --location nothing changes (a v1 catalog and a location-less v2 still bake)', () => {
  bakes('h2-off-v2', anchoredA, AT(null));
  bakes('h2-off-other', anchoredA, AT(TRUCK));
});
test('H2 control: the demo passes --check with its own location, and fails with another', () => {
  const run = loc => spawnSync(process.execPath, [BAKER, '--check', '--location', loc], { encoding: 'utf8', timeout: 30000, cwd: ROOT });
  assert.equal(run('DEMO-LOCATION').status, 0);
  assert.equal(run(DEVON).status, 1);
});

// ── H3. a saved Square response that still carries a cursor is incomplete ────
// The live fetch follows the cursor to the end. --input did not look: a saved FIRST page of a
// longer catalog produced a feed missing every later item, exit 0.
const VAR = n => ({ type: 'ITEM_VARIATION', id: `VARIATION0000000000000${n}`, item_variation_data: { name: 'Regular', pricing_type: 'FIXED_PRICING', price_money: { amount: 300 + n, currency: 'USD' } } });
const ITEM = n => ({ type: 'ITEM', id: `ITEM00000000000000000000${n}`, item_data: { name: `Item ${n}`, variations: [VAR(n)] } });
const ids = pages => square.squareToFeed(pages, { locationId: DEVON }).feed.menu.flatMap(s => s.items.map(i => i.id));
test('H3: a single response with a cursor is refused', () => {
  assert.throws(() => ids({ objects: [ITEM(1)], cursor: 'NEXT' }), /cursor/);
});
test('H3: a set of pages whose LAST page still has a cursor is refused', () => {
  assert.throws(() => ids([{ objects: [ITEM(1)], cursor: 'NEXT' }]), /cursor/);
  assert.throws(() => ids([{ objects: [ITEM(1)], cursor: 'P2' }, { objects: [ITEM(2)], cursor: 'P3' }]), /cursor/);
});
test('H3: a cursor that is not a string is malformed, not "absent"', () => {
  assert.throws(() => ids({ objects: [ITEM(1)], cursor: 7 }), /cursor/);
  assert.throws(() => ids({ objects: [ITEM(1)], cursor: { next: 'x' } }), /cursor/);
});
test('H3: the CLI refuses an incomplete --input and writes no feed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelock-a1124-h3-'));
  const input = path.join(dir, 'page1.json'), out = path.join(dir, 'feed.json');
  fs.writeFileSync(input, JSON.stringify({ objects: [ITEM(1)], cursor: 'NEXT' }));
  const r = spawnSync(process.execPath, [ADAPTER, '--location', DEVON, '--input', input, '--out', out], { encoding: 'utf8', timeout: 30000, env: { ...process.env, SQUARE_ACCESS_TOKEN: '' } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /cursor/);
  assert.equal(fs.existsSync(out), false);
});
test('H3 control: a complete response, a complete set of pages, and a flat object list are still read', () => {
  assert.deepEqual(ids({ objects: [ITEM(1)] }), [VAR(1).id]);
  assert.deepEqual(ids({ objects: [ITEM(1)], cursor: null }), [VAR(1).id]);
  assert.deepEqual(ids({ objects: [ITEM(1)], cursor: '' }), [VAR(1).id]);
  assert.deepEqual(ids([{ objects: [ITEM(1)], cursor: 'P2' }, { objects: [ITEM(2)] }]), [VAR(1).id, VAR(2).id]);
  assert.deepEqual(ids([ITEM(1), ITEM(2)]), [VAR(1).id, VAR(2).id]);
});

// ── H4. duplicate keys are refused at every JSON input, not only in JSON-LD ──
// JSON.parse keeps the LAST value of a repeated key. A catalog, a saved Square response or a
// snapshot with a repeated key therefore meant one thing to this tool and could mean another
// to a reviewer or a different parser.
test('H4: parseJsonStrict refuses a duplicate key at any depth, after unescaping', () => {
  const p = jsonld.parseJsonStrict;
  assert.equal(typeof p, 'function');
  for (const bad of ['{"a":1,"a":2}', '{"x":{"a":1,"a":1}}', '[{"a":1,"\\u0061":2}]', '{"a":1,"b":[{"c":{"d":1,"d":2}}]}']) {
    assert.throws(() => p(bad), /duplicate key/, bad);
  }
  for (const bad of ['', '{', '{"a":1}x', "{'a':1}", '{"a":01}', '[1,]', 'NaN']) assert.throws(() => p(bad), undefined, bad);
});
test('H4 control: parseJsonStrict returns exactly what JSON.parse returns for valid JSON', () => {
  for (const ok of ['{"a":1,"b":{"a":2},"c":[{"a":3},{"a":4}]}', '[]', '"x"', '12.50', 'null', '{"__proto__":{"a":1},"a":"\\u00e9"}', ' {"a" : [ 1 , 2 ] } \n']) {
    assert.deepEqual(jsonld.parseJsonStrict(ok), JSON.parse(ok), ok);
  }
  assert.equal(Object.getPrototypeOf(jsonld.parseJsonStrict('{"__proto__":{"polluted":true}}')), Object.prototype);
  assert.equal({}.polluted, undefined);
});
test('H4: a catalog with a repeated key is refused by the baker (v1.7.0 baked the LAST value)', () => {
  const text = `{"schemaVersion":2,"currency":"USD","menu":[{"name":"Lunch","items":[{"id":"${A}","name":"House Salad","amountMinor":1200,"amountMinor":100}]}]}`;
  refused('h4-catalog-item', anchoredA, text, /duplicate key "amountMinor"/);
  const top = `{"schemaVersion":2,"currency":"USD","menu":[],"menu":[{"name":"Lunch","items":[{"id":"${A}","name":"House Salad","amountMinor":1200}]}]}`;
  refused('h4-catalog-top', anchoredA, top, /duplicate key "menu"/);
});
test('H4: a saved Square response with a repeated key is refused by the adapter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelock-a1124-h4-'));
  const input = path.join(dir, 'saved.json'), out = path.join(dir, 'feed.json');
  fs.writeFileSync(input, `{"objects":${JSON.stringify([ITEM(1), ITEM(2)])},"objects":${JSON.stringify([ITEM(1)])}}`);
  const r = spawnSync(process.execPath, [ADAPTER, '--location', DEVON, '--input', input, '--out', out], { encoding: 'utf8', timeout: 30000, env: { ...process.env, SQUARE_ACCESS_TOKEN: '' } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /duplicate key "objects"/);
  assert.equal(fs.existsSync(out), false);
});
test('H4: a snapshot with a repeated key fails the parity check', () => {
  const page = anchoredA + LD(`{"@context":"https://schema.org","@type":"MenuItem","name":"House Salad","identifier":"${A}","offers":{"@type":"Offer","price":"12.00","priceCurrency":"USD"}}`);
  const t = bakes('h4-snap', page, AT(DEVON));
  assert.equal(checkParity({ site: t.site, snapshot: t.snapshot }).ok, true, 'control: the sealed tree passes');
  // the parity check would read 1200 (the last value); a first-wins reader would read 1
  fs.writeFileSync(t.snapshot, fs.readFileSync(t.snapshot, 'utf8').replace('"amountMinor": 1200', '"amountMinor": 1,\n      "amountMinor": 1200'));
  const r = checkParity({ site: t.site, snapshot: t.snapshot });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /duplicate key "amountMinor"/);
});

// ── H5. when the catalog was FETCHED is recorded apart from when it last CHANGED ──
// The feed's only timestamp, cachedAt, is the catalog's latest updated_at. A feed fetched a
// year ago from a catalog nobody has edited since looks exactly like one fetched today.
const ISO = '2026-11-24T17:30:00.000Z';
test('H5: withFetchedAt stamps the fetch time and leaves cachedAt (the modification time) alone', () => {
  assert.equal(typeof square.withFetchedAt, 'function');
  const { feed: f } = square.squareToFeed({ objects: [{ ...ITEM(1), updated_at: '2026-05-01T00:00:00Z' }] }, { locationId: DEVON });
  const stamped = square.withFetchedAt(f, new Date(ISO));
  assert.equal(stamped.fetchedAt, ISO);
  assert.equal(stamped.cachedAt, '2026-05-01T00:00:00Z');
  assert.equal(f.fetchedAt, undefined, 'the input feed is not mutated');
  assert.deepEqual({ ...stamped, fetchedAt: undefined }, { ...f, fetchedAt: undefined });
  assert.throws(() => square.withFetchedAt(f, new Date(NaN)), /fetch time/);
  assert.throws(() => square.withFetchedAt(f, ISO), /fetch time/);
});
test('H5: the baker reports fetchedAt and keeps it OUT of the snapshot, so a re-fetch of an unchanged catalog stays in sync', () => {
  const t = bakes('h5-report', anchoredA, AT(DEVON));
  const sealed = fs.readFileSync(t.snapshot, 'utf8');
  assert.doesNotMatch(t.run('--check').stdout, /fetchedAt/, 'control: nothing is reported when the feed has none');
  for (const when of [ISO, '2027-01-02T03:04:05Z']) {
    fs.writeFileSync(t.catalog, JSON.stringify(feed(AT(DEVON).menu, { locationId: DEVON, fetchedAt: when })));
    const r = t.run('--check');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`fetchedAt=${when.replace(/\./g, '\\.')}`));
  }
  assert.equal(t.run('--write').status, 0);
  assert.equal(fs.readFileSync(t.snapshot, 'utf8'), sealed, 'the snapshot does not carry the fetch time');
});
test('H5: a fetchedAt that is not a UTC ISO-8601 timestamp is refused (it is printed, so it is checked)', () => {
  for (const bad of ['yesterday', 1764000000, '2026-11-24', '2026-13-40T99:99:99Z', '2026-11-24T17:30:00+01:00', '2026-11-24T17:30:00Z\u001b[2J', true]) {
    refused('h5-bad', anchoredA, feed(AT(DEVON).menu, { locationId: DEVON, fetchedAt: bad }), /fetchedAt/);
  }
});
test('H5 control: an offline --input run records no fetch time, and stays byte-identical run to run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricelock-a1124-h5-'));
  const input = path.join(dir, 'saved.json');
  fs.writeFileSync(input, JSON.stringify({ objects: [ITEM(1)] }));
  const run = () => spawnSync(process.execPath, [ADAPTER, '--location', DEVON, '--input', input], { encoding: 'utf8', timeout: 30000, env: { ...process.env, SQUARE_ACCESS_TOKEN: '' } });
  const a = run(), b = run();
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stdout, b.stdout);
  assert.equal('fetchedAt' in JSON.parse(a.stdout), false);
});
