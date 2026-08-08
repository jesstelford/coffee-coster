/* ============================================================
   Coffee Coster — map, clustering and marker rendering.

   Public API (this is all other modules should use):

     const { map, flyToLocation } = await initMap({ container, coffees });

   Everything else exported from this file exists so
   `scripts/test-cluster.mjs` can exercise the *exact* clustering
   configuration the app runs with. Treat those as internal.
   ============================================================ */

import {
  Map as MapLibreMap,
  Marker,
  Popup,
  NavigationControl,
} from 'maplibre-gl';
import Supercluster from 'supercluster';

import 'maplibre-gl/dist/maplibre-gl.css';
import './map.css';

/* ------------------------------------------------------------
   Constants
   ------------------------------------------------------------ */

/** OpenFreeMap — free, keyless vector tiles. */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** Roughly the whole continent + Tasmania; used for the opening view. */
const AU_BOUNDS = [
  [112.5, -44.0],
  [154.2, -9.8],
];

/** Fallback view if the container has no size yet (centre ~[134, -28]). */
const AU_CENTER = [134, -28];
const AU_ZOOM = 3.1;

/**
 * A loose leash so nobody ends up staring at the middle of the Atlantic.
 *
 * The latitude range is absurdly generous *on purpose*. MapLibre enforces
 * `maxBounds` by zooming the camera **in** until the viewport fits inside
 * it, and it does that silently, after `fitBounds` has run. Australia is
 * 42° wide and 34° tall, so on a tall phone the opening fit is decided by
 * width and leaves a lot of slack above and below — enough that the top of
 * a 375x812 viewport reached ~30°N. Against the old 18°N ceiling that
 * tripped the constraint, MapLibre zoomed back in, and the fit padding
 * meant to keep the east- and west-coast price cards on screen was
 * quietly thrown away with it.
 *
 * Longitude still does the real work here: 85°E-180°E cannot be escaped,
 * and at `MIN_ZOOM` that span is wider than any viewport, so it never
 * forces a zoom of its own.
 */
const AU_MAX_BOUNDS = [
  [85, -78],
  [180, 40],
];

const MIN_ZOOM = 2.2;
const MAX_ZOOM = 17;

/** The one breakpoint this module cares about; matches src/style.css. */
const WIDE_BREAKPOINT = 768;

/** Clustering feels right at ~60px radius; stop clustering past z16. */
const CLUSTER_RADIUS = 60;
const CLUSTER_MAX_ZOOM = 16;

/** Zoom used when the search module asks us to fly somewhere. */
const DEFAULT_FLY_ZOOM = 11;

/** Clusters at or above this many coffees get a deeper card stack. */
const DEEP_STACK_AT = 10;

/**
 * How long to wait for the style before showing the map chrome anyway.
 * Short on purpose: `main.js` no longer blocks the search box on this,
 * so the only cost of giving up early is a map that fills in a beat later.
 */
const STYLE_WAIT_MS = 2500;

/**
 * If the vector source still has not loaded after this long, something is
 * structurally wrong (a missing worker chunk, a blocked host) rather than
 * merely slow — say so loudly instead of showing a silently empty map.
 */
const TILE_CANARY_MS = 9000;

/** The vector source id every OpenMapTiles-derived style uses. */
const VECTOR_SOURCE_ID = 'openmaptiles';

/** Never frame tighter than this, however clustered the data is. */
const MIN_FIT_SPAN_DEG = 6;

/* ------------------------------------------------------------
   Pure helpers (unit-tested by scripts/test-cluster.mjs)
   ------------------------------------------------------------ */

/**
 * The box that holds every coffee — the starting point for the opening
 * view, which `openingBounds` then adapts to the viewport's shape.
 *
 * Deliberately the *coffees*, not the continent. Australia is 42° wide and
 * 34° tall; a phone is the other way round, so fitting the whole landmass
 * on a 375px screen spends the zoom budget on empty Southern Ocean and
 * leaves the price cards tiny. The data is a little narrower than the
 * continent (nothing west of Perth, nothing north of Darwin), and framing
 * that instead buys back roughly 10% of the scale while still showing the
 * entire mainland, because the viewport is wider than the padded fit box.
 *
 * Falls back to the continent when the data cannot supply a sane box.
 * @param {Array<object>} coffees
 * @returns {[[number, number], [number, number]]}
 */
export function fitBoundsFor(coffees) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let count = 0;

  for (const coffee of Array.isArray(coffees) ? coffees : []) {
    const lat = Number(coffee?.lat);
    const lon = Number(coffee?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 85 || Math.abs(lon) > 180) continue;
    count++;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }

  if (count < 2) return AU_BOUNDS;

  // Pad a degenerate (single-city) box out to something legible.
  const grow = (lo, hi) => {
    const short = MIN_FIT_SPAN_DEG - (hi - lo);
    if (short <= 0) return [lo, hi];
    return [lo - short / 2, hi + short / 2];
  };
  [west, east] = grow(west, east);
  [south, north] = grow(south, north);

  return [
    [west, clamp(south, -85, 85)],
    [east, clamp(north, -85, 85)],
  ];
}

