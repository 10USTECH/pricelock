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
  gated if its own pipeline runs `--check` and the parity test and blocks publishing on them.
  Deploying a tree by any other route (an upload, a CMS, a hotfix) skips both.
- **`--allow-unread`** downgrades unread price-like markup to a warning. CI never passes it.
- **Resealing.** The parity check is a consistency check, not a seal: whoever can edit the
  catalog file can run `--write` and every surface will agree on the new number. Only
  `--check` against the real catalog ties the site to the source.

## What a passing run guarantees

For every managed item (an anchored id, or a name that resolves to exactly one catalog
record), on every `.html` file under `--site` (not reached through any symbolic link):

- the visible price, the JSON-LD offer's `price`, and the snapshot agree with the catalog;
- the JSON-LD offer's `priceCurrency` is the catalog currency, and its `identifier` is the id;
- no JSON-LD block has a duplicate key, so what a parser reads is what was checked;
- every other JSON-LD price key (`price`, `lowPrice`, `highPrice`, `minPrice`, `maxPrice`)
  and every price-like text the detector recognizes outside JSON-LD has been reported
  (strict: refused).

## What it does not guarantee

- **The detector outside JSON-LD is lexical.** It sees a dollar sign (literal, `&#36;`,
  `&#x24;`, `&dollar;`, `＄`, `﹩`) before a digit — through whitespace, `&nbsp;` and inline
  tags — a `"price":` key, microdata `itemprop` price properties, and Open Graph
  `product:price:amount`. It does not see a price in an image, in CSS `content`, rendered by
  script, spelled out, or written without a currency sign.
- **Items whose name is not in the catalog are left alone,** silently, on both surfaces.
- **HTML is matched by pattern, not parsed.** The visible node must be the documented markup
  (attribute order matters; other forms are refused, not mis-priced). The ld+json script
  boundary is a pattern; a block inside an HTML comment is processed as if live.
- **Writes:** each file is replaced atomically; the set of files is not. Power loss after a
  rename may lose the directory entry. Two bakers on one tree are not coordinated. A
  directory swapped for a symbolic link *between* listing and writing is not detected. The
  committed git tree is the unit of rollback. See README "Writes and recovery".
- **Fetching** an attacker-controlled `--src` is not made safe in general; the address checks
  stop loopback, private, link-local, metadata and non-global-unicast targets.
