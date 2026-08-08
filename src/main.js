/* ============================================================
   Coffee Coster — application entry point.

   Responsibilities (and only these — the map and the search box
   are self-contained modules):

     1. load public/data/coffees.json
     2. boot the map with it, and the search box on top of it
     3. own the page chrome: loading/error state, the one-line
        summary, and the attribution footer

   `./style.css` is imported here because it holds the design
   tokens + page layout. `map.js` already imports maplibre-gl's
   stylesheet and `./map.css`; `search.js` pulls in `./search.css`
   itself — so neither is repeated here.
   ============================================================ */

import './style.css';

import { setWorkerUrl } from 'maplibre-gl';
// Vite compiles maplibre's worker (and the ~480 KB shared chunk it pulls in)
// into a real emitted asset and hands back its hashed URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

import { initMap, formatPrice, median } from './map.js';
import { initSearch } from './search.js';

/*
 * MapLibre's own default worker URL is `new URL('./maplibre-gl-worker.mjs',
 * import.meta.url)` built from a *computed* filename, which Rollup cannot
 * see and therefore never emits. The result is a worker pool that dies on
 * startup without logging anything: the style loads, no vector tile is ever
 * requested, and the map is silently blank above zoom ~6.
 *
 * Pointing MapLibre at the chunk Vite really emitted fixes it. This must run
 * before the first Map is constructed — module bodies execute after all
 * imports resolve and before `start()` below, so it does.
 *
 * `map.js` deliberately does not do this itself: scripts/test-cluster.mjs
 * imports that module in plain node and only knows how to strip a bare
 * `maplibre-gl` import.
 */
setWorkerUrl(maplibreWorkerUrl);

/** Same relative form the search module uses for its gazetteer. */
const COFFEES_URL = 'data/coffees.json';

/** Suburb level: close enough to read street names, wide enough to
 *  still show the neighbouring cafes. */
const SEARCH_ZOOM = 12.5;

/** Fallback if the dataset ever loses its `source` block. */
const THREAD_URL =
  'https://www.reddit.com/r/AskAnAustralian/comments/1vii42k/how_much_was_your_coffee_this_morning/';

const CREDITS = {
  openfreemap: 'https://openfreemap.org/',
  openmaptiles: 'https://openmaptiles.org/',
  osm: 'https://www.openstreetmap.org/copyright',
  geonames: 'https://www.geonames.org/',
};

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

