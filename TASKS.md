# Coffee Coster — Build Plan

A mobile-first static website showing the cost of a coffee around Australia on a map,
scraped from the Reddit thread
[“How much was your coffee this morning”](https://www.reddit.com/r/AskAnAustralian/comments/1vii42k/how_much_was_your_coffee_this_morning/)
(r/AskAnAustralian).

## Architecture decisions

- **Map provider**: [MapLibre GL JS](https://maplibre.org/) rendering
  [OpenFreeMap](https://openfreemap.org/) vector tiles — completely free, no API key,
  no usage limits, self-hostable if it ever disappears.
- **Clustering**: [supercluster](https://github.com/mapbox/supercluster) with a custom
  map/reduce that carries every price into the cluster, so each cluster can display the
  **median** price. Cluster radius is naturally zoom-dependent (recomputed per zoom).
- **Markers**: custom DOM markers (not canvas symbols) so single prices render as a light-tan
  price card, and clusters render as the same card **stacked** (pseudo-element cards peeking
  out behind the top one) with a small count badge.
- **Data pipeline**: Reddit blocks datacenter IPs, so the thread is fetched from the
  [Arctic Shift](https://arctic-shift.photon-reddit.com/) archive API (full comment tree as
  JSON). A Node script extracts `(price, location)` pairs from comment text, geocodes them
  against a bundled Australian localities gazetteer, applies manual overrides for ambiguous
  entries, and emits `public/data/coffees.json`. The pipeline is re-runnable and committed.
- **Search**: suburb-level autocomplete over the same bundled gazetteer using fuzzy matching
  (Fuse.js), fully client-side — no geocoding API, no rate limits.
- **Recent searches**: last 3 searches kept in `localStorage`, shown as a single horizontal
  row of chips directly under the search bar.
- **Stack**: Vite + vanilla JS/CSS (no framework — the app is one page), mobile-first CSS
  with a relaxed tan/latte palette.

## Tasks

### 1. Project setup
- [x] Initialise Vite vanilla-JS project (`package.json`, `index.html`, `src/`)
- [x] Base mobile-first stylesheet with the tan palette (CSS custom properties)
- [x] `AGENTS.md` with project conventions
- [x] `README.md` with what/why/how-to-run

### 2. Data pipeline (scrape → clean → geocode)
- [x] Fetch full comment tree from Arctic Shift API (`scripts/fetch-thread.mjs`),
      cache raw JSON in `data/raw/`
- [x] Build an Australian localities gazetteer (suburb name, state, postcode, lat, lon)
      from the free GeoNames AU postcode dataset (`scripts/build-gazetteer.mjs`)
- [x] Extraction script (`scripts/extract-coffees.mjs`):
  - [x] Parse prices from free text (`$7.10`, `7.10`, `“$6 for a large”`, ranges, “free”)
  - [x] Parse locations (suburb/city/state mentions, “inner west Sydney”, “Palm Beach GC”…)
  - [x] Walk reply threads so a price in a reply inherits the location asked/answered nearby
  - [x] Sanity filters (AUD 1–15 range, ignore jokes/instant-coffee-at-home $0 unless real)
  - [x] Manual overrides file (`data/overrides.json`) for ambiguous/unmatched entries
- [x] Geocode matched locations against gazetteer; jitter identical coordinates slightly
- [x] Emit `public/data/coffees.json` (price, lat, lon, label, comment excerpt)
- [x] Review the cleaned dataset for junk (spot check against thread)

### 3. Map
- [x] MapLibre map with OpenFreeMap tiles, centred on Australia, sensible mobile defaults
- [x] Load `coffees.json` into supercluster (map/reduce accumulating price arrays)
- [x] Render clusters/points as DOM markers on `moveend`/`zoomend`
- [x] Single-point marker: light-tan price card (e.g. `$4.50`)
- [x] Cluster marker: same price card showing the **median**, styled as top of a stack,
      with a count badge
- [x] Tap cluster → zoom into cluster expansion zoom
- [x] Tap single point → popup with suburb, price and comment excerpt

### 4. Search
- [x] Search bar fixed at top (overlay on map), tan-themed
- [x] Fuzzy suburb autocomplete (Fuse.js over gazetteer), keyboard + touch friendly
- [x] Selecting a result flies the map to that suburb
- [x] Store last 3 searches in `localStorage`
- [x] Recent-searches chip row directly under the search bar (horizontal, single line)

### 5. Polish
- [x] Relaxed tan vibe throughout: warm background tints, rounded cards, soft shadows,
      coffee-ish accent colours; map style tinted to match where possible
- [x] Mobile-first verified at 375px; works fine on desktop
- [x] Loading / empty states (data fetch, no search results)
- [x] Attribution footer (OpenFreeMap/OpenMapTiles/OSM, Reddit thread source, GeoNames)
- [x] Run production build, smoke-test with Playwright screenshot

### 6. Ship
- [x] Commit and push to `claude/coffee-price-map-au-q67onw`
- [ ] (Optional, later) GitHub Pages deploy workflow

## Outcome

63 coffee prices mapped from 337 comments — median $6.00, range $3.00–$9.00,
across VIC 23 · NSW 21 · QLD 12 · SA 4 · WA 2 · NT 1.

Three of those came from subreddit flair — a location the commenter attached to
their own comment — after a review pass over the 72 prices that name no place.

Verified in real Chromium at 375×812 and 1280×800: tiles render, clusters break
apart from z4 to z16, typo search (“newtwon”) ranks Newtown NSW first and flies
there, recents persist across reload as a single 3-chip row, no horizontal
scroll, 0 console errors. Unit tests: 32 assertions on the cluster median maths,
28 on fuzzy search and recents.

### Opening-view framing

Every coffee is in frame on first load, at every screen size — Perth included.

This was a deliberate call. Australia is landscape-shaped and a phone is
portrait, so fitting all 38° of data longitude into 375px is decided entirely by
width, and the ~30° of latitude left over does not fill the height — roughly
half a portrait screen ends up as ocean. Cropping the west coast frames the
remaining data far more tightly, but a map of Australian coffee prices that
opens without Western Australia on it reads as broken rather than as
deliberate. Showing the whole continent wins; the empty ocean is the price.