/**
 * The box the *opening* camera should frame, given the viewport width.
 *
 * Every coffee is in frame on first load, on every screen size — including
 * Perth, 20° of longitude west of the next nearest data point.
 *
 * On a phone that costs us: fitting all 38° of data longitude into 375px is
 * decided entirely by width, and the ~30° of latitude left over does not fill
 * the height, so a good half of a portrait screen is ocean. Cropping the west
 * coast would frame the remaining data far more tightly, but a map of
 * Australian coffee prices that opens without Western Australia on it reads as
 * broken rather than as deliberate. Showing the whole continent wins.
 *
 * `width` is kept in the signature so the opening frame can diverge by
 * viewport again without churning every call site.
 *
 * @param {Array<object>} coffees
 * @param {number} width viewport width in CSS pixels
 * @returns {[[number, number], [number, number]]}
 */
export function openingBounds(coffees, width) {
  return fitBoundsFor(coffees);
}

/**
 * Median of a list of numbers. Even-length sets return the mean of the
 * two middle values. Non-finite values are ignored.
 * @param {number[]} values
 * @returns {number} NaN when there is nothing to average.
 */
export function median(values) {
  if (!Array.isArray(values)) return NaN;
  // filter() copies, so the caller's array is never re-ordered.
  const sorted = values
    .filter((n) => typeof n === 'number' && Number.isFinite(n))
    .sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * "$4.50", "$5" (cents dropped when they are .00).
 * @param {number} value
 */
export function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const rounded = Math.round(n * 100) / 100;
  return `$${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)}`;
}

/**
 * Turn the coffees.json records into GeoJSON points supercluster can eat.
 * Records missing a usable price/lat/lon are dropped rather than crashing
 * the map.
 * @param {Array<object>} coffees
 */
export function toGeoJSONPoints(coffees) {
  const features = [];
  for (const coffee of Array.isArray(coffees) ? coffees : []) {
    if (!coffee) continue;
    const lat = Number(coffee.lat);
    const lon = Number(coffee.lon);
    const price = Number(coffee.price);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!Number.isFinite(price)) continue;
    features.push({
      type: 'Feature',
      properties: { ...coffee, price },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    });
  }
  return features;
}

/**
 * Build the supercluster index.
 *
 * The map/reduce pair carries *every* price up into the cluster so a
 * cluster can render the median rather than an average.
 *
 * supercluster's contract: `reduce` mutates `accumulated` in place and
 * must never touch `props`. `accumulated` is only a *shallow* clone of a
 * child cluster's props, so `accumulated.prices` can share an array with
 * that child — hence the reassignment via concat instead of push().
 *
 * @param {Array<object>} coffees
 * @returns {Supercluster}
 */
export function createClusterIndex(coffees) {
  const index = new Supercluster({
    radius: CLUSTER_RADIUS,
    maxZoom: CLUSTER_MAX_ZOOM,
    minZoom: 0,
    minPoints: 2,
    map: (props) => ({ prices: [props.price] }),
    reduce: (accumulated, props) => {
      accumulated.prices = accumulated.prices.concat(props.prices);
    },
  });
  index.load(toGeoJSONPoints(coffees));
  return index;
}

/* ------------------------------------------------------------
   Small DOM / environment helpers
   ------------------------------------------------------------ */

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** "Palm Beach, QLD" — tolerant of missing pieces. */
function placeLabel(props) {
  return [props.location, props.state].filter(Boolean).join(', ');
}

/**
 * Fit-padding that leaves room for the page chrome without ever eating so
 * much of the viewport that the fit inverts.
 *
 * Vertically it clears the search bar and the attribution footer. The
 * left/right numbers used to be half a price card wide, so that an
 * edge-of-bounds marker kept its price and count badge on screen; markers
 * are now clamped inward at *every* zoom (see `clampMarkers`), which does
 * that job properly, so on a phone the gutters shrink back to a hairline
 * and the scale goes to the map instead.
 */
export function fitPadding(width, height) {
  const wide = width >= WIDE_BREAKPOINT;
  const raw = wide
    ? { top: 28, bottom: 64, left: Math.min(width * 0.34, 420), right: 48 }
    : { top: 84, bottom: 104, left: 24, right: 24 };
  const maxH = width * 0.45;
  const maxV = height * 0.42;
  const scaleH = raw.left + raw.right > maxH ? maxH / (raw.left + raw.right) : 1;
  const scaleV = raw.top + raw.bottom > maxV ? maxV / (raw.top + raw.bottom) : 1;
  return {
    top: Math.round(raw.top * scaleV),
    bottom: Math.round(raw.bottom * scaleV),
    left: Math.round(raw.left * scaleH),
    right: Math.round(raw.right * scaleH),
  };
}

/* ------------------------------------------------------------
   Latte basemap tint

   OpenFreeMap Liberty is a fine general-purpose style, but its
   cornflower water and highlighter-yellow motorways fight the tan
   chrome. Rather than ship a whole style document we recolour the
   layers we care about once the style has loaded, keyed off Liberty's
   very regular layer ids (`road_*`, `bridge_*`, `tunnel_*`, `label_*`).

   Only *colours* are touched — never widths, filters or z-order — so
   the map stays as legible as it was, just warmer.
   ------------------------------------------------------------ */

/** Basemap-only palette. Deliberately a shade off the UI tokens so the
 *  price cards still read as objects sitting *on* the map. */
const LATTE = {
  land: '#f7f0e4',
  water: '#aec8d3',
  waterLine: '#a2bfcb',
  green: '#dbe4c0',
  greenSoft: '#e3e9d3',
  sand: '#f0e4c9',
  landuse: '#efe5d3',
  building: '#e7dac4',
  buildingEdge: '#d9c7ab',
  // Not white: the price cards are the brightest thing on this map, and a
  // white street under one erases its edge.
  roadFill: '#fdf7ea',
  roadMajor: '#f7e9cf',
  motorway: '#f1daac',
  casing: '#d9c09c',
  path: '#e9dcc5',
  rail: '#c4b29a',
  boundary: '#b0916c',
  label: '#372718',
  labelMuted: '#6b5040',
  halo: '#f9f3e8',
};

