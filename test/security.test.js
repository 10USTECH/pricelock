// test/security.test.js — the input checks in lib/guards.mjs, through the CLI where possible.
//
// Every CLI case here must stop BEFORE any network connection or file write. None of them
// needs the network: rejected sources fail on their scheme, their credentials, or the
// address their host resolves to (localhost and IP literals resolve offline).
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

const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 30000 });
const guards = () => import('../lib/guards.mjs');

// Copy a fixture's site into a temp dir so --write never touches the repo.
function tmpSite(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pricelock-${name}-`));
  fs.cpSync(path.join(FIX, name, 'site'), path.join(dir, 'site'), { recursive: true });
  return { site: path.join(dir, 'site'), snapshot: path.join(dir, 'snap.json'), catalog: path.join(FIX, name, 'catalog.json') };
}

// ── 1. feed ids ──────────────────────────────────────────────────────────────
test('a feed id carrying markup is refused, named, and nothing is written', () => {
  const t = tmpSite('bad-id');
  const before = fs.readFileSync(path.join(t.site, 'menu.html'), 'utf8');
  const r = run('--write', '--src', t.catalog, '--site', t.site, '--snapshot', t.snapshot);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /is not a catalog id/);
  assert.ok(r.stderr.includes('<script>'), 'the error must name the offending id');
  assert.equal(fs.readFileSync(path.join(t.site, 'menu.html'), 'utf8'), before, 'menu.html must be unchanged');
  assert.equal(fs.existsSync(t.snapshot), false, 'no snapshot may be written');
});

test('a valid 24-character feed id is accepted and anchored', () => {
  const t = tmpSite('good-id');
  const r = run('--write', '--src', t.catalog, '--site', t.site, '--snapshot', t.snapshot);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(t.site, 'menu.html'), 'utf8'), /data-sq-item="LEMONADE0000000000000001">\$4\.00</);
});

test('validateFeedId: shape rule', async () => {
  const { validateFeedId } = await guards();
  assert.equal(validateFeedId('LEMONADE0000000000000001', 'x'), 'LEMONADE0000000000000001');
  for (const bad of ['"<script>', 'lemonade0000000000000001', 'SHORT01', 'ABC DEF0000000000000001', 12345678901234567890n, null]) {
    assert.throws(() => validateFeedId(bad, 'x'), /not a catalog id/, `should refuse ${String(bad)}`);
  }
});

// ── 2. snapshot URL hygiene ──────────────────────────────────────────────────
test('snapshot source keeps origin + path only (no query, no fragment)', async () => {
  const { checkSourceUrl, snapshotSource } = await guards();
  assert.equal(snapshotSource(checkSourceUrl('https://a.b/c?x=1#f')), 'https://a.b/c');
  assert.equal(snapshotSource(checkSourceUrl('https://a.b:8443/feeds/menu.json?token=abc')), 'https://a.b:8443/feeds/menu.json');
});

test('a source URL with credentials is refused without echoing them', () => {
  const r = run('--check', '--src', 'https://user:pw@a.b/c');
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /must not carry credentials/);
  assert.ok(!r.stderr.includes('pw') && !r.stdout.includes('pw'), 'the password must not be printed');
});

// ── 3. https only, public addresses only ─────────────────────────────────────
for (const src of ['http://127.0.0.1:9/catalog.json', 'file:///etc/passwd', 'data:application/json,{"menu":[]}', 'ftp://a.b/c.json']) {
  test(`non-https source is refused: ${src.slice(0, 30)}`, () => {
    const r = run('--check', '--src', src);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--src must be https:/);
  });
}

for (const src of [
  'https://127.0.0.1:9/c.json',        // loopback
  'https://localhost:9/c.json',        // resolves to loopback
  'https://[::1]:9/c.json',            // IPv6 loopback
  'https://10.255.255.1:9/c.json',     // RFC 1918
  'https://172.31.255.254:9/c.json',   // RFC 1918
  'https://192.168.255.254:9/c.json',  // RFC 1918
  'https://169.254.169.254:9/c.json',  // link-local (cloud metadata)
  'https://[fe80::1]:9/c.json',        // IPv6 link-local
  'https://[::ffff:127.0.0.1]:9/c.json', // IPv4-mapped loopback
]) {
  test(`non-public host is refused before connecting: ${src}`, () => {
    const t0 = Date.now();
    const r = run('--check', '--src', src);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /non-public address/);
    assert.ok(Date.now() - t0 < 10000, 'refusal must not wait on a connection attempt');
  });
}

test('isBlockedAddress: private, loopback, link-local and mapped forms', async () => {
  const { isBlockedAddress } = await guards();
  for (const a of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(a), true, `${a} must be blocked`);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(a), false, `${a} must be allowed`);
  }
});

test('unmapIPv4: both IPv4-mapped spellings become IPv4; anything else is null', async () => {
  const { unmapIPv4 } = await guards();
  assert.equal(unmapIPv4('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(unmapIPv4('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(unmapIPv4('::FFFF:0a00:0005'), '10.0.0.5');
  assert.equal(unmapIPv4('::1'), null);
  assert.equal(unmapIPv4('fe80::1'), null);
});

test('assertPublicHost checks EVERY resolved address, not just the first', async () => {
  const { assertPublicHost } = await guards();
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
  await assert.rejects(assertPublicHost('feed.example', resolver), /non-public address \(10\.0\.0\.5\)/);
  const ok = async () => [{ address: '93.184.216.34', family: 4 }];
  await assert.doesNotReject(assertPublicHost('feed.example', ok));
});

test('connect-time lookup refuses a private answer even after a public pre-check (rebinding)', async () => {
  const { assertPublicHost, guardedLookup } = await guards();
  // First DNS answer (pre-check) is public; the answer at connect time is loopback.
  let calls = 0;
  const answers = [[{ address: '93.184.216.34', family: 4 }], [{ address: '127.0.0.1', family: 4 }]];
  const promiseResolver = async () => answers[calls++];
  const callbackResolver = (h, o, cb) => cb(null, answers[calls++]);
  await assertPublicHost('feed.example', promiseResolver);
  const err = await new Promise(res => guardedLookup(callbackResolver)('feed.example', {}, e => res(e)));
  assert.ok(err instanceof Error, 'the connect-time lookup must fail');
  assert.match(err.message, /non-public address \(127\.0\.0\.1\)/);
});

test('connect-time lookup hands back a public address in both callback shapes', async () => {
  const { guardedLookup } = await guards();
  const r = (h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);
  const single = await new Promise(res => guardedLookup(r)('feed.example', {}, (e, a, f) => res([e, a, f])));
  assert.deepEqual(single, [null, '93.184.216.34', 4]);
  const all = await new Promise(res => guardedLookup(r)('feed.example', { all: true }, (e, a) => res([e, a])));
  assert.deepEqual(all, [null, [{ address: '93.184.216.34', family: 4 }]]);
});

test('redirects are refused; non-200 fails; 200 passes', async () => {
  const { responseError } = await guards();
  for (const s of [301, 302, 303, 307, 308]) assert.match(responseError(s, 'https://elsewhere/').message, /refused a redirect/);
  assert.match(responseError(404).message, /HTTP 404/);
  assert.equal(responseError(200), null);
});

// ── 4. flags with a missing value ────────────────────────────────────────────
for (const argv of [['--check', '--src'], ['--check', '--src', '--site', 'x'], ['--check', '--site'], ['--check', '--snapshot'], ['--check', '--snapshot', '']]) {
  test(`missing flag value exits non-zero naming the flag: ${argv.join(' ')}`, () => {
    const flag = argv[1];
    const r = run(...argv);
    assert.equal(r.status, 2, r.stderr);
    const lines = r.stderr.trim().split('\n');
    assert.equal(lines.length, 1, `expected a one-line message, got:\n${r.stderr}`);
    assert.match(lines[0], new RegExp(`${flag} needs a value`));
  });
}
