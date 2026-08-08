#!/usr/bin/env node
/**
 * Runnable check of the pure search logic in src/search.js.
 * No DOM, no bundler — just node.
 *
 *   node scripts/test-search.mjs
 *
 * Exits non-zero if anything fails.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildIndex,
  expandRows,
  searchSuburbs,
  pushRecent,
  MAX_RECENT,
} from '../src/search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GAZETTEER = path.join(ROOT, 'public/data/suburbs.json');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function fmt(list) {
  return list.map((s) => `${s.name} ${s.state}`).join(', ') || '(none)';
}

/* ------------------------------------------------------------------ */

console.log('\nsearch: loading gazetteer');
const raw = JSON.parse(readFileSync(GAZETTEER, 'utf8'));
console.log(`  ${GAZETTEER} — count field: ${raw.count}`);

const t0 = Date.now();
const rows = expandRows(raw);
const index = buildIndex(raw);
const buildMs = Date.now() - t0;
console.log(`  expanded ${rows.length} suburbs, built index in ${buildMs}ms`);

console.log('\ncompact-row expansion');
check('rows expand to objects', rows.length > 10000, `${rows.length} rows`);
check(
  'first row has name/state/lat/lon',
  typeof rows[0].name === 'string' &&
    typeof rows[0].state === 'string' &&
    Number.isFinite(rows[0].lat) &&
    Number.isFinite(rows[0].lon),
  JSON.stringify(rows[0])
);
check(
  'index.suburbs aligns with expanded rows',
  index.suburbs.length === rows.length && index.suburbs[0].name === rows[0].name
);

/* ---- fuzzy matching ---------------------------------------------- */

console.log('\nfuzzy matching');

const typo = searchSuburbs(index, 'newtwon', 8);
check(
  'typo "newtwon" finds Newtown',
  typo.some((s) => s.name === 'Newtown'),
  fmt(typo)
);

const typo2 = searchSuburbs(index, 'brisbne', 8);
check(
  'typo "brisbne" finds Brisbane',
  typo2.some((s) => s.name.startsWith('Brisbane')),
  fmt(typo2)
);

const stk = searchSuburbs(index, 'st kilda', 8);
check(
  '"st kilda" finds St Kilda VIC',
  stk.some((s) => s.name === 'St Kilda' && s.state === 'VIC'),
  fmt(stk)
);
check(
  '"st kilda" ranks the exact "St Kilda" first',
  stk[0] && stk[0].name === 'St Kilda',
  stk[0] ? `${stk[0].name} ${stk[0].state}` : '(none)'
);

const withState = searchSuburbs(index, 'newtown nsw', 8);
check(
  '"newtown nsw" puts Newtown NSW first',
  withState[0] && withState[0].name === 'Newtown' && withState[0].state === 'NSW',
  fmt(withState)
);

const palm = searchSuburbs(index, 'palm beach', 8);
check(
  '"palm beach" finds Palm Beach QLD',
  palm.some((s) => s.name === 'Palm Beach' && s.state === 'QLD'),
  fmt(palm)
);

const exact = searchSuburbs(index, 'Fitzroy', 8);
check(
  'exact "Fitzroy" is first and case-insensitive',
  exact[0] && exact[0].name === 'Fitzroy',
  fmt(exact)
);

/* ---- limits / edge cases ----------------------------------------- */

console.log('\nlimits and edge cases');

const capped = searchSuburbs(index, 'south', 8);
check('results capped at 8', capped.length <= 8, `${capped.length} results`);

const capped3 = searchSuburbs(index, 'south', 3);
check('results capped at 3', capped3.length === 3, fmt(capped3));

check('empty query returns nothing', searchSuburbs(index, '').length === 0);
check(
  'whitespace query returns nothing',
  searchSuburbs(index, '   ').length === 0
);
check(
  'gibberish returns few or no results',
  searchSuburbs(index, 'zzqxwvkj', 8).length === 0,
  `${searchSuburbs(index, 'zzqxwvkj', 8).length} results`
);
check('null index is safe', searchSuburbs(null, 'newtown').length === 0);

const everyResultShaped = capped.every(
  (s) =>
    typeof s.name === 'string' &&
    typeof s.state === 'string' &&
    Number.isFinite(s.lat) &&
    Number.isFinite(s.lon)
);
check('results carry {name,state,lat,lon}', everyResultShaped);

/* ---- recents ------------------------------------------------------ */

console.log('\nrecent searches');

const a = { name: 'Newtown', state: 'NSW', lat: -33.8, lon: 151.18 };
const b = { name: 'St Kilda', state: 'VIC', lat: -37.86, lon: 144.97 };
const c = { name: 'Palm Beach', state: 'QLD', lat: -28.12, lon: 153.46 };
const d = { name: 'Fitzroy', state: 'VIC', lat: -37.8, lon: 144.98 };

let recents = [];
recents = pushRecent(recents, a);
recents = pushRecent(recents, b);
recents = pushRecent(recents, c);

check('holds 3 entries', recents.length === 3, fmt(recents));
check(
  'most-recent-first',
  recents[0].name === 'Palm Beach' && recents[2].name === 'Newtown',
  fmt(recents)
);

const capTest = pushRecent(recents, d);
check('hard cap of 3', capTest.length === MAX_RECENT, fmt(capTest));
check(
  'oldest is evicted',
  !capTest.some((s) => s.name === 'Newtown'),
  fmt(capTest)
);
check('newest is first', capTest[0].name === 'Fitzroy', fmt(capTest));

const dedup = pushRecent(recents, b);
check('dedupes by name+state', dedup.length === 3, fmt(dedup));
check(
  'dedupe moves the repeat to the front',
  dedup[0].name === 'St Kilda' &&
    dedup.filter((s) => s.name === 'St Kilda').length === 1,
  fmt(dedup)
);

const sameNameOtherState = pushRecent(
  [b],
  { name: 'St Kilda', state: 'SA', lat: -34.75, lon: 138.59 }
);
check(
  'same name in another state is a separate entry',
  sameNameOtherState.length === 2,
  fmt(sameNameOtherState)
);

const before = [a, b];
const after = pushRecent(before, c);
check(
  'pushRecent does not mutate its input',
  before.length === 2 && after.length === 3
);
check('pushRecent ignores junk items', pushRecent([a], null).length === 1);
check(
  'pushRecent copes with a non-array list',
  pushRecent(undefined, a).length === 1
);

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