/**
 * Layers that are switched off rather than recoloured.
 *
 * These all draw *sprite images*: the blue transit/POI pictograms, the
 * white-and-blue road-shield boxes and the one-way arrows. A sprite is a
 * bitmap, so no amount of paint-property recolouring touches it, and each
 * one sits several steps outside a tan palette. They also earn very little
 * on a map whose entire subject is 60 price cards — and the shields in
 * particular are the layers whose `ref_length` filter fills the console
 * with type warnings.
 *
 * Liberty's ids, verified against the live style document:
 *   poi_r1 / poi_r7 / poi_r20 / poi_transit
 *   highway-shield-non-us / highway-shield-us-interstate / road_shield_us
 *   road_one_way_arrow / road_one_way_arrow_opposite
 */
const HIDDEN_LAYER_ID =
  /^(poi_r\d+|poi_transit|road_one_way_arrow(_opposite)?)$|shield/;

/**
 * Decide how a single Liberty layer should be recoloured.
 * Returns a `{ paintProperty: value }` bag, or null to leave it alone.
 *
 * Exported for eyeballing/testing; `applyLatteTint` is the only caller.
 * @param {{id:string,type:string}} layer
 */
export function latteTintFor(layer) {
  const id = String(layer?.id || '');
  const type = String(layer?.type || '');

  if (type === 'background') return { 'background-color': LATTE.land };

  // The low-zoom shaded-relief raster: desaturate it so the continent
  // reads as warm paper rather than a green/khaki satellite image.
  if (type === 'raster') {
    return {
      'raster-saturation': -0.45,
      'raster-contrast': -0.08,
      // Kept a little stronger than Liberty's default at low zoom: the
      // opening view is almost all continent outline, and without some
      // relief under it Australia reads as a blank cut-out.
      'raster-opacity': [
        'interpolate',
        ['exponential', 1.5],
        ['zoom'],
        0,
        0.7,
        6,
        0.08,
      ],
    };
  }

  if (type === 'fill' || type === 'fill-extrusion') {
    const prop = type === 'fill' ? 'fill-color' : 'fill-extrusion-color';
    if (id === 'water') return { [prop]: LATTE.water };
    if (/^building/.test(id)) {
      if (type === 'fill') {
        return { 'fill-color': LATTE.building, 'fill-outline-color': LATTE.buildingEdge };
      }
      /*
       * Liberty swaps flat footprints for real extrusions at z14. On a
       * top-down price map that costs more than it gives: MapLibre shades
       * the walls by up to 40%, which drops grey-olive slabs all over a
       * warm tan city, and perspective slides each roof away from the
       * screen centre — so the buildings no longer line up with the price
       * cards pinned to the streets between them. Flatten them back to
       * footprints and the tint holds at every zoom.
       */
      return {
        'fill-extrusion-color': LATTE.building,
        'fill-extrusion-height': 0,
        'fill-extrusion-base': 0,
        'fill-extrusion-vertical-gradient': false,
        'fill-extrusion-opacity': 1,
      };
    }
    if (/sand/.test(id)) return { [prop]: LATTE.sand };
    if (/ice/.test(id)) return { [prop]: '#f4f1ea' };
    if (/wetland/.test(id)) return { [prop]: LATTE.greenSoft };
    if (/^park$|wood|grass|forest/.test(id)) return { [prop]: LATTE.green };
    if (/aeroway/.test(id)) return { [prop]: '#ece1d0' };
    // road_area_pattern paints with fill-pattern; recolouring does nothing.
    if (/pattern/.test(id)) return null;
    if (/landuse|landcover/.test(id)) return { [prop]: LATTE.landuse };
    return null;
  }

  if (type === 'line') {
    if (/waterway/.test(id)) return { 'line-color': LATTE.waterLine };
    if (/boundary/.test(id)) return { 'line-color': LATTE.boundary };
    if (/rail/.test(id)) return { 'line-color': LATTE.rail };
    if (/park_outline/.test(id)) return { 'line-color': '#cdd7b4' };
    if (/_casing$/.test(id)) return { 'line-color': LATTE.casing };
    if (/path_pedestrian/.test(id)) return { 'line-color': LATTE.path };
    if (/motorway/.test(id)) return { 'line-color': LATTE.motorway };
    if (/trunk|primary|secondary|tertiary/.test(id)) {
      return { 'line-color': LATTE.roadMajor };
    }
    if (/aeroway/.test(id)) return { 'line-color': '#e3d6c2' };
    if (/road|street|link|minor|service|track/.test(id)) {
      return { 'line-color': LATTE.roadFill };
    }
    return null;
  }

  if (type === 'symbol') {
    // Place names carry the map; everything else is supporting text.
    const primary = /^label_(city|city_capital|town|state|country)/.test(id);
    return {
      'text-color': primary ? LATTE.label : LATTE.labelMuted,
      'text-halo-color': LATTE.halo,
      'text-halo-width': 1.2,
      'text-halo-blur': 0.6,
    };
  }

  return null;
}

/**
 * Walk the loaded style and apply `latteTintFor` to every layer.
 *
 * Idempotent by construction: every write is a fixed value derived from
 * the layer's id, so running it twice is a no-op. Defensive throughout: a
 * style that renames a layer, or a paint property a layer does not
 * support, must never break the map.
 *
 * @param {import('maplibre-gl').Map} map
 * @returns {boolean} true when a style with layers was actually walked
 */
