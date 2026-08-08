#!/usr/bin/env node
/**
 * scripts/test-cluster.mjs
 *
 * Verifies the cluster-median logic in src/map.js for real, using the
 * *exact* supercluster configuration the app runs with — no second copy
 * of the config to drift out of sync.
 *
 * src/map.js imports maplibre-gl and two stylesheets, neither of which
 * node can load. So we read the module source, strip the browser-only
 * imports, rewrite the bare `supercluster` specifier to an absolute file
 * URL, and import the result as a data: URL module. Everything the
 * assertions touch (createClusterIndex, median, formatPrice) is pure and
 * has no DOM dependency.
 *
 * Run: node scripts/test-cluster.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAP_MODULE = path.join(HERE, '..', 'src', 'map.js');

/* ------------------------------------------------------------
   Load src/map.js in a node-friendly form
   ------------------------------------------------------------ */

async function loadMapModule() {
  const source = await readFile(MAP_MODULE, 'utf8');
  const superclusterUrl = import.meta.resolve('supercluster');

  const stripped = source
    // browser-only: the map/marker/popup classes
    .replace(/^import\s+\{[\s\S]*?\}\s+from\s+['"]maplibre-gl['"];?\s*$/m, '')
    // browser-only: stylesheets
    .replace(/^import\s+['"][^'"]+\.css['"];?\s*$/gm, '')
    // bare specifier -> absolute file URL (data: URLs have no resolution base)
    .replace(
      /^import\s+Supercluster\s+from\s+['"]supercluster['"];?\s*$/m,
      `import Supercluster from ${JSON.stringify(superclusterUrl)};`
    );

  if (/from\s+['"]maplibre-gl['"]/.test(stripped)) {
    throw new Error('failed to strip the maplibre-gl import from src/map.js');
  }
  if (/\.css['"]/.test(stripped)) {
    throw new Error('failed to strip a CSS import from src/map.js');
  }
  if (!/import Supercluster from "file:/.test(stripped)) {
    throw new Error('failed to rewrite the supercluster import in src/map.js');
  }

  return import(
    `data:text/javascript;charset=utf-8,${encodeURIComponent(stripped)}`
  );
}

/* ------------------------------------------------------------
   Tiny assertion helpers
   ------------------------------------------------------------ */

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function equal(name, actual, expected) {
  const same =
    typeof expected === 'number' && typeof actual === 'number'
      ? Math.abs(actual - expected) < 1e-9
      : actual === expected;
  check(name, same, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------
   Synthetic fixture

   Two tight knots of coffees, far enough apart that they never merge at
   the zoom we query, plus one lone coffee well away from both.

     ODD  cluster — Sydney-ish  — 5 prices, known median 5.00
     EVEN cluster — Perth-ish   — 6 prices, known median 5.25
     LONE point   — Darwin-ish  — never clusters
   ------------------------------------------------------------ */

const ODD_PRICES = [4.5, 7.0, 5.0, 3.2, 6.4]; //  sorted: 3.2 4.5 [5.0] 6.4 7.0  -> 5.00
const EVEN_PRICES = [6.0, 4.0, 5.5, 5.0, 8.2, 3.1]; // sorted: 3.1 4 5 5.5 6 8.2 -> (5+5.5)/2 = 5.25

const ODD_MEDIAN = 5.0;
const EVEN_MEDIAN = 5.25;

const SYDNEY = { lat: -33.87, lon: 151.21 };
const PERTH = { lat: -31.95, lon: 115.86 };
const DARWIN = { lat: -12.46, lon: 130.85 };

/** Scatter points a few hundred metres apart so they cluster together. */
function knot(origin, prices, idPrefix) {
  return prices.map((price, i) => ({
    id: `${idPrefix}${i}`,
    price,
    lat: origin.lat + i * 0.004,
    lon: origin.lon + i * 0.004,
    location: idPrefix,
    state: 'AU',
    confidence: 'high',
    drink: 'flat white',
    excerpt: `synthetic ${price}`,
    author: 'test',
    permalink: 'https://example.invalid/',
  }));
}

const COFFEES = [
  ...knot(SYDNEY, ODD_PRICES, 'odd'),
  ...knot(PERTH, EVEN_PRICES, 'even'),
  {
    id: 'lone0',
    price: 4.0,
    lat: DARWIN.lat,
    lon: DARWIN.lon,
    location: 'Darwin',
    state: 'NT',
    confidence: 'high',
    drink: null,
    excerpt: 'synthetic lone',
    author: 'test',
    permalink: 'https://example.invalid/',
  },
];

const AU_BBOX = [110, -45, 156, -9];

/* ------------------------------------------------------------
   Run
   ------------------------------------------------------------ */

const { createClusterIndex, median, formatPrice, toGeoJSONPoints } =
  await loadMapModule();

console.log('median() — pure function');
equal('odd-length median', median([3, 1, 2]), 2);
equal('even-length median is the mean of the middles', median([1, 2, 3, 4]), 2.5);
equal('even-length median, unsorted input', median([8.2, 3.1, 5.5, 5.0, 6.0, 4.0]), 5.25);
equal('single value', median([4.25]), 4.25);
check('empty list is NaN', Number.isNaN(median([])));
check('non-array is NaN', Number.isNaN(median(null)));
equal('ignores junk values', median([5, 'nope', null, 7]), 6);

console.log('\nformatPrice() — cents dropped when .00');
equal('whole dollars', formatPrice(5), '$5');
equal('whole dollars from 5.00', formatPrice(5.0), '$5');
equal('cents kept', formatPrice(4.5), '$4.50');
equal('two decimals', formatPrice(7.1), '$7.10');

console.log('\ntoGeoJSONPoints() — bad records dropped');
equal('all fixture points survive', toGeoJSONPoints(COFFEES).length, COFFEES.length);
equal(
  'missing coords / price are skipped',
  toGeoJSONPoints([{ price: 5 }, { lat: 1, lon: 2 }, { lat: 1, lon: 2, price: 'x' }]).length,
  0
);

console.log('\ncluster medians — real supercluster index (app config)');
const index = createClusterIndex(COFFEES);

// Zoom 6: each knot is one cluster, the lone Darwin point stands alone.
const features = index.getClusters(AU_BBOX, 6);

const clusters = features.filter((f) => f.properties.cluster);
const singles = features.filter((f) => !f.properties.cluster);

equal('two clusters at z6', clusters.length, 2);
equal('one unclustered point at z6', singles.length, 1);
equal('the unclustered point is the lone one', singles[0]?.properties.id, 'lone0');

const byCount = new Map(clusters.map((c) => [c.properties.point_count, c]));
const odd = byCount.get(ODD_PRICES.length);
const even = byCount.get(EVEN_PRICES.length);

check('found the odd-sized cluster (5 points)', Boolean(odd));
check('found the even-sized cluster (6 points)', Boolean(even));

if (odd) {
  equal('odd cluster carries every price', odd.properties.prices.length, ODD_PRICES.length);
  equal(
    'odd cluster prices match the fixture',
    [...odd.properties.prices].sort((a, b) => a - b).join(','),
    [...ODD_PRICES].sort((a, b) => a - b).join(',')
  );
  equal('odd cluster MEDIAN', median(odd.properties.prices), ODD_MEDIAN);
  equal('odd cluster median renders', formatPrice(median(odd.properties.prices)), '$5');
}

if (even) {
  equal('even cluster carries every price', even.properties.prices.length, EVEN_PRICES.length);
  equal(
    'even cluster prices match the fixture',
    [...even.properties.prices].sort((a, b) => a - b).join(','),
    [...EVEN_PRICES].sort((a, b) => a - b).join(',')
  );
  equal('even cluster MEDIAN (mean of the two middles)', median(even.properties.prices), EVEN_MEDIAN);
  equal('even cluster median renders', formatPrice(median(even.properties.prices)), '$5.25');
}

console.log('\nmerged cluster at low zoom — reduce() must not lose or duplicate prices');
const wide = index.getClusters([100, -50, 160, -5], 0);
const merged = wide.filter((f) => f.properties.cluster);
const totalPoints = wide.reduce(
  (sum, f) => sum + (f.properties.cluster ? f.properties.point_count : 1),
  0
);
equal('every coffee is accounted for at z0', totalPoints, COFFEES.length);

const allMergedPrices = merged.flatMap((f) => f.properties.prices);
const mergedPointCount = merged.reduce((sum, f) => sum + f.properties.point_count, 0);
equal('one price per clustered point (no dupes, no drops)', allMergedPrices.length, mergedPointCount);

if (merged.length === 1 && merged[0].properties.point_count === COFFEES.length) {
  const everything = COFFEES.map((c) => c.price);
  equal(
    'single mega-cluster median matches a plain median of all prices',
    median(merged[0].properties.prices),
    median(everything)
  );
}

console.log('\nno mutation of child cluster props across zoom levels');
const oddAgain = index
  .getClusters(AU_BBOX, 6)
  .filter((f) => f.properties.cluster && f.properties.point_count === ODD_PRICES.length)[0];
equal(
  're-querying z6 still yields exactly 5 prices (reduce did not push into a shared array)',
  oddAgain?.properties.prices.length,
  ODD_PRICES.length
);
equal('...and the same median', median(oddAgain?.properties.prices ?? []), ODD_MEDIAN);

console.log('\ngetClusterExpansionZoom is usable for tap-to-zoom');
if (odd) {
  const expansion = index.getClusterExpansionZoom(odd.properties.cluster_id);
  check(
    `expansion zoom (${expansion}) is greater than the query zoom`,
    Number.isFinite(expansion) && expansion > 6,
    `got ${expansion}`
  );
}

/* ------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('Failed checks:\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
}
