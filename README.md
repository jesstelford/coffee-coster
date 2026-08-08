# Coffee Coster

A mobile-first map of what a coffee costs around Australia.

Every pin is one person's self-reported coffee price, scraped from a single
r/AskAnAustralian thread — ["How much was your coffee this morning"][thread]
(post `1vii42k`). Pins cluster as you zoom out, and each cluster shows the
**median** price of the coffees inside it. There's a fuzzy suburb search so you can
jump straight to your own neighbourhood.

77 coffees are mapped. Prices run from $3.00 to $11.50, median $6.50.

[thread]: https://www.reddit.com/r/AskAnAustralian/comments/1vii42k/how_much_was_your_coffee_this_morning/

## Data caveat — read this first

**This is not a survey.** It is 77 self-reported prices from one Reddit thread on one
morning. Treat it as a conversation starter, not a price index.

Specifically:

- **Self-reported and unverified.** Nobody checked a receipt. Cup size, milk and
  drink type vary wildly and are often unstated.
- **One thread, one morning.** No sampling frame, no weighting, no repeat
  observations. Reddit's Australian userbase is not Australia.
- **Locations are parsed out of free text.** People wrote "Newtown" or "bayside
  Melbourne", not coordinates. Suburb names are matched against a gazetteer and
  ambiguous ones (there are a lot of Richmonds) are resolved by heuristics. Each
  coffee carries a `confidence` of `high` / `medium` / `low` — currently 50 / 12 / 15.
- **15 pins are region-level approximations.** When a commenter named a region
  ("Regional NSW", "Inner West Sydney") rather than a suburb, the pin borrows a
  nearby town's coordinates and is flagged `approximate`. It indicates a rough area,
  not an address. Nobody's actual cafe is at that dot.
- **The mapped maximum is not the thread maximum.** 102 comments had a usable price
  but no resolvable location, and were dropped. Higher prices exist in the thread
  than appear on the map. Any claim the UI makes is about the *highest mapped*
  price.
- **Other exclusions**, all deliberate: home-made or free coffees (11), coffees
  bought overseas (7), per-kilo bean and equipment prices, and 11 manual overrides.
  Prices outside AUD 1.00–15.00 are treated as implausible for a single cup.

Coverage is also lopsided: VIC 28, NSW 25, QLD 15, SA 5, WA 3, NT 1, and nothing at
all for TAS or ACT.

## Running it

```sh
npm install     # install dependencies
npm run dev     # Vite dev server
npm run build   # production build to docs/ (committed, served by GitHub Pages)
npm run preview # serve the built site
npm run data    # regenerate public/data/*.json (see below)
```

The app is static — the build output is plain files, no server needed.

## The data pipeline

`npm run data` runs three Node scripts in order. All are ESM, Node 22, and cache
their downloads under `data/raw/` so re-runs work offline.

1. **`scripts/fetch-thread.mjs`** — pulls the post and full comment tree.
   It reads from the [Arctic Shift][arctic] public archive, **not** from reddit.com,
   because reddit.com returns HTTP 403 to datacenter IPs on every route (`.json`
   endpoints, old.reddit, text proxies, redlib mirrors). Don't "fix" this script by
   pointing it back at Reddit — it will just fail. Writes
   `data/raw/thread-post.json` and `data/raw/thread-comments.json`.
2. **`scripts/build-gazetteer.mjs`** — downloads the [GeoNames][geonames] AU postcode
   export and flattens it into `public/data/suburbs.json`: 17,522 localities as
   compact `[name, state, lat, lon]` rows, to keep the mobile payload small.
3. **`scripts/extract-coffees.mjs`** — the real work. Parses prices out of comment
   text (`$6.50`, `8$`, `5 bucks`, "six fiddy", ranges → midpoint), rejects
   non-cup numbers, resolves locations by longest-first n-gram match against the
   gazetteer, and jitters coffees that share a suburb onto a ring around its
   centroid so they don't stack. Writes `public/data/coffees.json`.

   Where a comment names no place, it falls back to the commenter's **subreddit
   flair** — a location they attached to their own comment and published with it —
   then to thread context. Flair is capped at `medium` confidence because it says
   where a person is, not where that cup was bought.

