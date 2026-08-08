# AGENTS.md — Coffee Coster

Guidance for AI agents (and humans) working in this repo.

## What this is

A single-page, mobile-first static site that plots the price of a coffee around Australia
on a map. Prices were scraped from a Reddit thread
(r/AskAnAustralian, post id `1vii42k`) via the Arctic Shift archive API.
See `TASKS.md` for the build plan and current status.

## Stack

- **Build**: Vite, vanilla JavaScript (ES modules), vanilla CSS. No framework — keep it that way
  unless the app grows real state-management needs.
- **Map**: MapLibre GL JS + OpenFreeMap vector tiles (free, keyless, no usage limits).
  Do not swap in a provider that needs an API key or has meaningful usage caps.
- **Clustering**: supercluster; clusters carry the full price array so the median can be shown.
- **Search**: client-side fuzzy suburb autocomplete (Fuse.js) over a bundled gazetteer.
  No network geocoding calls at runtime.

## Layout

- `DATA_CONTRACT.md` — shape of the generated JSON the app consumes
- `docs/` — **build output**, committed for GitHub Pages. Never hand-edit; never put
  source or documentation here, `npm run build` empties it.
- `src/` — app code (`main.js`, modules, `style.css`)
- `public/data/coffees.json` — the cleaned dataset the app consumes
- `public/data/suburbs.json` — Australian localities gazetteer for search
- `scripts/` — data pipeline (fetch thread, build gazetteer, extract/clean/geocode)
- `data/raw/` — cached raw thread JSON (committed so the pipeline is reproducible offline)
- `data/overrides.json` — manual fixes for ambiguous locations; edit this rather than
  hand-editing `coffees.json`

## Conventions

- **Work on `main`.** It is the default branch and what GitHub Pages deploys from
  (`/docs`). Commit and push there directly; no feature branch unless asked.
- Mobile-first: write base styles for small screens, use `min-width` media queries to scale up.
- Design language: relaxed tan/latte palette. All colours come from CSS custom properties in
  `src/style.css` (`--tan-*`, `--espresso-*`); never hard-code new hex values in components.
- Prices are displayed in the light-tan price-card style; clusters show the **median**
  (prefixed `~`, because it is nobody's actual price) over the min-max spread, and are
  styled as the top card of a stack. Keep that visual metaphor if you touch markers.
- Nine other cluster faces live behind `?label=<id>` in `src/map.js` (`CLUSTER_LABELS`).
  They are a finished experiment kept for comparison — delete them freely once nobody
  is still choosing.
- Data is regenerated with `npm run data` (runs the whole pipeline). Never hand-edit generated
  files (`public/data/*.json`); fix the scripts or `data/overrides.json` and re-run.
- Reddit itself 403s from datacenter IPs — always go through Arctic Shift
  (`https://arctic-shift.photon-reddit.com/api/`) for thread data.

## Commands

```bash
npm install        # install deps
npm run dev        # dev server
npm run build      # production build to docs/ (committed; GitHub Pages serves it)
npm run preview    # serve the production build
npm run data       # re-run the full data pipeline (fetch → gazetteer → extract)
```

## Definition of done

- `npm run build` succeeds with no errors, and the refreshed `docs/` is committed
  alongside the `src/` change that caused it — the deployed site is whatever is in
  `docs/`, so leaving it stale silently ships the old build.
- The map renders points and clusters correctly on a ~375px viewport.
- `TASKS.md` checkboxes updated to reflect reality.
