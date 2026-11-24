# Guarantees

What pricelock checks, where each check runs, what has to pass before a change reaches
consumers, and what can go around it. A check that nothing forces you to run is a tool, not
a gate; this page says which is which.

## Where each check runs

| Check | Locally | CI (every push and PR) | Required before `main` changes |
|---|---|---|---|
| `bake-prices --check` — the committed tree matches the catalog; no unread price-like markup (strict) | if you run it | yes, Node 18.17.0 / 20 / 22 | **yes** (status checks `parity (…)`) |
| `node --test` — parity (visible == JSON-LD == snapshot, incl. currency) and every regression suite | if you run it | yes, same matrix | **yes** |
| `npm audit --omit=dev` | if you run it | yes | **yes** (same job) |
| `bake-prices --write` | yes — this is the only place prices change | never (CI does not write) | — |

Nothing runs automatically on your machine: there is no pre-commit hook.

## The release gate

There are no tags, GitHub releases or npm package. Consumers use `main`; **a merge to `main`
is the release.** The `main` ruleset (active, default branch) requires:

- a pull request (no direct push), with the three required status checks above passing on
  an up-to-date branch, reported by the GitHub Actions app — another app or a manual status
  cannot satisfy them;
- no force-push and no deletion of `main`.

Required approving reviews: 0 (single maintainer). The PR and CI are the gate, not a reviewer.

## What can bypass it

- **Ruleset bypass actors and admins.** Anyone on the ruleset's bypass list, or any admin who
  edits or disables the ruleset, can change `main` without the checks. Confirm the bypass
  list in *Settings → Rules → main* is empty; it is not readable with a read-scoped token.
- **Other branches and tags** are not gated. They are not a release channel here; do not
  point consumers at them.
- **Your own site's deploy.** CI proves the *demo* tree. A site that uses pricelock is only
  gated if its own pipeline runs `bake-prices --check` and `bin/check-parity.mjs` against its
  own paths and blocks publishing on both. `check-parity` has no default paths and prints
  the tree it verified, so a pass on the demo cannot be read as a pass on another site.
  Deploying a tree by any other route (an upload, a CMS, a hotfix) skips both.
- **`--allow-unread`** downgrades unread price-like markup, and priced rows the catalog does
  not know, to a warning. CI never passes it.
- **Resealing.** The parity check is a consistency check, not a seal: whoever can edit the
  catalog file can run `--write` and every surface will agree on the new number. Only
  `--check` against the real catalog ties the site to the source.

## What a passing run guarantees

For every managed item (an anchored id; or an unanchored name that maps to exactly one
catalog record, or to exactly one within the section it sits in — never chosen by the price
on the page), on every `.html` file under `--site` (not reached through any symbolic link):

- the visible price, the JSON-LD offer's `price`, and the snapshot agree with the catalog;
- the JSON-LD offer's `priceCurrency` is the catalog currency, and its `identifier` is the id;
- every ld+json block parses (an unparseable one is refused, never skipped) and none has a
  duplicate key, so what a parser reads is what was checked;
- every ld+json block uses only plain schema.org terms: its `@context`, if any, is the string
  `http(s)://schema.org` at the top of the block, no key is an IRI or prefixed name, and no
  keyword outside `@context @type @id @graph @value @language @list @set` appears — so no
  other spelling or alias of `price` can sit beside the one that was checked;
- a managed MenuItem and its Offer carry no `@id`, so no other node can merge a second offer,
  price, currency or identifier into them;
- no managed price node or ld+json block sits inside an HTML comment, `<template>`,
  `<noscript>`, `<textarea>`, `<title>`, `<style>`, `<xmp>`, `<iframe>`, `<noembed>`,
  `<noframes>` or a non-JSON-LD `<script>` (found by a forward pattern scan; a hit is refused);
- a visible anchor is exactly one lowercase `data-sq-item="…"`; any other casing or a second
  copy is refused, so the id the baker read is the id a browser keeps;
- every node `@type` in every ld+json block is a schema.org type (`Term`, `schema:Term` or
  `http(s)://schema.org/Term`), so a managed MenuItem or Offer is schema.org's, not a
  same-named type from another vocabulary; a block with no `@context` is still read;
- every priced row in the menu's own markup, and every priced JSON-LD MenuItem, is either a
  managed item or has been reported (strict: refused) — an unknown name is not a way past;
- `--snapshot` is not, and does not resolve to, the catalog file or a page (checked at
  start-up, by real path and by device+inode);