`data/overrides.json` is the hand-maintained fix file that steers step 3 — aliases
for regions and nicknames, a `prefer` map for ambiguous duplicate place names,
state hints, a stoplist of words that must never match a place, and explicit
`exclude` / `force` lists. **This is the file you edit** when the extractor gets
something wrong.

Two properties the pipeline is built to guarantee:

- **Output is deterministic.** Jitter is hash-derived, not random, and timestamps
  come from the raw file's mtime rather than `Date.now()`. Re-running the extractor
  over the same cache produces byte-identical JSON — a clean `git status` after
  `npm run data` is the expected result, not a coincidence.
- **Generated JSON is never hand-edited.** `public/data/coffees.json` and
  `public/data/suburbs.json` are build products. To change them, change a script or
  `data/overrides.json` and re-run. See `DATA_CONTRACT.md` for their exact shape.

[arctic]: https://arctic-shift.photon-reddit.com
[geonames]: https://www.geonames.org/

## Tech choices

| Choice | Why |
| --- | --- |
| **MapLibre GL** + **OpenFreeMap** tiles | Free, keyless, no usage caps and no account. Nothing to rotate, nothing to bill. Style: `tiles.openfreemap.org/styles/liberty`. |
| **supercluster** | Clusters client-side with a custom reducer that keeps every child price, so a cluster can display the true **median** rather than an average — one $9 coffee shouldn't drag a suburb's headline number around. |
| **Fuse.js** | Fuzzy suburb search entirely in the browser against the bundled gazetteer. No geocoding API means no key, no quota, no per-keystroke network call. The ~750 KB gazetteer is lazy-loaded on first focus of the search box, so it never blocks first paint. |
| **Vite** | Build tool only. No framework — the UI is small enough that plain DOM is less code than a component library. |

## Tests

Two dependency-free node scripts, run directly:

```sh
node scripts/test-cluster.mjs   # 32 passed, 0 failed
node scripts/test-search.mjs    # 28 passed, 0 failed
```

`test-cluster.mjs` exercises the cluster median maths against the exact supercluster
configuration the app uses — odd/even medians, that the reducer neither drops nor
duplicates prices when clusters merge across zoom levels, and that child props
aren't mutated between queries. `test-search.mjs` covers fuzzy matching, state-suffix
queries, and the recent-searches list (cap, dedupe, ordering, junk input).

## Deploying

The site is completely static — no server rendering and no runtime API. Prices and
the suburb gazetteer are generated ahead of time into `public/data/`, map tiles come
from OpenFreeMap's CDN, and the search index is built in the browser. Any static
host will serve it.

`npm run build` writes to **`docs/`**, which is committed, so GitHub Pages can serve
it straight from the default branch with no deploy workflow or `gh-pages` branch:

> Settings → Pages → Source: *Deploy from a branch* → Branch: `main`, folder: `/docs`

`vite.config.js` sets `base` to `/coffee-coster/` because project pages are served
from a sub-path. For a user/organisation page or a custom domain at the domain root,
build with `BASE_PATH=/ npm run build`.

Re-run `npm run build` and commit `docs/` whenever `src/` or the data changes —
the deployed site is whatever `docs/` contains, not what `src/` says.

## Attribution

- Map tiles by [OpenFreeMap](https://openfreemap.org/), using
  [OpenMapTiles](https://openmaptiles.org/) schema. Map data ©
  [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
- Locality gazetteer from [GeoNames](https://www.geonames.org/).
- Prices from the r/AskAnAustralian thread
  ["How much was your coffee this morning"][thread] and the people who commented on
  it. Usernames and permalinks are kept so every pin links back to its source
  comment.