function applyLatteTint(map) {
  let layers;
  try {
    layers = map.getStyle()?.layers;
  } catch {
    return false;
  }
  if (!Array.isArray(layers) || layers.length === 0) return false;

  for (const layer of layers) {
    if (HIDDEN_LAYER_ID.test(layer.id)) {
      hideLayer(map, layer.id);
      continue;
    }

    hardenFilter(map, layer);

    const paint = latteTintFor(layer);
    if (!paint) continue;
    for (const [property, value] of Object.entries(paint)) {
      try {
        map.setPaintProperty(layer.id, property, value);
      } catch {
        /* layer gone, or property not supported here — skip it */
      }
    }
  }
  return true;
}

function hideLayer(map, id) {
  try {
    if (map.getLayoutProperty(id, 'visibility') === 'none') return;
    map.setLayoutProperty(id, 'visibility', 'none');
  } catch {
    /* the style no longer has this layer — nothing to hide */
  }
}

/**
 * Rewrite `["get", "ref_length"]` inside a *filter* to a guaranteed number.
 *
 * Liberty's three road-shield layers filter on `["<=", ref_length, 6]`, but
 * plenty of OSM ways carry no `ref` at all, so the property arrives as null
 * and MapLibre logs a type warning for every one of them — a steady drip of
 * console noise from the moment real tiles start rendering.
 *
 * The substitute value must be *larger* than any threshold in the style, so
 * a ref-less way still fails the filter exactly as it does today. Fall back
 * to 0 and those ways start passing, and then the layer asks the sprite for
 * an icon named "road_" that does not exist — trading one warning for
 * another. (The layer's own `icon-image` reads `ref_length` too; that is
 * left alone, since only features that pass the filter ever reach it.)
 * @param {unknown} node
 */
const REF_LENGTH_ABSENT = 99;

function hardenNullableNumbers(node) {
  if (!Array.isArray(node)) return node;
  if (node.length === 2 && node[0] === 'get' && node[1] === 'ref_length') {
    return ['to-number', ['coalesce', ['get', 'ref_length'], REF_LENGTH_ABSENT]];
  }
  return node.map(hardenNullableNumbers);
}

function hardenFilter(map, layer) {
  const filter = layer?.filter;
  if (!Array.isArray(filter)) return;
  if (!JSON.stringify(filter).includes('ref_length')) return;
  try {
    map.setFilter(layer.id, hardenNullableNumbers(filter));
  } catch {
    /* the style changed shape — leave the filter alone */
  }
}

/* ------------------------------------------------------------
   Marker elements
   ------------------------------------------------------------ */

function priceCard(price) {
  const card = el('span', 'cc-marker__card');
  card.appendChild(el('span', 'cc-marker__price', formatPrice(price)));
  return card;
}

/**
 * EXPERIMENT — how a cluster should summarise the prices inside it.
 *
 * A cluster currently shows the median. Showing the spread (min–max) says more
 * but needs more room, and room is exactly what a marker on a phone does not
 * have. Each variant below is a different answer to that trade-off; pick one
 * with `?label=<id>` and the rest can be deleted.
 *
 * Keep 'median' as the default so the deployed site is unaffected while this
 * is being decided.
 */
export const CLUSTER_LABELS = [
  'median',
  'range-both',
  'range-single',
  'range-spaced',
  'range-endash',
  'two-line',
  'two-line-labelled',
  'median-range',
  'stack-encoded',
  'range-rail',
];

/** The chosen face. The rest stay reachable with `?label=<id>`. */
const DEFAULT_CLUSTER_LABEL = 'median-range';

const CLUSTER_LABEL = (() => {
  try {
    const asked = new URLSearchParams(window.location.search).get('label');
    return CLUSTER_LABELS.includes(asked) ? asked : DEFAULT_CLUSTER_LABEL;
  } catch {
    return DEFAULT_CLUSTER_LABEL;
  }
})();

/** `$5.50` with the leading `$` stripped — for the right half of a range. */
function bareAmount(price) {
  return formatPrice(price).replace('$', '');
}

/**
 * Build the card face for a cluster under the active label variant.
 * @param {number} lo cheapest price in the cluster
 * @param {number} hi dearest price in the cluster
 * @param {number} mid median price
 */
