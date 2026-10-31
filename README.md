# pricelock

**Write catalog prices into a static site's HTML when you run it — keyed by catalog item id, with a committed snapshot and an offline consistency check.**

This is a reference implementation — *show-your-work*, not a product. It is the working example behind [**"What the all-in-one ordering platforms don't tell independent restaurants"**](https://10ustech.com/insights/restaurant-ordering-platform-lock-in) on the 10 US Tech Inc. Insights blog. Read that piece for the argument; read this repo for the mechanism.

It runs on bundled demo data, with no credentials:

```bash
node bin/bake-prices.mjs --check   # would baking from demo/catalog.json change the committed site?
node --test                        # offline check: visible == JSON-LD == snapshot
```

No install step, no dependencies, no tokens, no database.

**What this repo is, and is not:** the baker reads a simplified menu-feed shape (below), never a vendor API directly. One adapter ships with it — `bin/square-to-feed.mjs`, which turns a Square location's catalog into that shape, read-only, token from the environment, testable offline. Other POS systems need an adapter of their own. The bundled demo catalog is a **demo fixture**, not a real menu.

---

## The problem: price drift

A restaurant runs a fast static/Jamstack site *and* a point-of-sale system. The POS is the real source of prices. The static site has prices typed into HTML. The two drift apart the moment someone changes a price at the register — the site quietly shows yesterday's number, and so does every price a search engine or AI assistant reads out of the page.

The three obvious fixes each fail:

- **Edit the HTML by hand every time a price changes.** It doesn't scale, and it silently rots — nobody re-types a menu the day a price moves.
- **Move onto an all-in-one ordering platform.** It ends the drift by taking the site, the SEO surface, and the customer relationship with it — the lock-in the Insights piece is about.
- **Fetch prices live from an API at request time.** Now every page view depends on the POS being reachable, and the price isn't in the HTML a crawler indexes.

## The approach: bake, commit, ship

Read the catalog feed, and **write the price into the committed HTML** — both the visible node and the JSON-LD. The published site is plain static files; nothing is fetched at request time. When a price changes at the register, you re-run the baker, commit the diff, and ship. Prices on the site are as current as the last time someone ran it.

```
catalog feed ──(when you run it)──▶ bake-prices ──▶ committed HTML (visible + JSON-LD)
                                                 └──▶ prices.snapshot.json
```

## The landmine: key by item id, never by display name

This is the bug that bites everyone who builds this the quick way.

Two menu items can share a **display name** and cost **different amounts** — a lunch/dinner twin. In the demo catalog, *House Salad* is **$12 at lunch** and **$16 at dinner**: two distinct catalog entries, two ids, one name.

Build a `{ name → price }` map and you get **last-wins**: whichever *House Salad* the loop sees last overwrites the other, and half your menu is silently mispriced. Nothing errors. The page looks fine. The number is just wrong.

So every price node is anchored to the catalog **id**, not its name:

```html
<div class="item-price" data-sq-item="HOUSESALADLUNCH0000000001">$12.00</div>
```
```json
{ "@type": "MenuItem", "name": "House Salad", "identifier": "HOUSESALADLUNCH0000000001",
  "offers": { "@type": "Offer", "price": "12.00", "priceCurrency": "USD" } }
```

Once a node carries its id, it is priced by that id. The only place names are used is to *attach* an id to a still-unanchored row, and there the resolver **fails closed**: if a name maps to more than one catalog entry and neither the current price nor the section disambiguates it, the baker exits with an error and writes nothing rather than guess.

## The snapshot: a three-way consistency check, not a seal

`bake-prices --write` also emits `demo/prices.snapshot.json` — a sorted `{ id → { name, price } }` record of what was baked. `test/parity.test.js` then checks, **with no catalog and no network**, that for every anchored id the three surfaces agree:

> visible price  ==  JSON-LD price  ==  snapshot price

Hand-edit one price in one place and the check fails. That catches a half-made edit and a stale page.

**It does not prove the prices are right, and it is not tamper-proof.** Whoever edits a price can reseal it: change the catalog file and run `--write`, or hand-edit the same price in all three places, and the check passes on the new number. What ties prices back to their source is `bake-prices --check` against the catalog feed, and that needs the feed. In this repo the feed is the committed demo file, so CI shows the site matches *that file*, not any live POS.

`.github/workflows/ci.yml` runs the drift check and the consistency check on every push.

---

## What the baker refuses

Every check below stops the run before a single file is written (exit 1, named cause on stderr).

- **Feed ids** must match `/^[A-Z0-9]{20,}$/` — they are written into HTML attributes and JSON-LD.
- **Feed prices** must be finite, non-negative, a whole number of cents, and below 1,000,000,000 — anything else `toFixed(2)` would round or render as `1e+21`. Entries whose `price` is not a number (variable-priced items) are skipped, as before.
- **One id, one price.** The same id listed twice with identical name and price is one record; the same id with a different price or name is refused (last-wins would bake one price into the HTML and write the other into the snapshot).
- **Anchor attributes** must appear exactly once per node as `data-sq-item="…"` (double quotes). A single-quoted or duplicated anchor would leave two attributes on the node, and the browser keeps the first.
- **JSON-LD is parsed, not pattern-matched** (since v1.4). Key order and `\u` escapes do not matter. Refused: a **duplicate key** anywhere in a block (parsers keep the *last* value, so a crawler would read a different value than the one checked); a managed `MenuItem` whose offer is not exactly one `Offer` with a `"price"` string such as `"12.00"` (an `AggregateOffer`, a numeric price, a `priceSpecification`, several offers); an ld+json block that mentions a `MenuItem` or a price and does not parse; `MenuItem` text outside a `<script type="application/ld+json">` block (a comment or a `<pre>` sample).
- **The offer is `(identifier, price, priceCurrency)`.** All three come from the catalog. A managed offer in the wrong currency, or with no `priceCurrency`, is a change `--check` reports and `--write` corrects — the same as a wrong price. Only the values that differ are rewritten; every other byte of the block is kept.
- **Symbolic links** under `--site` are refused, not followed — a linked `.html` file *and* a link to a directory (v1.3 followed linked directories; see `docs/AUDIT-2026-10-30.md` H1). Every file baked must also resolve inside the real path of `--site`. A link to a non-HTML file (an image) is ignored.
- **Price-like markup it cannot read** is an error with file and line: in JSON-LD, any `price` / `lowPrice` / `highPrice` / `minPrice` / `maxPrice` key that is not the one price of a managed item's offer; outside JSON-LD, a dollar sign (literal, `&#36;`, `&#x24;`, `&dollar;`, `＄`, `﹩`) followed by a digit — whitespace, `&nbsp;` and inline tags in between are seen through — a `"price":` key, microdata `itemprop="price"` (and its range forms), and Open Graph `product:price:amount`. `--allow-unread` downgrades it to a `WARN` and leaves the markup as is; CI does not pass that flag. The outside-JSON-LD detector is lexical — `GUARANTEES.md` lists what it cannot see.

## Known limits

- **Catalog shape.** Only the simplified feed shape below is read (v2 with integer `amountMinor`, or the older v1 with float `price`). Not a vendor's response — that is what an adapter is for. Prices are integer cents inside the baker; a v1 float is converted once, at load, after being checked for whole cents. Only `USD` is formatted; a v2 feed declaring another currency is refused.
- **Price-node matching covers the demo markup only.** A visible price is found only as `<h3 class="item-name">Name</h3>` directly followed by `<div class="item-price">$N.NN</div>`, with sections taken from `<h2 class="cat-title">`. Attribute order matters there: `data-sq-item` before `class` is not matched (it is refused as unreadable, not mis-priced). JSON-LD is any `MenuItem` (`"@type"` of `MenuItem`, `schema:MenuItem` or the full IRI) in a parsed ld+json block, with one `Offer` whose `price` is a string with two decimals. Other markup is not read; it stops the run unless `--allow-unread` is passed, in which case it is reported as a `WARN` with file and line and left as is. Only `.html` files are read (not `.htm`).
- **Unknown names are left alone silently.** An unanchored row whose name is not in the catalog is not priced and not flagged. Names are compared after whitespace/case folding only; an HTML entity in the page (`&amp;`) does not match the raw character in the feed, so such a row stays unanchored until an id is added by hand.
- **The consistency check covers anchored nodes only.** A price node without `data-sq-item` / `"identifier"` is not checked (the baker's default refuses such nodes before they are committed). For every identified JSON-LD offer it checks price **and** currency against the snapshot; an identified item with no readable single offer fails the check. Every snapshot id must have both a visible node and a JSON-LD entry somewhere on the site; the check does not verify that the name next to an id matches the catalog name — ids, not names, are the key.
- **Formats.** Dollar sign and exactly two decimals; one currency, `USD` — written into each managed offer's `priceCurrency`. A visible price with a thousands separator (`$1,000.00`) is read, and written back with one; JSON-LD prices are written without separators (`"1000.00"`).
- **Fetching.** `--src` accepts an `https:` URL only, with no `user:password@` part, and fetches it with no authentication, a 15-second idle timeout, a 30-second overall deadline, and an 8 MiB response ceiling. The host must resolve only to public addresses — loopback, RFC 1918, carrier-NAT, link-local, multicast, reserved, documentation and benchmarking ranges are refused, IPv6 forms that embed an IPv4 address are judged by that address (IPv4-mapped, IPv4-compatible, NAT64 `64:ff9b::`, 6to4 `2002::`), and any other IPv6 address must be global unicast (`2000::/3`) outside Teredo, benchmarking, ORCHID and documentation ranges — so SIIT `::ffff:0:…`, NAT64 local-use `64:ff9b:1::`, site-local `fec0::` and the like are refused — checked before the fetch and again when the connection opens. Redirects are refused: point `--src` at the final URL. A real POS API that needs a token is out of scope for this repo.
- **Snapshot provenance.** The snapshot (v2) records the source path (for a URL, origin and path only: no query string, fragment or credentials), the feed's `cachedAt`, `locationId` and `currency`, and integer `amountMinor` per id — not who ran the baker or when.
- **Freshness.** Nothing runs on a schedule. Prices are as current as the last `--write` that was committed.

## Writes and recovery

`--write` bakes every file in memory first; if any check fails, nothing is written. When it does write, each file is replaced through a sibling temp file, `fsync`, and `rename`, so a reader of any one page sees either the old bytes or the new bytes — never a truncated file — even if the baker is killed mid-write. Pages are written first, the snapshot last.

What that does **not** give you:

- **The set of files is not atomic.** If the process dies between two pages, the tree is half-baked (the parity check will say so). The unit of rollback is the git working tree: `git checkout -- <site-dir> <snapshot>` restores the last commit; re-run `--write` to redo the bake. There is no publication lock, no versioned release directory, and no rollback command in the tool — the committed tree *is* the version history, and deploying it is your site's build, not this script.
- **Power loss is not covered.** The file data is fsynced; the directory entry is not. On a crash of the whole machine a just-renamed file may still be missing. The same `git checkout` recovers it.
- **Two bakers on one tree** are not coordinated. Last write wins, per file. Don't.

## Security boundaries

- **The catalog feed is trusted input.** Ids and prices are validated before they are written; names are never written to HTML (the page's own name is kept). A malicious feed can still set any *valid* price. The feed is yours; keep it that way.
- **The site tree is trusted input.** The baker rewrites what it recognises and refuses what it half-recognises; it does not sanitise arbitrary HTML.
- **`--src` as a URL** goes through the checks above. They stop the baker from being pointed at a loopback, private, link-local or cloud-metadata address, by name or by literal, including a DNS answer that changes between the pre-check and the connection. They do not make fetching an attacker-controlled URL safe in general — don't accept `--src` from untrusted users.
- **Out of scope:** the POS itself, the deploy pipeline that publishes the committed tree, the CDN in front of it, and whoever can push to this repo. The parity check is a consistency check, not a seal (see above).

---

## Files

| Path | What it is |
|---|---|
| `bin/bake-prices.mjs` | The baker. `--check` (no write) / `--write` (rewrite in place); `--allow-unread` to tolerate price-like markup it cannot read. |
| `bin/square-to-feed.mjs` | The Square adapter: one location's catalog → v2 feed. Token from env; `--input` for offline runs. |
| `lib/square.mjs` | The pure Square-objects → feed transform behind the adapter. |
| `lib/guards.mjs` | The input checks the baker runs first: feed-id and feed-price shape, flag values, `https:`-only sources, public-address checks before the fetch and at connect time, no redirects, bounded response body, atomic file replacement, symlink refusal. |
| `lib/jsonld.mjs` | The JSON-LD layer: a strict parser that refuses duplicate keys and records value spans (so the baker edits one value and keeps every other byte), plus the offer rules shared by the baker and the parity check. |
| `lib/extract.mjs` | The read-only extractors the parity check uses: visible node, and JSON-LD MenuItem `(id, price, currency)` read through `lib/jsonld.mjs`. |
| `package-lock.json` | Empty-dependency lockfile, so `npm audit` can run. There are no dependencies. |
| `demo/catalog.json` | A neutral **demo fixture** in the simplified menu-feed shape, including the name-collision twin. |
| `demo/site/menu.html` | A demo static page: visible prices + JSON-LD, every node anchored by id. |
| `demo/prices.snapshot.json` | The committed snapshot (generated by `--write`). |
| `test/parity.test.js` | The offline three-way consistency check. |
| `test/security.test.js` | The input checks: feed-id shape, `https:`-only and public-address sources (incl. a DNS-rebinding case), redirects, credentials, flag values. No network needed. |
| `test/baker.test.js` | The baker on fixtures: drift, ambiguous name, missing id, `$1,000.00`, subfolders, unreadable-price warnings. Each runs in a temp copy. |
| `test/hardening.test.js` | Regression tests from the October 2026 audit, one per confirmed finding (see `docs/AUDIT-2026-10.md`), plus the v2 catalog-shape rules. |
| `test/adversarial.test.js` | Regression tests from the 2026-10-30 adversarial audit (`docs/AUDIT-2026-10-30.md`): each reproduced a wrong or unchecked price that passed both gates, a write outside `--site`, or a refusal of valid markup. |
| `test/square.test.js` | The Square adapter on a recorded-shape fixture: twins, location overrides, variations, variable pricing, skips, refusals, and an end-to-end bake. |
| `docs/AUDIT-2026-10.md` | The first audit record: what was checked, what was reproduced, what was changed, what remains. |
| `docs/AUDIT-2026-10-30.md` | The second (adversarial) audit record, against v1.3.0. |
| `GUARANTEES.md` | What is checked locally, in CI, before release, and what can be bypassed — and what the tool does not guarantee. |
| `test/fixtures/` | Neutral catalogs and pages for the two test files above. |
| `.github/workflows/ci.yml` | Drift check + consistency check in CI; read-only token, actions pinned by SHA. |

## Using your own catalog

Point `--src` at any catalog in the same shape — a file, or an `https:` URL that returns it. `--site` is read recursively, so every `.html` file under it, subfolders included, is baked. Feed ids must look like catalog ids (`/^[A-Z0-9]{20,}$/`); any other id stops the run before a file is written. Node 18.17 or later:

```bash
node bin/bake-prices.mjs --write --src ./my-catalog.json --site ./public --snapshot ./public/prices.snapshot.json
```

There is deliberately **no** `.env`, no secret, and no real catalog anywhere in this repo. Keep it that way: commit prices, never keys.

Catalog shape v2 (what the Square adapter writes and the demo uses):

```json
{
  "schemaVersion": 2,
  "cachedAt": "2026-01-01T00:00:00Z",
  "locationId": "…",
  "currency": "USD",
  "menu": [
    { "name": "Lunch",  "items": [ { "id": "…", "name": "…", "amountMinor": 1200 } ] },
    { "name": "Dinner", "items": [ { "id": "…", "name": "…", "amountMinor": 1600 } ] }
  ]
}
```

`amountMinor` is an integer in the currency's minor unit (`1200` is $12.00). An item without `amountMinor` (variable-priced) is on the menu but not baked. The v1 shape — no `schemaVersion`, float `"price": 12.00` — is still read.

### From Square

```bash
SQUARE_ACCESS_TOKEN=… node bin/square-to-feed.mjs --location <LOCATION_ID> --out my-catalog.json
node bin/bake-prices.mjs --check --src my-catalog.json --site ./public --snapshot ./public/prices.snapshot.json
```

The token is read from the environment only and never printed; the only host contacted is `connect.squareup.com` (`--sandbox`: `connect.squareupsandbox.com`), fixed in the code — that is an allowlist, not a validator. The adapter calls `POST /v2/catalog/search` for `ITEM` and `CATEGORY` objects, paginates, and emits one feed item per fixed-priced **variation** present at that location (the variation is the object that carries the price; two variations of one item get `Item (Variation)` names). A per-location price override wins over the base price. Deleted, archived, unsellable and not-at-this-location objects are skipped and listed on stderr. `cachedAt` is the catalog's latest `updated_at`, so an unchanged catalog re-fetches to a byte-identical feed and `--check` stays green.

To review what Square returned before any price reaches a page, or to run with no network at all, save the raw search response(s) and pass `--input saved.json` — the adapter is tested that way (`test/square.test.js`).

Not converted (by design): modifier pricing, scheduled pricing rules, tax-inclusive display, item options. Those change what a customer pays, not a variation's list price.

## Status

Reference artifact, published to show how we do this. Changes land only by pull request with CI green; it is not maintained as a product and issues are not triaged. If it's useful to you, fork it.

## License

MIT © 2026 10 US Tech Inc.
