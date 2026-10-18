// lib/guards.mjs — the input checks bin/bake-prices.mjs runs before it trusts anything.
//
// Every function here either returns a value it has validated or THROWS. Nothing is
// escaped-and-continued: a bad input stops the bake before a single file is written.
//
//   validateFeedId     a feed id is written into HTML attributes and JSON-LD, so it must be
//                      an opaque catalog id (/^[A-Z0-9]{20,}$/) — never markup.
//   flagValue          `--src` / `--site` / `--snapshot` with a missing value is an error,
//                      not "use the next flag as the value".
//   checkSourceUrl     a URL source must be https:, with no user:password@ part.
//   snapshotSource     what the snapshot records about a URL source: origin + path only.
//   isBlockedAddress   loopback, private (RFC 1918 / IPv6 ULA), link-local, unspecified.
//   assertPublicHost   resolve BEFORE connecting; every returned address must be public.
//   guardedLookup      the same check again AT CONNECT TIME, on the addresses the socket
//                      will actually use — a second DNS answer (rebinding) cannot slip a
//                      private address in between the first check and the connection.
//   responseError      redirects are refused (a redirect could point anywhere); non-200 fails.
//   validateFeedPrice  a v1 feed price (float dollars): finite, >= 0, whole cents, < 1e9.
//   validateAmountMinor a v2 feed amount (integer cents): integer, >= 0, < 1e11.
//   validateCurrency   only USD is formatted by this tool; anything else is refused.
//   centsToText /      the only money formatting in the codebase: integers in, "12.00" out.
//   textToCents        "1,000.00" -> 100000; never a float in between.
//   readBodyBounded    a response body is buffered only up to a hard byte ceiling.
//   writeFileAtomic    temp file + fsync + rename, so a crash never leaves a truncated page.
//   listHtml           every .html under --site; a symbolic link is refused, not followed.
//   parsePriceText /   read "$1,000.00" as 1000; write it back the way the page had it.
//   formatPrice

import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

export const CATALOG_ID_RE = /^[A-Z0-9]{20,}$/;

export function validateFeedId(id, name) {
  if (typeof id === 'string' && CATALOG_ID_RE.test(id)) return id;
  const shown = JSON.stringify(String(id)).slice(0, 80);
  throw new Error(`feed id ${shown} (item ${JSON.stringify(String(name))}) is not a catalog id — `
    + 'expected /^[A-Z0-9]{20,}$/. Refusing to write it into HTML.');
}

// A numeric price is written into HTML as `$` + toFixed(2). Anything toFixed(2) cannot
// render faithfully is refused: negative, non-finite, more than two decimals (it would be
// silently rounded), or so large that toFixed switches to exponent notation ("$1e+21").
// Non-numbers (variable-priced items) are the caller's business — this is for numbers only.
export const MAX_PRICE = 1e9;
export function validateFeedPrice(price, id) {
  const bad = why => new Error(`feed price ${JSON.stringify(price)} for ${id} is ${why} — refusing to write it into HTML`);
  if (typeof price !== 'number' || !Number.isFinite(price)) throw bad('not a finite number');
  if (price < 0) throw bad('negative');
  if (price >= MAX_PRICE) throw bad(`>= ${MAX_PRICE}`);
  if (Math.abs(price * 100 - Math.round(price * 100)) > 1e-6) throw bad('not a whole number of cents');
  return price;
}

export class UsageError extends Error {}

// Returns the value after `flag`, `fallback` when the flag is absent, and throws when the
// flag is present without a value (end of argv, or the next token is another --flag).
export function flagValue(args, flag, fallback) {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  const v = args[i + 1];
  if (v === undefined || v === '' || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
  return v;
}

// A source is a URL when it carries a scheme. A Windows drive path (C:\x or C:/x) is a file.
export function isUrlSource(src) {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src);
}

export function checkSourceUrl(src) {
  let u;
  try { u = new URL(src); } catch { throw new Error('--src is not a valid URL'); }
  if (u.protocol !== 'https:') throw new Error(`--src must be https: (got ${u.protocol})`);
  if (u.username || u.password) {
    throw new Error('--src must not carry credentials (user:password@) — refused; the URL is not echoed');
  }
  return u;
}

// Origin + path only: no query string, no fragment, no credentials.
export function snapshotSource(u) {
  return u.origin + u.pathname;
}