function clusterCard(lo, hi, mid) {
  const card = el('span', 'cc-marker__card');
  const line = (cls, text) => el('span', cls, text);
  const single = (text) => card.appendChild(line('cc-marker__price', text));

  // A cluster whose coffees all cost the same has no range to show.
  const flat = lo === hi;

  switch (CLUSTER_LABEL) {
    case 'range-both':
      single(flat ? formatPrice(lo) : `${formatPrice(lo)}-${formatPrice(hi)}`);
      break;
    case 'range-single':
      single(flat ? formatPrice(lo) : `${formatPrice(lo)}-${bareAmount(hi)}`);
      break;
    case 'range-spaced':
      single(flat ? formatPrice(lo) : `${formatPrice(lo)} - ${formatPrice(hi)}`);
      break;
    case 'range-endash':
      single(flat ? formatPrice(lo) : `${formatPrice(lo)}–${bareAmount(hi)}`);
      break;

    case 'two-line':
      card.classList.add('cc-marker__card--stacked-text');
      card.appendChild(line('cc-marker__price', formatPrice(hi)));
      if (!flat) card.appendChild(line('cc-marker__price', formatPrice(lo)));
      break;

    case 'two-line-labelled': {
      card.classList.add('cc-marker__card--stacked-text', 'cc-marker__card--labelled');
      const row = (label, price) => {
        const r = el('span', 'cc-marker__row');
        r.appendChild(line('cc-marker__minmax', label));
        r.appendChild(line('cc-marker__price', formatPrice(price)));
        return r;
      };
      card.appendChild(row('max', hi));
      if (!flat) card.appendChild(row('min', lo));
      break;
    }

    // The default. Median stays the headline because it is the trustworthy
    // number; the spread underneath is context. The median is prefixed "~"
    // whenever a spread exists, so the big number is never read as the price
    // of any actual coffee — but not when every coffee in the cluster cost
    // the same, since then it is exact.
    case 'median-range':
      card.classList.add('cc-marker__card--stacked-text');
      card.appendChild(line('cc-marker__price', flat ? formatPrice(mid) : `~${formatPrice(mid)}`));
      if (!flat) {
        card.appendChild(line('cc-marker__sub', `${formatPrice(lo)}–${bareAmount(hi)}`));
      }
      break;

    // The stack is already the visual metaphor for "more underneath", so let
    // the card behind carry the cheapest price and the top card the dearest.
    case 'stack-encoded':
      card.classList.add('cc-marker__card--encoded');
      card.appendChild(line('cc-marker__price', formatPrice(hi)));
      if (!flat) card.style.setProperty('--cc-under', JSON.stringify(formatPrice(lo)));
      break;

    case 'range-rail':
      card.classList.add('cc-marker__card--rail');
      card.appendChild(line('cc-marker__price', formatPrice(lo)));
      if (!flat) {
        card.appendChild(el('span', 'cc-marker__rail'));
        card.appendChild(line('cc-marker__price', formatPrice(hi)));
      }
      break;

    case 'median':
    default:
      single(formatPrice(mid));
      break;
  }
  return card;
}

function createSingleElement(props) {
  const node = el('button', 'cc-marker cc-marker--single');
  node.type = 'button';
  const drink = props.drink ? String(props.drink) : 'coffee';
  const where = placeLabel(props);
  node.setAttribute(
    'aria-label',
    `${formatPrice(props.price)} ${drink}${where ? ` in ${where}` : ''}. Show details.`
  );
  node.appendChild(priceCard(props.price));
  return node;
}

function createClusterElement(props, medianPrice) {
  const count = Number(props.point_count) || 0;
  const prices = Array.isArray(props.prices) ? props.prices : [];
  const lo = prices.length ? Math.min(...prices) : medianPrice;
  const hi = prices.length ? Math.max(...prices) : medianPrice;
  const node = el('button', 'cc-marker cc-marker--cluster');
  node.type = 'button';
  node.classList.add(`cc-marker--label-${CLUSTER_LABEL}`);
  if (count >= DEEP_STACK_AT) node.classList.add('cc-marker--deep');
  node.setAttribute(
    'aria-label',
    `${count} coffees here, median ${formatPrice(medianPrice)}, ` +
      `from ${formatPrice(lo)} to ${formatPrice(hi)}. Zoom in.`
  );
  node.appendChild(clusterCard(lo, hi, medianPrice));

  const badge = el(
    'span',
    'cc-marker__count',
    props.point_count_abbreviated != null
      ? String(props.point_count_abbreviated)
      : String(count)
  );
  badge.setAttribute('aria-hidden', 'true');
  node.appendChild(badge);
  return node;
}

/* ------------------------------------------------------------
   Popup content
   ------------------------------------------------------------ */

function buildPopupContent(props) {
  const root = el('div', 'cc-popup__body');

  const where = placeLabel(props);
  if (where) {
    const heading = el('h2', 'cc-popup__place', where);
    root.appendChild(heading);
  }

  const priceRow = el('p', 'cc-popup__price-row');
  priceRow.appendChild(el('span', 'cc-popup__price', formatPrice(props.price)));
  if (props.drink) {
    priceRow.appendChild(el('span', 'cc-popup__drink', String(props.drink)));
  }
  root.appendChild(priceRow);

  if (props.excerpt) {
    root.appendChild(el('blockquote', 'cc-popup__excerpt', String(props.excerpt)));
  }

  const meta = el('p', 'cc-popup__meta');
  if (props.author) {
    meta.appendChild(el('span', 'cc-popup__author', `u/${props.author}`));
  }
  const permalink = typeof props.permalink === 'string' ? props.permalink : '';
  if (/^https?:\/\//i.test(permalink)) {
    const link = el('a', 'cc-popup__link', 'View on Reddit');
    link.href = permalink;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    meta.appendChild(link);
  }
  if (meta.childNodes.length) root.appendChild(meta);

  return root;
}

/* ------------------------------------------------------------
   initMap
   ------------------------------------------------------------ */

/**
 * Create the map, index the coffees and start rendering markers.
 *
 * @param {object} options
 * @param {HTMLElement|string} [options.container] element or element id
 * @param {Array<object>} [options.coffees] records from public/data/coffees.json
 * @returns {Promise<{ map: MapLibreMap, flyToLocation: (lat:number, lon:number, zoom?:number) => void }>}
 */
