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
 * The box the opening view should frame.
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
 * The left/right numbers are deliberately about half a price card wide
 * (cards are ~76px and centre-anchored on their point), so a marker sitting
 * on the eastern or western edge of the fitted bounds still has both its
 * price and its count badge on screen. The bottom number clears the
 * attribution footer.
 */
export function fitPadding(width, height) {
  const wide = width >= 768;
  const raw = wide
    ? { top: 28, bottom: 64, left: Math.min(width * 0.34, 420), right: 48 }
    : { top: 92, bottom: 104, left: 48, right: 48 };
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
  roadFill: '#fffdf8',
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
      return type === 'fill'
        ? { 'fill-color': LATTE.building, 'fill-outline-color': LATTE.buildingEdge }
        : { 'fill-extrusion-color': LATTE.building };
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
 * Defensive throughout: a style that renames a layer, or a paint
 * property a layer does not support, must never break the map.
 * @param {import('maplibre-gl').Map} map
 */
function applyLatteTint(map) {
  let layers;
  try {
    layers = map.getStyle()?.layers;
  } catch {
    return;
  }
  if (!Array.isArray(layers)) return;

  for (const layer of layers) {
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
  const node = el('button', 'cc-marker cc-marker--cluster');
  node.type = 'button';
  if (count >= DEEP_STACK_AT) node.classList.add('cc-marker--deep');
  node.setAttribute(
    'aria-label',
    `${count} coffees here, median ${formatPrice(medianPrice)}. Zoom in.`
  );
  node.appendChild(priceCard(medianPrice));

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
    bounds: fitBoundsFor(coffees),
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
  }

  // Recolour as soon as the style document is in — this fires well before
  // the first tiles finish, so the map paints warm from its very first frame.
  let tinted = false;
  const tintOnce = () => {
    // `styledata` can fire while the document is still being assembled,
    // so re-check rather than trusting the event.
    if (tinted || !map.isStyleLoaded()) return;
    tinted = true;
    map.off('styledata', tintOnce);
    applyLatteTint(map);
  };
  map.on('styledata', tintOnce);
  tintOnce();

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

  tintOnce();

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

  render();
  map.on('moveend', render);
  map.on('zoomend', render);

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