/** "$6.00" — always two decimals, unlike the marker/popup formatter. */
function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '';
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/** An external link that can never reach back through window.opener. */
function externalLink(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function textNode(text) {
  return document.createTextNode(text);
}

/* ------------------------------------------------------------------ */
/* data                                                                */
/* ------------------------------------------------------------------ */

/**
 * Fetch the dataset. Tolerates either the full document
 * (`{ source, coffees: [...] }`) or a bare array.
 * @returns {Promise<{ coffees: Array<object>, source: object|null }>}
 */
async function loadCoffees() {
  const res = await fetch(COFFEES_URL, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`${COFFEES_URL} responded ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const coffees = Array.isArray(json) ? json : json?.coffees;
  if (!Array.isArray(coffees) || coffees.length === 0) {
    throw new Error(`${COFFEES_URL} contained no coffees`);
  }

  return {
    coffees,
    source: !Array.isArray(json) && json?.source ? json.source : null,
  };
}

/* ------------------------------------------------------------------ */
/* loading / error state                                               */
/* ------------------------------------------------------------------ */

function createStatus() {
  const node = document.getElementById('loading');
  if (node) node.setAttribute('role', 'status');

  return {
    hide() {
      if (node) node.hidden = true;
    },
    fail(message) {
      if (!node) return;
      node.hidden = false;
      node.classList.add('is-error');
      node.textContent = message;
    },
  };
}

/* ------------------------------------------------------------------ */
/* summary + attribution                                               */
/* ------------------------------------------------------------------ */

/**
 * "60 coffees mapped · median $6.00" (+ " · highest mapped price $9.00",
 * which the stylesheet only reveals once there is room for it).
 *
 * Computed from the data every load, and deliberately worded as
 * *mapped*: comments without a location never made it into the file,
 * and some of those quoted dearer coffees than anything on the map.
 *
 * @returns {{ base: string, extra: string }}
 */
function summaryText(coffees) {
  const prices = coffees
    .map((c) => Number(c?.price))
    .filter((n) => Number.isFinite(n));
  if (!prices.length) return { base: '', extra: '' };

  const parts = [`${prices.length} coffees mapped`];

  const mid = median(prices);
  if (Number.isFinite(mid)) parts.push(`median ${formatMoney(mid)}`);

  const highest = Math.max(...prices);
  const extra = Number.isFinite(highest)
    ? ` · highest mapped price ${formatMoney(highest)}`
    : '';

  return { base: parts.join(' · '), extra };
}

/**
 * Fill the tan footer: the runtime summary on its own line, then the
 * credits. The footer is `pointer-events: none` apart from its links,
 * so it never steals a tap from a marker sitting near the bottom edge.
 */
function renderFooter({ coffees, source }) {
  const footer = document.getElementById('attribution');
  if (!footer) return;

  footer.replaceChildren();

  const { base, extra } = summaryText(coffees);
  if (base) {
    const line = document.createElement('p');
    line.className = 'attribution__summary';

    const pill = document.createElement('span');
    pill.className = 'attribution__pill';
    pill.appendChild(textNode(base));
    if (extra) {
      const wide = document.createElement('span');
      wide.className = 'attribution__pill-extra';
      wide.textContent = extra;
      pill.appendChild(wide);
    }

    line.appendChild(pill);
    footer.appendChild(line);
  }

  const credits = document.createElement('p');
  credits.className = 'attribution__credits';

  credits.append(
    textNode('Map '),
    externalLink(CREDITS.openfreemap, 'OpenFreeMap'),
    textNode(' · '),
    externalLink(CREDITS.openmaptiles, 'OpenMapTiles'),
    textNode(' · © '),
    externalLink(CREDITS.osm, 'OpenStreetMap'),
    textNode(' contributors · Prices from '),
    externalLink(isHttpUrl(source?.url) ? source.url : THREAD_URL, 'this Reddit thread'),
    textNode(' · Suburbs from '),
    externalLink(CREDITS.geonames, 'GeoNames')
  );

  footer.appendChild(credits);
}

/* ------------------------------------------------------------------ */
/* approximate locations                                               */
/* ------------------------------------------------------------------ */

const APPROX_NOTE =
  'Approximate location — the comment named a region, not an exact spot.';

/**
 * 12 of the 60 rows carry `approximate: true` because the commenter said
 * "Inner West, Sydney" rather than a suburb. `map.js` plots them like any
 * other point and its popup builder knows nothing about the flag, so the
 * note is grafted on here instead of forking the popup markup.
 *
 * Popups are appended into the map container, so a MutationObserver on
 * that container catches every one — including re-opens, which build a
 * fresh `.cc-popup__body`.
 */
function annotateApproximateLocations(coffees) {
  const byExcerpt = new Map();
  const byPlaceAndPrice = new Map();

  for (const coffee of coffees) {
    if (!coffee || coffee.approximate !== true) continue;
    if (typeof coffee.excerpt === 'string' && coffee.excerpt) {
      byExcerpt.set(coffee.excerpt, coffee);
    }
    // map.js renders the heading as "location, state" and the price via
    // formatPrice — mirror both so the fallback key matches the DOM.
    const place = [coffee.location, coffee.state].filter(Boolean).join(', ');
    byPlaceAndPrice.set(`${place}|${formatPrice(coffee.price)}`, coffee);
  }

  if (!byExcerpt.size && !byPlaceAndPrice.size) return;

  const container = document.getElementById('map');
  if (!container || typeof MutationObserver !== 'function') return;

  const decorate = () => {
    const bodies = container.querySelectorAll(
      '.cc-popup__body:not([data-cc-approx])'
    );
    for (const body of bodies) {
      body.dataset.ccApprox = 'checked';

      const excerpt = body.querySelector('.cc-popup__excerpt')?.textContent ?? '';
      const place = body.querySelector('.cc-popup__place')?.textContent ?? '';
      const price = body.querySelector('.cc-popup__price')?.textContent ?? '';

      const match =
        byExcerpt.get(excerpt) || byPlaceAndPrice.get(`${place}|${price}`);
      if (!match) continue;

      const note = document.createElement('p');
      note.className = 'cc-popup__approx';
      note.textContent = APPROX_NOTE;

      const heading = body.querySelector('.cc-popup__place');
      if (heading) heading.insertAdjacentElement('afterend', note);
      else body.insertAdjacentElement('afterbegin', note);
    }
  };

  new MutationObserver(decorate).observe(container, {
    childList: true,
    subtree: true,
  });
  decorate();
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function start() {
  const status = createStatus();

  let data = null;
  let loadError = null;
  try {
    data = await loadCoffees();
  } catch (error) {
    loadError = error;
    // The real error, not a sanitised one — this is the only place it lands.
    console.error('Coffee Coster: could not load the coffee prices.', error);
  }

  const coffees = data?.coffees ?? [];

  /*
   * Everything that does not need the map goes up *now*. Waiting on
   * initMap() used to leave the search box on screen but inert and the
   * footer empty for the whole of the map's load window — a box you can
   * focus and type into that quietly does nothing is worse than no box.
   */
  annotateApproximateLocations(coffees);
  renderFooter({ coffees, source: data?.source ?? null });

  // A selection made before the map is ready is remembered, not dropped:
  // only the most recent one matters, since each supersedes the last.
  let flyToLocation = null;
  let pendingFly = null;

  initSearch({
    onSelect: (suburb) => {
      if (!suburb) return;
      if (flyToLocation) flyToLocation(suburb.lat, suburb.lon, SEARCH_ZOOM);
      else pendingFly = suburb;
    },
  });

  try {
    // Resolves once the style has loaded and the first markers are drawn.
    ({ flyToLocation } = await initMap({ container: 'map', coffees }));
  } catch (error) {
    console.error('Coffee Coster: the map failed to start.', error);
    status.fail('The map could not be loaded. Please refresh to try again.');
    return;
  }

  if (loadError) {
    status.fail('Could not load the coffee prices. Please refresh to try again.');
  } else {
    // Data is in and the map has had its first render — both done.
    status.hide();
  }

  if (pendingFly) {
    const suburb = pendingFly;
    pendingFly = null;
    flyToLocation(suburb.lat, suburb.lon, SEARCH_ZOOM);
  }
}

start();