export async function initMap({ container = 'map', coffees = [] } = {}) {
  const node =
    typeof container === 'string'
      ? document.getElementById(container.replace(/^#/, ''))
      : container;

  if (!node) {
    throw new Error(`initMap: map container "${container}" was not found`);
  }

  const viewportPadding = () =>
    fitPadding(
      node.clientWidth || window.innerWidth || 375,
      node.clientHeight || window.innerHeight || 667
    );

  const width = node.clientWidth || window.innerWidth || 375;
  const height = node.clientHeight || window.innerHeight || 667;

  const map = new MapLibreMap({
    container: node,
    style: MAP_STYLE_URL,
    center: AU_CENTER,
    zoom: AU_ZOOM,
    bounds: openingBounds(coffees, width),
    fitBoundsOptions: { padding: fitPadding(width, height), duration: 0 },
    maxBounds: AU_MAX_BOUNDS,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    dragRotate: false,
    pitchWithRotate: false,
    renderWorldCopies: false,
    // The page renders its own tan attribution footer (#attribution).
    attributionControl: false,
  });

  map.touchZoomRotate?.disableRotation();
  map.touchPitch?.disable();

  // Navigation buttons are a waste of thumb-space on a phone.
  const wideQuery = window.matchMedia('(min-width: 768px)');
  let navControl = null;
  const syncNavControl = () => {
    if (wideQuery.matches && !navControl) {
      navControl = new NavigationControl({ showCompass: false });
      // top-right: at >= 768px the search panel moves to the left gutter
      // and the attribution footer owns the bottom-right corner.
      map.addControl(navControl, 'top-right');
    } else if (!wideQuery.matches && navControl) {
      map.removeControl(navControl);
      navControl = null;
    }
  };
  syncNavControl();
  wideQuery.addEventListener('change', syncNavControl);

  const index = createClusterIndex(coffees);

  /** key -> maplibregl.Marker, so panning reuses rather than rebuilds. */
  const markers = new Map();

  /*
   * closeOnMove is deliberately off, and replaced below by a listener that
   * only fires on *user-initiated* movement. A popup left anchored after
   * the user pans ends up floating over markers it never belonged to and
   * swallowing their taps — but MapLibre's own closeOnMove cannot tell a
   * drag from the small programmatic nudge that keeps the popup on screen,
   * and would slam it shut the instant it opened near an edge.
   */
  const popup = new Popup({
    className: 'cc-popup',
    closeButton: true,
    closeOnClick: true,
    closeOnMove: false,
    maxWidth: '278px',
    offset: 20,
    focusAfterOpen: true,
  });

  map.on('movestart', (event) => {
    // originalEvent is only set when a gesture drove the camera.
    if (event?.originalEvent) popup.remove();
  });

  function visibleBbox() {
    const bounds = map.getBounds();
    let west = bounds.getWest();
    let east = bounds.getEast();
    if (east - west >= 360) {
      west = -180;
      east = 180;
    }
    return [
      west,
      clamp(bounds.getSouth(), -85, 85),
      east,
      clamp(bounds.getNorth(), -85, 85),
    ];
  }

  function featureKey(feature) {
    if (feature.properties && feature.properties.cluster) {
      // cluster_id encodes the zoom the cluster formed at, so a given id
      // always means the same set of points — safe to reuse across zooms.
      return `c:${feature.properties.cluster_id}`;
    }
    const id = feature.properties?.id ?? feature.id;
    return `p:${id}`;
  }

  /**
   * Slide the camera just far enough that the whole popup is on screen.
   *
   * A 278px popup beside a marker near a 375px-wide viewport's edge will
   * always hang off it — no anchor MapLibre can pick and no max-width that
   * still fits an excerpt will save it. Measuring the popup's real box and
   * panning by the overflow handles every anchor without any trigonometry,
   * and pans by nothing at all in the common case.
   */
  function keepPopupOnScreen() {
    const element = popup.getElement?.();
    if (!element) return;

    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const view = node.getBoundingClientRect();
    const pad = viewportPadding();
    const gutter = 10;

    const left = view.left + gutter;
    const right = view.right - gutter;
    // Clear the search bar at the top and the attribution at the bottom.
    const top = view.top + pad.top;
    const bottom = view.bottom - gutter;

    let dx = 0;
    let dy = 0;
    if (box.width <= right - left) {
      if (box.left < left) dx = box.left - left;
      else if (box.right > right) dx = box.right - right;
    }
    if (box.height <= bottom - top) {
      if (box.top < top) dy = box.top - top;
      else if (box.bottom > bottom) dy = box.bottom - bottom;
    }
    if (!dx && !dy) return;

    // panBy moves the *centre* by the offset, so the content moves the
    // opposite way — which is exactly the sign the overflow already has.
    map.panBy([dx, dy], {
      duration: prefersReducedMotion() ? 0 : 220,
      essential: true,
    });
  }

  function openPointPopup(feature) {
    popup
      .setLngLat(feature.geometry.coordinates)
      .setDOMContent(buildPopupContent(feature.properties))
      .addTo(map);
    keepPopupOnScreen();
  }

  function zoomIntoCluster(clusterId, coordinates) {
    popup.remove();
    let target;
    try {
      target = index.getClusterExpansionZoom(clusterId);
    } catch {
      target = map.getZoom() + 2;
    }
    const zoom = clamp(target, map.getZoom() + 0.5, MAX_ZOOM);
    // Padding keeps the expanded cluster in the clear band between the
    // search bar and the attribution footer, not under either of them.
    const camera = { center: coordinates, zoom, padding: viewportPadding() };
    if (prefersReducedMotion()) map.jumpTo(camera);
    else map.easeTo({ ...camera, duration: 520, essential: true });
  }

  function createMarker(feature) {
    const props = feature.properties || {};
    const coordinates = feature.geometry.coordinates;
    let element;

    if (props.cluster) {
      const medianPrice = median(props.prices);
      element = createClusterElement(props, medianPrice);
      element.addEventListener('click', (event) => {
        // Keep the click off the canvas so MapLibre does not treat it as a
        // map click (which would also slam the popup shut again).
        event.stopPropagation();
        zoomIntoCluster(props.cluster_id, coordinates);
      });
    } else {
      element = createSingleElement(props);
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        openPointPopup(feature);
      });
    }

    return new Marker({ element, anchor: 'center' }).setLngLat(coordinates);
  }

  /* ----------------------------------------------------------
     Keeping price cards on screen

     A marker is centred on its point, so a coffee near the edge of the
     viewport hangs half its card off it — and one near the bottom
     disappears under the attribution footer. The opening view used to
     dodge this with fat fit-padding, but padding only shapes the *first*
     camera: pan or zoom anywhere else and the cards clip again.

     So instead of moving the camera, nudge the card. Each frame, any
     marker whose point is on screen has its element pushed back inside
     the clear band by exactly its own overflow — never further — using
     the `translate` property, which composes with the `transform`
     MapLibre owns instead of fighting it. The shift is at most half a
     card (~40px) horizontally, and a card that needs no nudge gets
     none, so the common case is untouched.
     ---------------------------------------------------------- */

  /** Breathing room between a card and the edge it is clamped against. */
  const EDGE_GUTTER = 8;

  /** The count badge overhangs the button box; keep it on screen too. */
  const BADGE_RIGHT = 8;
  const BADGE_TOP = 5;

  /** offsetWidth/Height are constant per card — measure each element once. */
  const markerSizes = new WeakMap();

  function markerSize(element) {
    let size = markerSizes.get(element);
    if (!size) {
      size = { width: element.offsetWidth, height: element.offsetHeight };
      if (size.width && size.height) markerSizes.set(element, size);
    }
    return size;
  }

  /*
   * How far the page chrome reaches into the map. Measured from the DOM
   * rather than assumed, because both boxes change height at runtime: the
   * topbar grows a row when recent-search chips appear, and the footer
   * rewraps its credits with the viewport.
   */
  const topbar = document.querySelector('.topbar');
  const footer = document.getElementById('attribution');
  let chromeInset = { top: 0, right: 0, bottom: 0 };

  function measureChrome() {
    const view = node.getBoundingClientRect();
    const bar = topbar?.getBoundingClientRect();
    const foot = footer?.getBoundingClientRect();
    chromeInset = {
      // >= 768px the topbar is a left-hand panel, not a full-width bar, so
      // remember how far across it reaches as well as how far down.
      top: bar?.height ? Math.max(0, bar.bottom - view.top) : 0,
      right: bar?.height ? Math.max(0, bar.right - view.left) : 0,
      bottom: foot?.height ? Math.max(0, view.bottom - foot.top) : 0,
    };
  }

  function clampMarkers() {
    const width = node.clientWidth;
    const height = node.clientHeight;
    if (!width || !height) return;

    const floor = height - chromeInset.bottom;

    for (const marker of markers.values()) {
      const element = marker.getElement();
      const { width: cardWidth, height: cardHeight } = markerSize(element);
      let dx = 0;
      let dy = 0;

      if (cardWidth && cardHeight) {
        const point = map.project(marker.getLngLat());
        // Off-screen markers are left exactly where they are: dragging one
        // back would pin a whole edge of the map with cards for places
        // nobody is looking at.
        const onScreen =
          point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;

        if (onScreen) {
          const left = point.x - cardWidth / 2;
          const right = point.x + cardWidth / 2 + BADGE_RIGHT;
          if (right - left + 2 * EDGE_GUTTER <= width) {
            if (left < EDGE_GUTTER) dx = EDGE_GUTTER - left;
            else if (right > width - EDGE_GUTTER) dx = width - EDGE_GUTTER - right;
          }

          // Only the part of the topbar that is actually overhead counts.
          const ceiling = point.x + dx < chromeInset.right ? chromeInset.top : 0;
          const top = point.y - cardHeight / 2 - BADGE_TOP;
          const bottom = point.y + cardHeight / 2;
          if (bottom - top + 2 * EDGE_GUTTER <= floor - ceiling) {
            if (top < ceiling + EDGE_GUTTER) dy = ceiling + EDGE_GUTTER - top;
            else if (bottom > floor - EDGE_GUTTER) dy = floor - EDGE_GUTTER - bottom;
          }
        }
      }

      // Writing the same value back would still dirty style on every frame.
      const wanted = dx || dy ? `${Math.round(dx)}px ${Math.round(dy)}px` : '';
      if (element.style.translate !== wanted) element.style.translate = wanted;
    }
  }

  /** `move` fires once per animation frame during a drag or a flyTo. */
  let clampFrame = 0;
  function scheduleClamp() {
    if (clampFrame) return;
    clampFrame = requestAnimationFrame(() => {
      clampFrame = 0;
      clampMarkers();
    });
  }

  function render() {
    const zoom = Math.round(map.getZoom());
    let features;
    try {
      features = index.getClusters(visibleBbox(), zoom);
    } catch (error) {
      console.warn('Coffee Coster: clustering failed', error);
      return;
    }

    const seen = new Set();
    for (const feature of features) {
      const key = featureKey(feature);
      if (seen.has(key)) continue;
      seen.add(key);

      const existing = markers.get(key);
      if (existing) {
        existing.setLngLat(feature.geometry.coordinates);
        continue;
      }
      const marker = createMarker(feature);
      marker.addTo(map);
      markers.set(key, marker);
    }

    for (const [key, marker] of markers) {
      if (seen.has(key)) continue;
      marker.remove();
      markers.delete(key);
    }

    clampMarkers();
  }

  /*
   * Recolour as soon as the style document is in — this happens well
   * before the first tiles finish, so the map paints warm from its very
   * first frame.
   *
   * The one thing this must not do is gate on `map.isStyleLoaded()`. That
   * predicate is about the *whole* pipeline — sources, sprite, glyphs —
   * and is false at every `styledata` event, including the last one. Waiting
   * for it turned the tint into a coin flip: it landed only when `load`
   * happened to beat the fallback timer below, and about a third of loads
   * came up stock-Liberty blue, permanently, with no way back.
   *
   * The right precondition is far weaker and always reachable: are there
   * layers to recolour yet? So we try on every `styledata`, and stop only
   * once a walk has actually happened for the current set of layers.
   *
   * `setPaintProperty`/`setLayoutProperty` themselves fire `styledata`, so
   * `applying` keeps the handler out of its own re-entry, and the layer
   * signature stops the handler from walking the style again on every
   * event it causes.
   */
  let tintedSignature = '';
  let applying = false;
  const tintNow = () => {
    if (applying) return;
    let signature;
    try {
      // getLayersOrder is the cheap way to ask "is there a style yet?" —
      // but never the *only* way, or a MapLibre that drops it would leave
      // the map stock-blue with nothing in the console to say why.
      const order =
        typeof map.getLayersOrder === 'function'
          ? map.getLayersOrder()
          : map.getStyle()?.layers?.map((layer) => layer.id);
      if (!Array.isArray(order) || order.length === 0) return;
      signature = `${order.length}:${order[0]}:${order[order.length - 1]}`;
    } catch {
      return; // no style yet — a later styledata will bring one
    }
    if (signature === tintedSignature) return;

    applying = true;
    try {
      if (applyLatteTint(map)) tintedSignature = signature;
    } finally {
      applying = false;
    }
  };
  map.on('styledata', tintNow);
  tintNow();

  map.on('error', (event) => {
    console.warn('Coffee Coster: map error', event?.error || event);
  });

  // Did a single vector tile ever finish? `isSourceLoaded()` is no good
  // for this — it reads false whenever the camera is mid-flight — but a
  // `sourcedata` event carrying a tile only ever fires after the worker
  // has parsed one, which is exactly the thing that used to be broken.
  let sawVectorTile = false;
  map.on('sourcedata', (event) => {
    if (event?.sourceId === VECTOR_SOURCE_ID && event?.tile) sawVectorTile = true;
  });

  await new Promise((resolve) => {
    if (map.loaded()) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    // Don't hold the markers hostage if OpenFreeMap is having a bad day.
    const timer = setTimeout(done, STYLE_WAIT_MS);
    map.once('load', done);
  });

  // Belt and braces: if the style arrived during the await above without a
  // `styledata` we heard, this catches it. Otherwise it is a no-op.
  tintNow();

  /*
   * Canary for the failure mode that has no console error of its own: if
   * MapLibre's worker chunk is missing from the build the tile pipeline
   * dies silently and every zoom above ~6 renders blank. Nothing throws,
   * nothing 500s — the only symptom is that the vector source never loads.
   */
  setTimeout(() => {
    if (sawVectorTile) return;
    // No source by that name means a different style, not a broken one.
    try {
      if (!map.getSource(VECTOR_SOURCE_ID)) return;
    } catch {
      return;
    }
    console.error(
      `Coffee Coster: not one vector tile parsed in ${TILE_CANARY_MS}ms — the ` +
        'basemap will be blank above low zooms. This is usually maplibre-gl’s ' +
        'worker chunk missing from the build (see setWorkerUrl in src/main.js).'
    );
  }, TILE_CANARY_MS);

  measureChrome();
  render();
  map.on('moveend', render);
  map.on('zoomend', render);
  map.on('move', scheduleClamp);
  map.on('resize', () => {
    measureChrome();
    scheduleClamp();
  });

  // The chrome resizes without the map doing anything: chips appear under
  // the search bar, the footer rewraps, the address bar slides away.
  if (typeof ResizeObserver === 'function') {
    const watchChrome = new ResizeObserver(() => {
      measureChrome();
      scheduleClamp();
    });
    if (topbar) watchChrome.observe(topbar);
    if (footer) watchChrome.observe(footer);
  }

  /**
   * Fly the map to a location. Used by the search module.
   * @param {number} lat
   * @param {number} lon
   * @param {number} [zoom]
   */
  function flyToLocation(lat, lon, zoom = DEFAULT_FLY_ZOOM) {
    const latitude = Number(lat);
    const longitude = Number(lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    const requested = Number(zoom);
    const center = [longitude, latitude];
    const targetZoom = clamp(
      Number.isFinite(requested) ? requested : DEFAULT_FLY_ZOOM,
      MIN_ZOOM,
      MAX_ZOOM
    );

    popup.remove();

    const padding = viewportPadding();

    if (prefersReducedMotion()) {
      map.jumpTo({ center, zoom: targetZoom, padding });
      render();
      return;
    }
    map.flyTo({
      center,
      zoom: targetZoom,
      padding,
      speed: 1.2,
      curve: 1.42,
      essential: true,
    });
  }

  return { map, flyToLocation };
}
