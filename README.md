# pricelock

**Write catalog prices into a static site's HTML when you run it — keyed by catalog item id, with a committed snapshot and an offline consistency check.**

This is a reference implementation — *show-your-work*, not a product. It is the working example behind [**"What the all-in-one ordering platforms don't tell independent restaurants"**](https://10ustech.com/insights/restaurant-ordering-platform-lock-in) on the 10 US Tech Inc. Insights blog. Read that piece for the argument; read this repo for the mechanism.

It runs on bundled demo data, with no credentials:

```bash
node bin/bake-prices.mjs --check   # would baking from demo/catalog.json change the committed site?
node --test                        # offline check: visible == JSON-LD == snapshot
```

No install step, no dependencies, no tokens, no database.

**What this repo is not:** it does not talk to the Square Catalog API, or to any point-of-sale system. The demo catalog is a **demo fixture** in a simplified menu-feed shape (below). Using a real POS means writing an adapter that turns its API response into that shape.

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

`.github/workflows/ci.yml` runs both the drift check and the consistency check on every push.

---

## Known limits

- **Catalog shape.** Only the simplified feed shape below is read. Not the Square Catalog API, not any vendor's response. Entries without a numeric `price` or an `id` (for example variable-priced items) are skipped.
- **Price-node matching covers the demo markup only.** A visible price is found only as `<h3 class="item-name">Name</h3>` directly followed by `<div class="item-price">$N.NN</div>`, with sections taken from `<h2 class="cat-title">`. JSON-LD is found only as a `MenuItem` whose `"name"` comes right after `"@type"` (an `"@id"` in between is allowed) and whose `offers.price` is a string with two decimals. Other markup is not read, and nothing reports that it was skipped.
- **Unknown names are left alone silently.** An unanchored row whose name is not in the catalog is not priced and not flagged.
- **The consistency check covers anchored nodes only.** A price node without `data-sq-item` / `"identifier"` is not checked.
- **Formats.** Dollar sign and exactly two decimals; one currency (`USD` in the JSON-LD is whatever the page already says).
- **Fetching.** `--src` accepts a URL and fetches it with no authentication and a 15-second timeout. A real POS API that needs a token is out of scope for this repo.
- **Snapshot provenance.** The snapshot records the source path and the feed's `cachedAt`, not who ran the baker or when.
- **Freshness.** Nothing runs on a schedule. Prices are as current as the last `--write` that was committed.

---

## Files

| Path | What it is |
|---|---|
| `bin/bake-prices.mjs` | The baker. `--check` (no write) / `--write` (rewrite in place). |
| `demo/catalog.json` | A neutral **demo fixture** in the simplified menu-feed shape, including the name-collision twin. |
| `demo/site/menu.html` | A demo static page: visible prices + JSON-LD, every node anchored by id. |
| `demo/prices.snapshot.json` | The committed snapshot (generated by `--write`). |
| `test/parity.test.js` | The offline three-way consistency check. |
| `.github/workflows/ci.yml` | Drift check + consistency check in CI. |

## Using your own catalog

Point `--src` at any catalog in the same shape — a file, or a URL that returns it:

```bash
node bin/bake-prices.mjs --write --src ./my-catalog.json --site ./public --snapshot ./public/prices.snapshot.json
```

There is deliberately **no** `.env`, no secret, and no real catalog anywhere in this repo. Keep it that way: commit prices, never keys.

Catalog shape (the demo fixture's format; not a vendor API):

```json
{
  "cachedAt": "2026-01-01T00:00:00Z",
  "menu": [
    { "name": "Lunch",  "items": [ { "id": "…", "name": "…", "price": 12.00 } ] },
    { "name": "Dinner", "items": [ { "id": "…", "name": "…", "price": 16.00 } ] }
  ]
}
```

## Status

Reference artifact, published to show how we do this. It is archived read-only — issues and pull requests are closed by design. If it's useful to you, fork it.

## License

MIT © 2026 10 US Tech Inc.