const BLOCKED = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8],      // "this network" / unspecified
  ['10.0.0.0', 8],     // RFC 1918
  ['100.64.0.0', 10],  // shared address space (carrier NAT) — not internet-routable
  ['127.0.0.0', 8],    // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata endpoints)
  ['172.16.0.0', 12],  // RFC 1918
  ['192.168.0.0', 16], // RFC 1918
  ['192.0.0.0', 24],   // IETF protocol assignments (RFC 6890)
  ['192.0.2.0', 24],   // TEST-NET-1 (documentation)
  ['198.18.0.0', 15],  // benchmarking (RFC 2544)
  ['198.51.100.0', 24],// TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4],    // multicast
  ['240.0.0.0', 4],    // reserved, incl. 255.255.255.255 broadcast
]) BLOCKED.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128],         // unspecified
  ['::1', 128],        // loopback
  ['100::', 64],       // discard-only (RFC 6666)
  ['2001:db8::', 32],  // documentation
  ['fc00::', 7],       // unique local (the IPv6 analogue of RFC 1918)
  ['fe80::', 10],      // link-local
  ['ff00::', 8],       // multicast
]) BLOCKED.addSubnet(a, p, 'ipv6');

// Several IPv6 forms carry an IPv4 address inside them and reach that IPv4 address on a
// host with the matching transition mechanism. Each is unwrapped and checked as IPv4:
//   ::ffff:a.b.c.d / ::ffff:7f00:1   IPv4-mapped (RFC 4291 §2.5.5.2)
//   ::a.b.c.d / ::7f00:1             IPv4-compatible (deprecated, still parsed by Node)
//   64:ff9b::a.b.c.d                 NAT64 well-known prefix (RFC 6052)
//   2002:7f00:1::                    6to4 (RFC 3056): the IPv4 address is bits 16–47
// (Node 24's BlockList already matches ::ffff: forms against the IPv4 rules; unmapping
// here keeps the check independent of that, on every Node version in the CI matrix.)
function hextetsToV4(h1, h2) {
  const hi = parseInt(h1, 16), lo = parseInt(h2, 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}
export function unmapIPv4(addr) {
  const tail = /^(?:::ffff:|::|64:ff9b::)(.+)$/i.exec(addr);
  if (tail) {
    if (net.isIPv4(tail[1])) return tail[1];
    const h = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail[1]);
    if (h) return hextetsToV4(h[1], h[2]);
    return null;
  }
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/i.exec(addr);
  if (sixToFour) return hextetsToV4(sixToFour[1], sixToFour[2]);
  return null;
}

export function isBlockedAddress(addr) {
  const family = net.isIP(addr);
  if (family === 0) return true;                       // not an address at all: refuse
  if (family === 6) {
    const v4 = unmapIPv4(addr);
    if (v4) return BLOCKED.check(v4, 'ipv4');
    return BLOCKED.check(addr, 'ipv6');
  }
  return BLOCKED.check(addr, 'ipv4');
}

function assertAllPublic(host, addrs) {
  if (!addrs.length) throw new Error(`--src host ${host} resolved to no address`);
  const bad = addrs.map(a => a.address).filter(isBlockedAddress);
  if (bad.length) {
    throw new Error(`--src host ${host} resolves to a non-public address (${bad.join(', ')}) — `
      + 'loopback, private and link-local addresses are refused');
  }
}

// Resolve before fetching and check EVERY address. `resolver` is injectable for tests.
export async function assertPublicHost(hostname, resolver = dns.promises.lookup) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addrs = await resolver(host, { all: true, verbatim: true });
  assertAllPublic(host, addrs);
  return addrs;
}

// A `lookup` for https.request: resolves, checks every address, and only then hands the
// socket an address. Node calls it at connect time, so this is the check that holds even if
// DNS answers differently than it did for assertPublicHost. (Node skips `lookup` for an IP
// literal host — there is no DNS to rebind — and assertPublicHost has already checked it.)
export function guardedLookup(resolver = dns.lookup) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    resolver(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return callback(err);
      try { assertAllPublic(hostname, addrs); } catch (e) { return callback(e); }
      if (options.all) return callback(null, addrs);
      return callback(null, addrs[0].address, addrs[0].family);
    });
  };
}

export function responseError(statusCode, location) {
  if (statusCode >= 300 && statusCode < 400) {
    return new Error(`catalog fetch refused a redirect (HTTP ${statusCode}${location ? ' to another location' : ''}) — `
      + 'point --src at the final URL');
  }
  if (statusCode !== 200) return new Error(`catalog fetch HTTP ${statusCode}`);
  return null;
}

