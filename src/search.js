/* ============================================================
   Coffee Coster — suburb search, autocomplete and recent searches.

   This module is deliberately split into two halves:

   1. PURE LOGIC (no DOM, no network) — `expandRows`, `buildIndex`,
      `searchSuburbs`, `pushRecent`. These are exported so they can be
      exercised from plain node (see `scripts/test-search.mjs`).
   2. THE WIDGET — `initSearch()`, which wires the pure logic to the
      markup already present in index.html.

   The gazetteer (~17.5k suburbs, ~750 KB) is lazy-loaded on the first
   focus/input of the search box so it never blocks first paint.
   ============================================================ */

import Fuse from 'fuse.js';

// The stylesheet is pulled in dynamically so this module stays importable
// from node (where a `.css` specifier would throw). Vite still bundles it.
if (typeof document !== 'undefined') {
  import('./search.css').catch(() => {});
}

/* ------------------------------------------------------------------ */
/* constants                                                           */
/* ------------------------------------------------------------------ */

export const RECENT_KEY = 'coffee-coster:recent';
export const MAX_RECENT = 3;
export const MAX_RESULTS = 8;

const SUBURBS_URL = 'data/suburbs.json';

/** After a failed gazetteer fetch, wait this long before retrying. */
const RETRY_AFTER_MS = 5000;

/** AU state/territory tokens we allow at the tail of a query. */
const STATE_TOKENS = new Map([
  ['nsw', 'NSW'],
  ['vic', 'VIC'],
  ['qld', 'QLD'],
  ['sa', 'SA'],
  ['wa', 'WA'],
  ['tas', 'TAS'],
  ['nt', 'NT'],
  ['act', 'ACT'],
  ['new south wales', 'NSW'],
  ['victoria', 'VIC'],
  ['queensland', 'QLD'],
  ['south australia', 'SA'],
  ['western australia', 'WA'],
  ['tasmania', 'TAS'],
  ['northern territory', 'NT'],
  ['australian capital territory', 'ACT'],
]);

/**
 * Capital-city centroids with a rough metro population (millions).
 *
 * Australia reuses its suburb names relentlessly — there is a Newtown in
 * four states, a St Kilda in three, a Carlton in four. Fuzzy score alone
 * cannot separate them, so the one the user almost certainly meant (the
 * inner-city suburb of a big city) kept losing to a rural namesake.
 * Proximity to a capital, weighted by how big that capital is, is a decent
 * stand-in for "how likely is this the one you meant" — and it needs no
 * extra data in the gazetteer.
 */
const CAPITALS = [
  { lat: -33.8688, lon: 151.2093, weight: 5.3 }, // Sydney
  { lat: -37.8136, lon: 144.9631, weight: 5.2 }, // Melbourne
  { lat: -27.4698, lon: 153.0251, weight: 2.6 }, // Brisbane
  { lat: -31.9523, lon: 115.8613, weight: 2.2 }, // Perth
  { lat: -34.9285, lon: 138.6007, weight: 1.4 }, // Adelaide
  { lat: -35.2809, lon: 149.13, weight: 0.46 }, // Canberra
  { lat: -42.8821, lon: 147.3272, weight: 0.25 }, // Hobart
  { lat: -12.4634, lon: 130.8456, weight: 0.15 }, // Darwin
];

/**
 * Optimal string alignment distance — Levenshtein plus adjacent
 * transposition, which is the single most common way a suburb name gets
 * mistyped ("newtwon"). Without the transposition rule "Newtown" and
 * "Newton" look equally far from "newtwon"; with it they still tie, which
 * is the point: it lets the prominence tie-break decide between them
 * instead of an arbitrary Fuse score gap.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  // Two rolling rows plus the one before them (needed for transpositions).
  let prev2 = null;
  let prev = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;

  let current = new Array(t.length + 1);
  for (let i = 1; i <= s.length; i++) {
    current[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let best = Math.min(
        current[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost // substitution
      );
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        best = Math.min(best, prev2[j - 2] + 1); // transposition
      }
      current[j] = best;
    }
    prev2 = prev;
    prev = current;
    current = new Array(t.length + 1);
  }
  return prev[t.length];
}

/** Radius at which a capital's pull has fallen to half. */
const METRO_FALLOFF_KM = 25;