- the catalog, read from a file or a URL, has no duplicate key at any depth (the same holds
  for a saved or live Square response in `square-to-feed`, and for the snapshot in
  `check-parity`), so the value this run read for a key is the only one in the file;
- a name shared by several ids is resolved within a section only when exactly one of them is
  listed under that section — every section an id is listed under counts, and section names
  are compared ignoring case and spacing;
- with `--location <id>`: the catalog is schemaVersion 2 and its `locationId` is exactly
  `<id>`. Without the flag the catalog's location is recorded and compared with nothing;
- every other JSON-LD price key (`price`, `lowPrice`, `highPrice`, `minPrice`, `maxPrice`)
  and every price-like text the detector recognizes outside JSON-LD has been reported
  (strict: refused).

## What it does not guarantee

- **That the catalog is complete, current, or the real one.** A passing run ties the site to
  the catalog file it was given. It does not show that the file holds every item (a saved
  Square response is refused only when its last page still carries a `cursor`; pages missing
  from the middle, or a flat list of objects, cannot be detected offline), that it is recent
  (`cachedAt` is when the catalog last changed; `fetchedAt` is the adapter's own record of a
  live fetch, unverified, absent for `--input`, and no maximum age is enforced), or that it
  came from the POS at all (a feed is not signed).
- **`--location` is only as good as the pipeline that passes it.** It compares two strings:
  the one on the command line and the one in the feed. It does not ask the POS which
  location a feed came from.
- **One parser reads every surface.** The baker, `check-parity` and the tests share
  `lib/jsonld.mjs` and `lib/extract.mjs`. A defect there is common to all three: they would
  agree with each other and be wrong together. The suites pin known cases; no second,
  independent implementation cross-checks them.
- **The deployed site.** Every check reads a tree on disk. Nothing here fetches the published
  pages or compares them with the tree that passed (see "Your own site's deploy" above).

- **The detector outside JSON-LD is lexical.** After decoding character references it sees a
  dollar sign (`$`, `＄`, `﹩`) before a digit (ASCII or full-width) — through whitespace,
  no-break and zero-width spaces, and up to 16 inline tags or comments of up to 256
  characters each — any JSON-style key that decodes to a price key, microdata `itemprop`
  price properties, and Open Graph `product:price:amount`. It does not see a price in an
  image, in CSS `content`, rendered by script, spelled out, written after the number
  (`1.00 $`), or without a currency sign.
- **Items whose name is not in the catalog are not priced.** One that shows a price is reported
  and refused (strict), on either surface; one with no price is left alone silently. Under
  `--allow-unread` both are left as they are, so the two surfaces of such an item may disagree.
- **`--allow-unread` is all-or-nothing.** There is no per-item exemption list.
- **The demo's parity test is site-wide.** `test/parity.test.js` asks for a visible node and a
  JSON-LD entry somewhere under the demo site. `bin/check-parity.mjs` is per page by default
  (the ids a page shows are the ids its JSON-LD describes); `--site-wide` turns that off.
  Neither checks unanchored prices or the catalog — that is `bake-prices --check`.
- **HTML is matched by pattern, not parsed.** The visible node must be the documented markup
  (attribute order matters; other forms are refused, not mis-priced). The ld+json script
  boundary is found by pattern, with the `type` decoded as a browser decodes it. Inert
  regions are found by a pattern scan too; content hidden by the `hidden` attribute, CSS, a
  closed `<details>` or script is treated as live.
- **An anchored id is trusted.** The baker prices an anchored node by its id and does not
  compare the name shown beside it with the catalog name for that id. A row hand-anchored
  to the wrong id shows that id's price under its own name, and every gate passes. The
  snapshot records the catalog name per id; reviewing it against the page is manual.
- **JSON-LD is not expanded.** The vocabulary rules above are a narrower contract than
  JSON-LD: valid markup that uses a custom context, prefixed keys, or an `@id` on a managed
  item is refused, not interpreted. A consumer that fetches a different schema.org context
  than the published one is out of scope.
- **Writes:** each file is replaced atomically; the set of files is not. Power loss after a
  rename may lose the directory entry. Two bakers on one tree are not coordinated. A
  directory swapped for a symbolic link *between* listing and writing is not detected. The
  committed git tree is the unit of rollback. See README "Writes and recovery".
- **Fetching** an attacker-controlled `--src` is not made safe in general; the address checks
  stop loopback, private, link-local, metadata and non-global-unicast targets.
