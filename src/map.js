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
 * A loose leash so nobody ends up staring at the middle of the Pacific.
 * Deliberately generous: MapLibre zooms *in* to keep the viewport inside
 * `maxBounds`, so a tight box would stop tall phones ever seeing all of
 * Australia at once.
 */
const AU_MAX_BOUNDS = [
  [85, -62],
  [180, 18],
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

/* ------------------------------------------------------------
   Pure helpers (unit-tested by scripts/test-cluster.mjs)
   ------------------------------------------------------------ */

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
 * Fit-padding that leaves room for the search overlay without ever eating
 * so much of the viewport that the fit inverts.
 */
function fitPadding(width, height) {
  const wide = width >= 768;
  const raw = wide
    ? { top: 24, bottom: 40, left: Math.min(width * 0.34, 420), right: 32 }
    : { top: 84, bottom: 52, left: 18, right: 18 };
  const maxH = width * 0.45;
  const maxV = height * 0.35;
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

  const width = node.clientWidth || window.innerWidth || 375;
  const height = node.clientHeight || window.innerHeight || 667;

  const map = new MapLibreMap({
    container: node,
    style: MAP_STYLE_URL,
    center: AU_CENTER,
    zoom: AU_ZOOM,
    bounds: AU_BOUNDS,
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

  const popup = new Popup({
    className: 'cc-popup',
    closeButton: true,
    closeOnClick: true,
    closeOnMove: false,
    maxWidth: '278px',
    offset: 20,
    focusAfterOpen: true,
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

  function openPointPopup(feature) {
    popup
      .setLngLat(feature.geometry.coordinates)
      .setDOMContent(buildPopupContent(feature.properties))
      .addTo(map);
  }

  function zoomIntoCluster(clusterId, coordinates) {
    let target;
    try {
      target = index.getClusterExpansionZoom(clusterId);
    } catch {
      target = map.getZoom() + 2;
    }
    const zoom = clamp(target, map.getZoom() + 0.5, MAX_ZOOM);
    const camera = { center: coordinates, zoom };
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
    // Don't hold the app hostage if OpenFreeMap is having a bad day.
    const timer = setTimeout(done, 8000);
    map.once('load', done);
    map.once('error', (event) => {
      console.warn('Coffee Coster: map error', event?.error || event);
    });
  });

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

    if (prefersReducedMotion()) {
      map.jumpTo({ center, zoom: targetZoom });
      render();
      return;
    }
    map.flyTo({ center, zoom: targetZoom, speed: 1.2, curve: 1.42, essential: true });
  }

  return { map, flyToLocation };
}