/** Most a prominence bonus may move a Fuse score. Small on purpose: it
 *  breaks ties between comparable matches, it never rescues a bad one. */
const MAX_PROMINENCE_BONUS = 0.3;

const KM_PER_DEG = 111.32;

/** Edit distances at or above this are treated as equally bad. */
const EDIT_BUCKET_CAP = 3;

/**
 * How "obviously meant" a coordinate is, as a score in roughly [0, 5.3].
 * Peaks in the middle of the biggest capitals and decays with distance.
 * @param {number} lat
 * @param {number} lon
 */
export function prominence(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 0;
  // Equirectangular is plenty at this scale and far cheaper than haversine.
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = 0;
  for (const c of CAPITALS) {
    const dy = (lat - c.lat) * KM_PER_DEG;
    const dx = (lon - c.lon) * KM_PER_DEG * cosLat;
    const d = Math.sqrt(dx * dx + dy * dy) / METRO_FALLOFF_KM;
    const pull = c.weight / (1 + d * d);
    if (pull > best) best = pull;
  }
  return best;
}

/** Prominence squashed into the [0, MAX_PROMINENCE_BONUS] range. */
function prominenceBonus(lat, lon) {
  const p = prominence(lat, lon);
  return MAX_PROMINENCE_BONUS * (p / (p + 1));
}

/* ------------------------------------------------------------------ */
/* pure logic                                                          */
/* ------------------------------------------------------------------ */

/**
 * Expand the COMPACT gazetteer payload into plain objects.
 * Accepts either the whole `{ fields, suburbs }` document, a bare array of
 * `[name, state, lat, lon]` rows, or an array of already-expanded objects.
 *
 * @returns {Array<{name:string,state:string,lat:number,lon:number}>}
 */
export function expandRows(input) {
  if (!input) return [];

  const fields =
    (!Array.isArray(input) && Array.isArray(input.fields) && input.fields) || [
      'name',
      'state',
      'lat',
      'lon',
    ];
  const rows = Array.isArray(input) ? input : input.suburbs;
  if (!Array.isArray(rows)) return [];

  const iName = fields.indexOf('name');
  const iState = fields.indexOf('state');
  const iLat = fields.indexOf('lat');
  const iLon = fields.indexOf('lon');

  const out = [];
  for (const row of rows) {
    let name;
    let state;
    let lat;
    let lon;

    if (Array.isArray(row)) {
      name = row[iName];
      state = row[iState];
      lat = row[iLat];
      lon = row[iLon];
    } else if (row && typeof row === 'object') {
      ({ name, state, lat, lon } = row);
    } else {
      continue;
    }

    if (typeof name !== 'string' || !name) continue;
    lat = Number(lat);
    lon = Number(lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    out.push({
      name,
      state: typeof state === 'string' ? state : '',
      lat,
      lon,
    });
  }
  return out;
}

/**
 * Build the fuzzy-search index.
 * `label` ("Newtown NSW") is a derived key so a combined query like
 * "newtown nsw" scores well; `state` is kept as its own low-weight key.
 */
export function buildIndex(input) {
  const suburbs = expandRows(input);

  const records = suburbs.map((s, i) => ({
    i,
    name: s.name,
    state: s.state,
    label: s.state ? `${s.name} ${s.state}` : s.name,
  }));

  const fuse = new Fuse(records, {
    keys: [
      { name: 'name', weight: 0.6 },
      { name: 'label', weight: 0.3 },
      { name: 'state', weight: 0.1 },
    ],
    threshold: 0.35,
    distance: 100,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 2,
    shouldSort: true,
  });

  return { suburbs, records, fuse };
}

/** Split a query into its "name part" and an optional trailing state. */
function splitQuery(query) {
  const q = String(query || '')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!q) return { q: '', name: '', state: '' };

  for (const [token, abbr] of STATE_TOKENS) {
    if (q === token) return { q, name: '', state: abbr };
    if (q.endsWith(` ${token}`)) {
      return { q, name: q.slice(0, -(token.length + 1)).trim(), state: abbr };
    }
  }
  return { q, name: q, state: '' };
}