// Read a response body with a hard byte ceiling. A catalog is a few KB; a server that keeps
// sending (or a wrong URL that serves a video) must not be buffered into memory without
// bound. Resolves to the body text; rejects — and destroys the stream — past `maxBytes`.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export function readBodyBounded(res, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', c => {
      size += c.length;
      if (size > maxBytes) {
        res.destroy(new Error(`catalog response exceeds ${maxBytes} bytes — refused`));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

// Replace a file's contents so that a reader of `p` sees either the old bytes or the new
// bytes, never a truncated file: write a sibling temp file, fsync it, then rename over the
// target (same directory, so same filesystem). The temp file is removed on any failure.
// Scope: a crash of THIS process mid-write. Power loss is not covered (the directory entry
// is not fsynced) — see README "Writes and recovery".
export function writeFileAtomic(p, text, fsModule = fs) {
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.pricelock-${process.pid}.tmp`);
  let fd;
  try {
    fd = fsModule.openSync(tmp, 'wx', 0o644);
    fsModule.writeFileSync(fd, text, { encoding: 'utf8' });
    fsModule.fsyncSync(fd);
    fsModule.closeSync(fd); fd = undefined;
    fsModule.renameSync(tmp, p);
  } catch (e) {
    if (fd !== undefined) { try { fsModule.closeSync(fd); } catch { /* already failing */ } }
    try { fsModule.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

// Every .html under `dir` (recursive), as forward-slash paths relative to `dir`, sorted.
// A symbolic link is refused rather than followed: baking through a link would rewrite —
// and with writeFileAtomic, replace — whatever it points at, which may be outside --site.
export function listHtml(dir, fsModule = fs) {
  const out = [];
  for (const f of fsModule.readdirSync(dir, { recursive: true }).map(String)) {
    if (!f.endsWith('.html')) continue;
    const st = fsModule.lstatSync(path.join(dir, f));
    if (st.isSymbolicLink()) throw new Error(`${f} is a symbolic link — refused (bake the real file, not a link)`);
    if (st.isFile()) out.push(f.split(path.sep).join('/'));
  }
  return out.sort();
}

// ── money: integer cents everywhere ──────────────────────────────────────────
// Every price inside the baker is an integer number of minor units (cents for USD). A v1
// feed's float dollars are converted once, at load, through validateFeedPrice (which has
// already refused anything that is not a whole number of cents); a v2 feed carries the
// integer directly. No arithmetic is ever done on a float price.

export const MAX_AMOUNT_MINOR = 1e11;   // 1e9 dollars, same ceiling as validateFeedPrice
export function validateAmountMinor(amount, id) {
  if (!Number.isInteger(amount) || amount < 0 || amount >= MAX_AMOUNT_MINOR) {
    throw new Error(`feed amountMinor ${JSON.stringify(amount)} for ${id} is not an integer in [0, ${MAX_AMOUNT_MINOR}) — refusing`);
  }
  return amount;
}

// The formatter below assumes a two-decimal currency written with "$". That is USD; a
// feed declaring anything else is refused rather than formatted wrongly.
export const SUPPORTED_CURRENCIES = new Set(['USD']);
export function validateCurrency(c) {
  if (typeof c !== 'string' || !SUPPORTED_CURRENCIES.has(c)) {
    throw new Error(`feed currency ${JSON.stringify(c)} is not supported (this tool formats ${[...SUPPORTED_CURRENCIES].join(', ')} only)`);
  }
  return c;
}

export function dollarsToCents(price) {
  return Math.round(price * 100);   // safe: validateFeedPrice guarantees whole cents
}

// 100000 -> "1000.00"; 1250 -> "12.50"; 5 -> "0.05"
export function centsToText(cents) {
  const s = String(cents);
  const padded = s.length < 3 ? '0'.repeat(3 - s.length) + s : s;
  return padded.slice(0, -2) + '.' + padded.slice(-2);
}

// "1,000.00" -> 100000 ; "12.00" -> 1200. Input is always the baker's own price regex
// match (digits, optional commas, exactly two decimals), so this never sees a float.
export function textToCents(s) {
  const [int, dec] = String(s).replace(/,/g, '').split('.');
  return parseInt(int, 10) * 100 + parseInt(dec, 10);
}

// 100000 -> "1,000.00" when grouped, "1000.00" otherwise.
export function formatPrice(cents, grouped) {
  const fixed = centsToText(cents);
  if (!grouped) return fixed;
  const [int, dec] = fixed.split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
}
