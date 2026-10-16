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
//   parsePriceText /   read "$1,000.00" as 1000; write it back the way the page had it.
//   formatPrice

import dns from 'node:dns';
import net from 'node:net';

export const CATALOG_ID_RE = /^[A-Z0-9]{20,}$/;

export function validateFeedId(id, name) {
  if (typeof id === 'string' && CATALOG_ID_RE.test(id)) return id;
  const shown = JSON.stringify(String(id)).slice(0, 80);
  throw new Error(`feed id ${shown} (item ${JSON.stringify(String(name))}) is not a catalog id — `
    + 'expected /^[A-Z0-9]{20,}$/. Refusing to write it into HTML.');
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
]) BLOCKED.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128],         // unspecified
  ['::1', 128],        // loopback
  ['fc00::', 7],       // unique local (the IPv6 analogue of RFC 1918)
  ['fe80::', 10],      // link-local
]) BLOCKED.addSubnet(a, p, 'ipv6');

// ::ffff:a.b.c.d and ::ffff:7f00:1 are IPv4 addresses in IPv6 clothing: check them as IPv4.
// (Node 24's BlockList already matches these against the IPv4 rules; unmapping here keeps
// the check independent of that, on every Node version in the CI matrix.)
export function unmapIPv4(addr) {
  const m = /^::ffff:(.+)$/i.exec(addr);
  if (!m) return null;
  if (net.isIPv4(m[1])) return m[1];
  const h = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]);
  if (!h) return null;
  const hi = parseInt(h[1], 16), lo = parseInt(h[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
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

// "1,000.00" -> 1000 ; "12.00" -> 12
export function parsePriceText(s) {
  return Number(String(s).replace(/,/g, ''));
}

// 1000 -> "1,000.00" when grouped, "1000.00" otherwise.
export function formatPrice(n, grouped) {
  const fixed = n.toFixed(2);
  if (!grouped) return fixed;
  const [int, dec] = fixed.split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
}