/**
 * Fuzzy-search the gazetteer.
 *
 * Fuse gives us a candidate pool; we then re-rank so exact and
 * prefix matches beat mid-word fuzzy matches (so "st kilda" puts
 * "St Kilda" above "St Kilda East"), a state mentioned in the query
 * wins a tie-break, and — among otherwise equally good matches — the
 * one in a big city's metro beats its rural namesake.
 *
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {number} [limit]
 * @returns {Array<{name:string,state:string,lat:number,lon:number}>}
 */
export function searchSuburbs(index, query, limit = MAX_RESULTS) {
  if (!index || !index.fuse) return [];
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_RESULTS;

  const { q, name: qName, state: qState } = splitQuery(query);
  if (!q) return [];

  const pool = index.fuse.search(q, { limit: Math.max(cap * 8, 40) });
  if (!pool.length) return [];

  const target = qName || q;

  const scored = pool.map((hit, order) => {
    const rec = hit.item;
    const lower = rec.name.toLowerCase();
    const place = index.suburbs[rec.i];

    let tier = 3;
    if (lower === target) tier = 0;
    else if (lower.startsWith(target)) tier = 1;
    else if (lower.includes(target)) tier = 2;

    // A state named in the query is an explicit instruction, not a hint:
    // "st kilda sa" must not hand back the Melbourne one.
    const stateMiss = qState && rec.state !== qState ? 1 : 0;

    // How badly the name was mistyped. Capped, because past a few
    // keystrokes the exact distance stops meaning anything and we would
    // rather let prominence break the tie than rank by name length.
    const edit = Math.min(editDistance(target, lower), EDIT_BUCKET_CAP);

    // Lower sorts first, so prominence is negated.
    const city = place ? -prominenceBonus(place.lat, place.lon) : 0;

    return {
      rec,
      tier,
      stateMiss,
      edit,
      city,
      score: hit.score ?? 0,
      order,
    };
  });

  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.stateMiss - b.stateMiss ||
      a.edit - b.edit ||
      a.city - b.city ||
      a.score - b.score ||
      a.rec.name.length - b.rec.name.length ||
      a.order - b.order
  );

  return scored.slice(0, cap).map((s) => index.suburbs[s.rec.i]);
}

/** Normalised identity for a suburb — name + state. */
export function suburbKey(item) {
  if (!item) return '';
  return `${String(item.name || '').toLowerCase()}|${String(
    item.state || ''
  ).toLowerCase()}`;
}

/**
 * Push a suburb onto the recent-searches list.
 * Most-recent-first, de-duplicated by name+state, hard-capped.
 * Pure: returns a new array, never mutates `list`.
 */
export function pushRecent(list, item, cap = MAX_RECENT) {
  const max = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : MAX_RECENT;
  const existing = Array.isArray(list) ? list : [];
  if (!item || typeof item.name !== 'string' || !item.name) {
    return existing.slice(0, max);
  }

  const entry = {
    name: item.name,
    state: item.state || '',
    lat: Number(item.lat),
    lon: Number(item.lon),
  };
  const key = suburbKey(entry);

  const rest = existing.filter(
    (s) => s && typeof s.name === 'string' && suburbKey(s) !== key
  );
  return [entry, ...rest].slice(0, max);
}

/* ------------------------------------------------------------------ */
/* localStorage (guarded — Safari private mode throws on access)       */
/* ------------------------------------------------------------------ */

export function loadRecent() {
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s) =>
          s &&
          typeof s.name === 'string' &&
          Number.isFinite(Number(s.lat)) &&
          Number.isFinite(Number(s.lon))
      )
      .map((s) => ({
        name: s.name,
        state: s.state || '',
        lat: Number(s.lat),
        lon: Number(s.lon),
      }))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function saveRecent(list) {
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* private mode / quota / disabled storage — recents are best-effort */
  }
}

/* ------------------------------------------------------------------ */
/* the widget                                                          */
/* ------------------------------------------------------------------ */

/**
 * Wire up the search box.
 * @param {{ onSelect?: (s:{name:string,state:string,lat:number,lon:number}) => void }} [opts]
 */
export function initSearch({ onSelect } = {}) {
  const input = document.getElementById('search-input');
  const list = document.getElementById('search-results');
  const recentEl = document.getElementById('recent-searches');

  if (!input || !list) {
    return { destroy() {}, refreshRecent() {} };
  }

  const select = typeof onSelect === 'function' ? onSelect : () => {};

  let index = null;
  let loadState = 'idle'; // idle | loading | ready | error
  let options = [];
  let activeIndex = -1;
  let open = false;
  let recent = loadRecent();
  let lastAttempt = 0;

  /* ---- ARIA scaffolding ---------------------------------------- */

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'search-results');
  input.setAttribute('autocomplete', 'off');

  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Suburb results');

  if (recentEl) {
    recentEl.setAttribute('role', 'group');
    recentEl.setAttribute('aria-label', 'Recent searches');
  }

  /* ---- data ----------------------------------------------------- */

  async function ensureData() {
    if (loadState === 'loading' || loadState === 'ready') return;
    // After a failure, allow a retry — but not on every keystroke.
    if (loadState === 'error' && Date.now() - lastAttempt < RETRY_AFTER_MS) return;

    lastAttempt = Date.now();
    loadState = 'loading';

    try {
      const res = await fetch(SUBURBS_URL, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      index = buildIndex(json);
      loadState = index.suburbs.length ? 'ready' : 'error';
    } catch {
      index = null;
      loadState = 'error';
    }

    // Re-run against whatever the user has typed in the meantime.
    if (document.activeElement === input || input.value.trim()) update();
  }

  /* ---- rendering ------------------------------------------------ */

  function renderMessage(text, tone = 'info') {
    list.innerHTML = '';
    options = [];
    activeIndex = -1;
    const li = document.createElement('li');
    li.className = `search-message${tone === 'error' ? ' is-error' : ''}`;
    li.setAttribute('role', 'presentation');
    li.textContent = text;
    list.appendChild(li);
    list.setAttribute('aria-busy', tone === 'loading' ? 'true' : 'false');
    setOpen(true);
  }

  function renderOptions(items) {
    list.innerHTML = '';
    options = items;
    activeIndex = -1;
    list.setAttribute('aria-busy', 'false');

    const frag = document.createDocumentFragment();
    items.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'search-option';
      li.id = `search-option-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      li.dataset.index = String(i);

      const name = document.createElement('span');
      name.className = 'search-option__name';
      name.textContent = s.name;

      const state = document.createElement('span');
      state.className = 'search-option__state';
      state.textContent = s.state || '';

      li.append(name, state);
      frag.appendChild(li);
    });
    list.appendChild(frag);
    setOpen(true);
  }

  function setOpen(next) {
    open = next;
    list.hidden = !next;
    input.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (!next) {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function close() {
    setOpen(false);
    activeIndex = -1;
  }

  function setActive(i) {
    const els = list.querySelectorAll('.search-option');
    els.forEach((el) => {
      el.classList.remove('is-active');
      el.setAttribute('aria-selected', 'false');
    });
    activeIndex = i;
    if (i < 0 || i >= els.length) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const el = els[i];
    el.classList.add('is-active');
    el.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', el.id);
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }

  function update() {
    const q = input.value.trim();
    if (!q) {
      close();
      list.innerHTML = '';
      options = [];
      return;
    }
    if (loadState === 'error') {
      renderMessage('Suburb list unavailable — try again later.', 'error');
      return;
    }
    if (loadState !== 'ready' || !index) {
      renderMessage('Loading suburbs…', 'loading');
      return;
    }
    const results = searchSuburbs(index, q, MAX_RESULTS);
    if (!results.length) {
      renderMessage(`No suburb matching “${q}”.`);
      return;
    }
    renderOptions(results);
  }

  /* ---- selection ------------------------------------------------ */

  function choose(suburb) {
    if (!suburb) return;
    input.value = suburb.state ? `${suburb.name}, ${suburb.state}` : suburb.name;
    close();
    input.blur();
    recent = pushRecent(recent, suburb, MAX_RECENT);
    saveRecent(recent);
    renderRecent();
    select({
      name: suburb.name,
      state: suburb.state,
      lat: suburb.lat,
      lon: suburb.lon,
    });
  }

  /* ---- recent chips --------------------------------------------- */

  function renderRecent() {
    if (!recentEl) return;
    recentEl.innerHTML = '';
    if (!recent.length) {
      recentEl.hidden = true;
      return;
    }
    const frag = document.createDocumentFragment();
    recent.forEach((s) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'recent-chip';
      chip.title = s.state ? `${s.name}, ${s.state}` : s.name;

      const name = document.createElement('span');
      name.className = 'recent-chip__name';
      name.textContent = s.name;
      chip.appendChild(name);

      if (s.state) {
        const state = document.createElement('span');
        state.className = 'recent-chip__state';
        state.textContent = s.state;
        chip.appendChild(state);
      }

      chip.addEventListener('click', () => {
        recent = pushRecent(recent, s, MAX_RECENT);
        saveRecent(recent);
        renderRecent();
        select({ name: s.name, state: s.state, lat: s.lat, lon: s.lon });
      });

      frag.appendChild(chip);
    });
    recentEl.appendChild(frag);
    recentEl.hidden = false;
  }

  /* ---- events ---------------------------------------------------- */

  const onFocus = () => {
    ensureData();
    if (input.value.trim()) update();
  };

  const onInput = () => {
    ensureData();
    update();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open && input.value.trim()) {
        update();
        return;
      }
      if (!options.length) return;
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const next =
        activeIndex < 0
          ? delta > 0
            ? 0
            : options.length - 1
          : (activeIndex + delta + options.length) % options.length;
      setActive(next);
      return;
    }

    if (e.key === 'Home' && open && options.length) {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (e.key === 'End' && open && options.length) {
      e.preventDefault();
      setActive(options.length - 1);
      return;
    }

    if (e.key === 'Enter') {
      if (open && options.length) {
        e.preventDefault();
        choose(options[activeIndex >= 0 ? activeIndex : 0]);
      }
      return;
    }

    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        close();
      } else if (input.value) {
        input.value = '';
        update();
      }
    }
  };

  // Keep focus on the input so the dropdown does not close mid-tap.
  const onListPointerDown = (e) => e.preventDefault();

  const onListClick = (e) => {
    const li = e.target.closest('.search-option');
    if (!li || !list.contains(li)) return;
    const i = Number(li.dataset.index);
    if (Number.isInteger(i)) choose(options[i]);
  };

  const onDocPointerDown = (e) => {
    if (!open) return;
    if (e.target === input || list.contains(e.target)) return;
    close();
  };

  input.addEventListener('focus', onFocus);
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  list.addEventListener('pointerdown', onListPointerDown);
  list.addEventListener('mousedown', onListPointerDown);
  list.addEventListener('click', onListClick);
  document.addEventListener('pointerdown', onDocPointerDown);

  renderRecent();

  return {
    refreshRecent() {
      recent = loadRecent();
      renderRecent();
    },
    destroy() {
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeyDown);
      list.removeEventListener('pointerdown', onListPointerDown);
      list.removeEventListener('mousedown', onListPointerDown);
      list.removeEventListener('click', onListClick);
      document.removeEventListener('pointerdown', onDocPointerDown);
    },
  };
}

export default initSearch;
