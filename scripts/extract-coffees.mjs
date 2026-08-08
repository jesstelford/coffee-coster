#!/usr/bin/env node
/**
 * extract-coffees.mjs
 *
 * Turns the raw r/AskAnAustralian thread (data/raw/thread-*.json) into
 * public/data/coffees.json - one point per real, located, market-priced coffee.
 *
 * Documented decisions (see also data/overrides.json):
 *
 * PRICE
 *  - Candidates: "$6.50", "6.50", "8$", "5 bucks", "three fifty" / "six fiddy",
 *    and ranges "$5-6" / "$7.50-$9".
 *  - A range becomes its MIDPOINT (a range is the commenter's own estimate of the
 *    middle of the market, so the midpoint is the least-wrong single number).
 *  - When a comment lists several prices ("$4.20 small / $5.20 large", "$4.80 ...
 *    have paid $9.56 on a public holiday") we take the FIRST plausible one: it is
 *    the one the question was actually answering ("how much was your coffee this
 *    morning"), the later ones are asides.
 *  - ...but "first" only breaks ties between numbers of the same KIND. A number that
 *    is hearsay about the market ("7-8$ on average in Darwin", "you're looking at
 *    minimum $5") loses to a concrete price the same commenter says they actually
 *    handed over ("$4.90 for a medium soy FW"), even when the hearsay comes first.
 *    Nobody ever paid the midpoint of an average. Ranking is
 *    concrete-and-today < dated < hearsay, first one wins inside a rank.
 *  - A price that survives only as hearsay, or that is explicitly not today's
 *    ("Yesterday $6.80...", "My workday usual, though, is ... $7"), is capped at
 *    confidence "medium": it is a real number, but not a purchase made that morning.
 *  - Numbers that are obviously not a cup price are dropped first: per-kg bean
 *    prices, machine/gear prices, "$3 for a 2kg bag", "$4k of gear", "$30 a month".
 *  - Plausible range is AUD 1.00-15.00 inclusive. Anything outside is excluded
 *    with a reason (uber-delivered $30, $1000 machine, $19 for two coffees...).
 *  - Home-made / free coffees are counted in the stats but never mapped: they are
 *    not market prices. A comment counts as home/free when it has a home or free
 *    marker AND no price of $3.50 or more (that threshold keeps real cafe prices
 *    that merely mention a home machine, e.g. "had one at home ... and grabbed one
 *    from a local place, medium $4.50, Melbourne").
 *  - Coffees bought overseas (Vietnam, Japan, Oman, Indonesia...) are excluded.
 *
 * LOCATION
 *  - Longest-first, word-boundary n-gram match (5 words down to 1) against the
 *    gazetteer, after aliases from data/overrides.json. URLs are stripped first.
 *  - An alias for a REGION ("rural NSW", "bayside melbourne") borrows a town's
 *    coordinates via its "via" field but keeps the region's own name and is tagged
 *    approximate:true. It must not claim a suburb the commenter never said, and it
 *    must not share a jitter group with someone who really did name that suburb.
 *  - Single-word gazetteer names shorter than 4 characters never match, and
 *    anything on the stoplist never matches.
 *  - Duplicate names across states are resolved by, in order:
 *      1. a state/city hint in the same comment            -> confidence high
 *      2. a state/city hint from an ancestor comment       -> confidence medium
 *      3. the overrides "prefer" map (the famous one)      -> confidence medium
 *      4. most populous state (NSW>VIC>QLD>WA>SA>TAS>ACT>NT) -> confidence low
 *  - THREAD CONTEXT, both directions, both tagged confidence medium:
 *      a. a price with no location inherits from its nearest ancestor
 *      b. a price with no location inherits from the nearest descendant written by
 *         the SAME author (the "where?" -> "Newtown" pattern). Restricting to the
 *         same author stops a random replier's suburb being pinned on someone
 *         else's price.
 *  - A price with no resolvable location is counted but not mapped.
 *
 * JITTER
 *  - Coffees sharing a CENTROID (same suburb, or a region alias borrowing that
 *    suburb's coordinates) are pushed onto a ring 150-400 m around it.
 *    Angle = evenly spaced slot (sorted by id) + a per-id hash offset inside the
 *    slot; radius = per-id hash. No randomness, so output is byte-identical on
 *    re-run.
 *
 * TIMESTAMPS
 *  - generatedAt / fetchedAt are taken from the mtime of the raw thread file rather
 *    than Date.now() so that re-running the script produces byte-identical output.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_COMMENTS = path.join(ROOT, 'data/raw/thread-comments.json');
const RAW_POST = path.join(ROOT, 'data/raw/thread-post.json');
const OVERRIDES = path.join(ROOT, 'data/overrides.json');
const GAZETTEER = path.join(ROOT, 'public/data/suburbs.json');
const OUT = path.join(ROOT, 'public/data/coffees.json');

const DEBUG = process.env.DEBUG_EXTRACT === '1';

const MIN_PRICE = 1.0;
const MAX_PRICE = 15.0;
const HOME_PRICE_CEILING = 3.5;
const STATE_POPULATION_ORDER = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
const MAX_NGRAM = 5;

/* ------------------------------------------------------------------ inputs */

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function fail(msg) {
  console.error(`extract-coffees: ${msg}`);
  process.exit(1);
}

for (const p of [RAW_COMMENTS, RAW_POST, OVERRIDES, GAZETTEER]) {
  if (!fs.existsSync(p)) fail(`missing required input ${path.relative(ROOT, p)}`);
}

const overrides = readJson(OVERRIDES);
const gaz = readJson(GAZETTEER);
if (!gaz || !Array.isArray(gaz.suburbs) || gaz.suburbs.length === 0) {
  fail('public/data/suburbs.json is missing or empty - refusing to invent coordinates');
}

const rawComments = readJson(RAW_COMMENTS);
const rawPost = readJson(RAW_POST);
const postRaw = rawPost.data.children ? rawPost.data.children[0] : rawPost.data[0];
const post = postRaw.data && postRaw.data.id ? postRaw.data : postRaw;

const stamp = new Date(fs.statSync(RAW_COMMENTS).mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

/* -------------------------------------------------------------- gazetteer */

const gazIndex = new Map(); // normalised name -> [{name,state,lat,lon}]
for (const row of gaz.suburbs) {
  const [name, state, lat, lon] = row;
  const key = norm(name);
  if (!gazIndex.has(key)) gazIndex.set(key, []);
  gazIndex.get(key).push({ name, state, lat, lon });
}

const stoplist = new Set((overrides.stoplist || []).map(norm));
const aliases = new Map(Object.entries(overrides.aliases || {}).map(([k, v]) => [norm(k), v]));
const preferState = new Map(Object.entries(overrides.prefer || {}).map(([k, v]) => [norm(k), v]));
const cityStates = new Map(Object.entries(overrides.cityStates || {}).map(([k, v]) => [norm(k), v]));
const stateHints = new Map(Object.entries(overrides.stateHints || {}).map(([k, v]) => [norm(k), v]));
const excludeIds = overrides.exclude || {};
const forceIds = overrides.force || {};

const STATE_TOKENS = new Map([
  ['nsw', 'NSW'], ['vic', 'VIC'], ['qld', 'QLD'], ['wa', 'WA'],
  ['sa', 'SA'], ['nt', 'NT'], ['tas', 'TAS'], ['act', 'ACT'],
]);

/* ------------------------------------------------------------ text helpers */

function norm(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9$.\-/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Body with urls and markdown removed, whitespace collapsed. */
function cleanBody(body) {
  return String(body || '')
    .replace(/\[([^\]]*)\]\((https?:[^)]*)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised, tokenisable text used for location matching. */
function locText(clean) {
  return norm(
    clean
      .replace(/([a-z])(CBD)\b/gi, '$1 $2') // "MelbourneCBD" -> "Melbourne CBD"
      .replace(/([a-z])([A-Z][a-z])/g, '$1 $2') // "NorthSydney" -> "North Sydney"
  ).replace(/[$.\-/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

/* ------------------------------------------------------------------ prices */

const WORD_UNITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const WORD_CENTS = {
  ten: 10, fifteen: 15, twenty: 20, twentyfive: 25, thirty: 30, forty: 40,
  fifty: 50, fiddy: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** context that means the number is not the price of a cup */
const UNIT_AFTER = /^\s*(?:k\b|c\b|kg|kgs|kilo|kilos|kilogram|gram|grams|g\b|ml\b|litre|litres|l\b|pk\b|pack|bag|tin|box|sachet|cups?\b|mugs?\b|shots?\b|scoops?\b|coffees\b|times\b|years?\b|months?\b|weeks?\b|days?\b|a (?:month|week|day|year|kg|kilo|litre|serving|cup|scoop|coffee)|per\s+(?:month|week|day|year|kg|kilo|litre|serving|cup|coffee)|for (?:a |an |\d)?\s*\d*\s*(?:kg|kilo|g\b|gram|ml|l\b|pk|pack|bag|tin|box|serving)|%|oz\b)/i;
const GEAR_NEAR = /\b(machine|grinder|frother|kettle|jug|press|smeg|breville|delonghi|de.?longhi|nespresso machine|gear|setup|repairs?|watch|rolex|bottle of wine)\b/i;

function priceCandidates(clean) {
  const found = [];
  const push = (value, index, raw, isRange = false) => found.push({ value, index, raw, isRange });

  const ranges = /(?:\$\s*)?(\d{1,3}(?:\.\d{1,2})?)\s*(?:-|–|—|\s+to\s+)\s*(?:\$\s*)?(\d{1,3}(?:\.\d{1,2})?)/g;
  const consumed = [];
  let m;
  while ((m = ranges.exec(clean)) !== null) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (!(b > a)) continue;
    // A range only counts as money if a dollar sign is attached somewhere:
    // "$6-7", "7-8$". Otherwise "5 to 6 times a week" and "5-6 cups a day"
    // turn into a $5.50 coffee.
    const hasDollar =
      m[0].includes('$') || clean[m.index - 1] === '$' || clean[m.index + m[0].length] === '$';
    if (!hasDollar) continue;
    consumed.push([m.index, m.index + m[0].length]);
    push(Math.round(((a + b) / 2) * 100) / 100, m.index, m[0], true);
  }
  const inRange = (i) => consumed.some(([s, e]) => i >= s && i < e);

  const patterns = [
    /\$\s*(\d{1,4}(?:\.\d{1,2})?)/g,           // $6.50 / $6
    /(\d{1,4}(?:\.\d{1,2})?)\s*\$/g,            // 8$
    /(\d{1,4}(?:\.\d{1,2})?)\s*(?:bucks?|dollars?)\b/gi,
    /(?<![\d.])(\d{1,2}\.\d{2})(?![\d])/g,      // bare 6.20
  ];
  for (const re of patterns) {
    while ((m = re.exec(clean)) !== null) {
      if (inRange(m.index)) continue;
      if (found.some((f) => f.index === m.index)) continue;
      // a letter glued to the front means another currency ("E1.75")
      const prev = clean[m.index - 1];
      if (prev && /[A-Za-z]/.test(prev)) continue;
      push(parseFloat(m[1]), m.index, m[0]);
    }
  }

  // "five fifty", "six fiddy", "3 fifty", "five bucks" (bucks handled above)
  const words = new RegExp(
    `\\b(${Object.keys(WORD_UNITS).join('|')}|\\d{1,2})\\s+(${Object.keys(WORD_CENTS).join('|')})\\b`,
    'gi'
  );
  while ((m = words.exec(clean)) !== null) {
    if (inRange(m.index)) continue;
    const unit = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : WORD_UNITS[m[1].toLowerCase()];
    const cents = WORD_CENTS[m[2].toLowerCase()];
    if (unit === undefined || cents === undefined) continue;
    push(Math.round((unit + cents / 100) * 100) / 100, m.index, m[0]);
  }
  const wordBucks = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:bucks?|dollars?)\b/gi;
  while ((m = wordBucks.exec(clean)) !== null) {
    if (inRange(m.index)) continue;
    push(WORD_UNITS[m[1].toLowerCase()], m.index, m[0]);
  }

  found.sort((a, b) => a.index - b.index || b.raw.length - a.raw.length);
  // drop duplicates starting at the same spot
  const seen = new Set();
  return found.filter((f) => {
    if (seen.has(f.index)) return false;
    seen.add(f.index);
    return true;
  });
}

/**
 * Hearsay: the number describes the market rather than a till receipt.
 * "7-8$ on average", "you're looking at minimum $5", "most places charge $6".
 */
const HEARSAY_RE = /\b(on average|averages?|averaging|usually|usual|typically|normally|generally|minimum|at least|most places|most cafes|most shops|round here|around here|youre looking at|you are looking at|looking at|anywhere from|somewhere between|the going rate|standard price|normal range)\b/i;
/** Explicitly not this morning's cup. */
const DATED_RE = /\b(yesterday|last (?:week|month|year|night|time|sunday|monday|tuesday|wednesday|thursday|friday|saturday|weekend)|these days|used to|back (?:when|in)|a (?:while|few weeks|few months|couple of years) ago|public holiday|weekday|workday|on weekends)\b/i;

/** The sentence `index` sits in - the unit a hedge or a date qualifier governs. */
function sentenceAround(clean, index, len) {
  let start = 0;
  let end = clean.length;
  // a full stop between digits is a decimal point ("$4.20"), not a sentence end
  const bounds = /(?<![0-9])[.!?\n](?![0-9])/g;
  let m;
  while ((m = bounds.exec(clean)) !== null) {
    if (m.index + 1 <= index) start = m.index + 1;
    else if (m.index >= index + len) { end = m.index; break; }
  }
  return clean.slice(start, end);
}

function classifyPrice(clean) {
  const cands = priceCandidates(clean);
  if (cands.length === 0) return { kind: 'none', candidates: [] };

  const kept = [];
  const rejected = [];
  for (const c of cands) {
    const after = clean.slice(c.index + c.raw.length, c.index + c.raw.length + 22);
    const before = clean.slice(Math.max(0, c.index - 28), c.index);
    if (UNIT_AFTER.test(after)) { rejected.push({ ...c, why: 'not a cup price (per-weight/pack/period)' }); continue; }
    if (GEAR_NEAR.test(after.slice(0, 22)) || GEAR_NEAR.test(before)) {
      rejected.push({ ...c, why: 'equipment, not a coffee' });
      continue;
    }
    if (c.value < MIN_PRICE || c.value > MAX_PRICE) {
      rejected.push({ ...c, why: `outside plausible AUD ${MIN_PRICE.toFixed(2)}-${MAX_PRICE.toFixed(2)}` });
      continue;
    }
    const sentence = sentenceAround(clean, c.index, c.raw.length);
    // a range IS an estimate, whatever words surround it
    c.hearsay = c.isRange || HEARSAY_RE.test(sentence);
    c.dated = DATED_RE.test(sentence);
    c.rank = (c.hearsay ? 2 : 0) + (c.dated ? 1 : 0);
    kept.push(c);
  }
  if (kept.length === 0) return { kind: 'rejected', rejected, candidates: cands };

  // best rank wins; inside a rank the earliest number wins (it is the one
  // answering the question, the later ones are asides)
  const chosen = kept.reduce((best, c) => (c.rank < best.rank ? c : best), kept[0]);
  return {
    kind: 'ok',
    price: chosen.value,
    chosen,
    qualified: chosen.hearsay || chosen.dated,
    all: kept,
    rejected,
    candidates: cands,
  };
}

const HOME_RE = /\b(at home|made (?:it|mine|my own)|home (?:machine|setup|espresso|made)|my (?:own )?(?:machine|espresso machine|coffee machine|kitchen)|moka|aeropress|plunger|french press|stove ?top|bialetti|dripolator|drip (?:coffee )?machine|instant|nescaf|moccona|vittoria|pods?\b|nespresso|coffee bags|my machine|makes better than cafes|espresso machine)\b/i;
const FREE_RE = /\b(free|for nothing|\$0\b|zero|didn.?t pay|comped|on the house|work (?:machine|coffee)|coffee at work|at work)\b/i;
const OVERSEAS_RE = /\b(vietnam|japan|indonesia|java|bali|bangkok|thailand|oman|muscat|colombia|america|usa|united states|canada|new zealand|nz\b|england|uk\b|london|europe|italy|spain|france|germany|dubai|singapore|philippines|korea|china|hong kong|india|bangladesh|fiji|malaysia|greece|turkey)\b/i;

/* --------------------------------------------------------------- location */

function stateHintsIn(text) {
  const hits = new Set();
  const tokens = text.split(' ');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (STATE_TOKENS.has(t)) hits.add(STATE_TOKENS.get(t));
    for (let n = Math.min(3, tokens.length - i); n >= 1; n--) {
      const phrase = tokens.slice(i, i + n).join(' ');
      if (stateHints.has(phrase)) hits.add(stateHints.get(phrase));
      if (cityStates.has(phrase)) hits.add(cityStates.get(phrase));
    }
  }
  return hits;
}

/**
 * Find the first place named in `text`.
 * Returns {name,state,lat,lon,how,ambiguous} or null.
 */
function matchPlace(text, ownHints, inheritedHints) {
  const tokens = text.split(' ').filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    for (let n = Math.min(MAX_NGRAM, tokens.length - i); n >= 1; n--) {
      const phrase = tokens.slice(i, i + n).join(' ');
      if (stoplist.has(phrase)) continue;

      // aliases are hand-written, so short ones like "tsv" / "syd" are allowed
      const alias = aliases.get(phrase);
      if (alias) {
        const resolved = resolveAlias(alias);
        if (resolved) return { ...resolved, how: 'alias', phrase };
        continue;
      }

      if (n === 1 && phrase.length < 4) continue;
      const rows = gazIndex.get(phrase);
      if (!rows) continue;
      if (rows.length === 1) {
        return { ...rows[0], how: 'gazetteer', phrase, confidence: 'high' };
      }
      // ambiguous
      for (const [hints, conf] of [[ownHints, 'high'], [inheritedHints, 'medium']]) {
        const hit = rows.filter((r) => hints.has(r.state));
        if (hit.length === 1) return { ...hit[0], how: 'gazetteer+hint', phrase, confidence: conf };
        if (hit.length > 1) {
          const best = pickByPopulation(hit);
          return { ...best, how: 'gazetteer+hint', phrase, confidence: 'low' };
        }
      }
      const pref = preferState.get(phrase);
      if (pref) {
        const hit = rows.find((r) => r.state === pref);
        if (hit) return { ...hit, how: 'gazetteer+prefer', phrase, confidence: 'medium' };
      }
      const best = pickByPopulation(rows);
      return { ...best, how: 'gazetteer+population', phrase, confidence: 'low' };
    }
  }
  return null;
}

function pickByPopulation(rows) {
  return [...rows].sort(
    (a, b) => STATE_POPULATION_ORDER.indexOf(a.state) - STATE_POPULATION_ORDER.indexOf(b.state)
  )[0];
}

/**
 * alias -> place. Coordinates come from, in order: explicit lat/lon on the alias;
 * the gazetteer row named by "via" (for regions, which have no gazetteer row of
 * their own and must not be renamed to the town lending them a centroid); the
 * gazetteer row matching the alias name.
 */
function resolveAlias(alias) {
  const base = { name: alias.name, state: alias.state, confidence: alias.confidence || 'medium' };
  if (alias.approximate) base.approximate = true;
  if (alias.lat !== undefined && alias.lon !== undefined) {
    return { ...base, lat: alias.lat, lon: alias.lon };
  }
  const rows = gazIndex.get(norm(alias.via || alias.name));
  if (!rows) return null;
  const hit = rows.find((r) => r.state === alias.state) || rows[0];
  return { ...base, lat: hit.lat, lon: hit.lon };
}

/* ------------------------------------------------------------------ drinks */

const DRINKS = [
  [/\bdirty chai\b/i, 'dirty chai'],
  [/\bcold brew\b/i, 'cold brew'],
  [/\bbatch(?:ie|\s*brew)\b/i, 'batch brew'],
  [/\biced? (?:long black)\b/i, 'iced long black'],
  [/\biced? latte\b/i, 'iced latte'],
  [/\biced? coffee\b/i, 'iced coffee'],
  [/\blong black\b/i, 'long black'],
  [/\bshort black\b/i, 'short black'],
  [/\blong mac(?:chiato)?\b/i, 'long macchiato'],
  [/\bmacchiato\b/i, 'macchiato'],
  [/\bflat ?white\b|\bfw\b/i, 'flat white'],
  [/\bcappu?c+h?ino\b|\bcaps?\b/i, 'cappuccino'],
  [/\bpiccolo\b/i, 'piccolo'],
  [/\bmagic\b/i, 'magic'],
  [/\bmoc(?:ha|ca)\b/i, 'mocha'],
  [/\bdouble espresso\b/i, 'double espresso'],
  [/\bespresso\b/i, 'espresso'],
  [/\bfilter coffee\b/i, 'filter coffee'],
  [/\blatte\b/i, 'latte'],
  [/\bchai\b/i, 'chai'],
];

function drinkIn(text) {
  for (const [re, name] of DRINKS) if (re.test(text)) return name;
  return null;
}

/**
 * Every distinct drink named anywhere in the text. Patterns overlap by design
 * ("double espresso" also matches /espresso/), so a hit sitting inside a longer
 * hit is the same cup and is dropped - otherwise "double espresso" would look
 * like a comment naming two different drinks.
 */
function allDrinksIn(text) {
  const hits = [];
  for (const [re, name] of DRINKS) {
    const m = re.exec(text);
    if (m) hits.push({ name, start: m.index, end: m.index + m[0].length });
  }
  const kept = hits.filter(
    (h) =>
      !hits.some(
        (o) => o !== h && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start
      )
  );
  return new Set(kept.map((h) => h.name));
}

/**
 * The clause `index` sits in. Clause boundaries are , ; : and the connectives
 * "and" / "&" / "+", plus full stops that are NOT inside a decimal ("$4.20").
 * The price token's own span is protected so it can never be split.
 */
function clauseAround(clean, index, len) {
  const bounds = /(?<![0-9])\.(?![0-9])|[,;:!?\n]|\s(?:and|&|\+|plus)\s/gi;
  let start = 0;
  let end = clean.length;
  let m;
  while ((m = bounds.exec(clean)) !== null) {
    const b0 = m.index;
    const b1 = m.index + m[0].length;
    if (b1 <= index) start = b1;
    else if (b0 >= index + len) { end = b0; break; }
  }
  return clean.slice(start, end);
}

/**
 * Name the drink that the CHOSEN price actually bought.
 *
 * "$4.20 for my double espresso, $4.50 for my wifes flat white" is one comment
 * with two cups: scanning the whole body labels the $4.20 a flat white. So:
 *   1. look in the clause the price sits in;
 *   2. if that clause names none, fall back to the whole comment ONLY when the
 *      comment names exactly one drink (then there is nothing to mix up);
 *   3. otherwise leave it null rather than guess which cup was which.
 */
function detectDrink(clean, priceIndex, priceLen) {
  if (priceIndex !== undefined && priceIndex !== null) {
    const clause = drinkIn(clauseAround(clean, priceIndex, priceLen || 0));
    if (clause) return clause;
    const all = allDrinksIn(clean);
    return all.size === 1 ? [...all][0] : null;
  }
  return drinkIn(clean);
}

/* ------------------------------------------------------------------ jitter */

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function jitter(lat, lon, id, slot, slots) {
  if (slots <= 1) return [round4(lat), round4(lon)];
  const h = hash32(id);
  // stay in the middle half of the slot so neighbouring pins keep clear air
  const within = 0.25 + (((h >>> 8) % 1000) / 1000) * 0.5;
  const angle = ((slot + within) / slots) * Math.PI * 2;
  const radius = 150 + (h % 251); // 150..400 m
  const dLat = (radius * Math.cos(angle)) / 111320;
  const dLon = (radius * Math.sin(angle)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return [round4(lat + dLat), round4(lon + dLon)];
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;

/* ------------------------------------------------------------------- walk */

const nodes = [];
const byId = new Map();

function walk(children, parentId) {
  for (const child of children || []) {
    if (child.kind !== 't1' || !child.data) continue;
    const d = child.data;
    const node = {
      id: d.id,
      parentId,
      author: d.author,
      body: d.body || '',
      children: [],
      depth: parentId ? byId.get(parentId).depth + 1 : 1,
    };
    nodes.push(node);
    byId.set(node.id, node);
    if (parentId) byId.get(parentId).children.push(node.id);
    if (d.replies && d.replies.data) walk(d.replies.data.children, node.id);
  }
}

const opNode = {
  id: post.id,
  parentId: null,
  author: post.author,
  body: (post.selftext || post.title || '').trim(),
  children: [],
  depth: 0,
  isPost: true,
};
nodes.push(opNode);
byId.set(opNode.id, opNode);
walk(rawComments.data, null);
for (const n of nodes) {
  if (!n.isPost && n.parentId === null) {
    n.parentId = opNode.id;
    opNode.children.push(n.id);
    n.depth = 1;
  }
}

/* ---------------------------------------------------------------- analysis */

const stats = {
  totalNodes: nodes.length,
  deletedOrBot: 0,
  withPrice: 0,
  homeOrFree: 0,
  overseas: 0,
  notCoffee: 0,
  manualExclude: 0,
  priceRejected: 0,
  rejectReasons: new Map(),
  locDirect: 0,
  locAncestor: 0,
  locDescendant: 0,
  locUnresolved: 0,
};

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

const DEAD_RE = /^\s*(\[removed\]|\[deleted\])\s*$/i;

// pass 1 - per comment analysis
for (const n of nodes) {
  n.clean = cleanBody(n.body);
  n.dead = DEAD_RE.test(n.clean) || n.author === 'AutoModerator' || n.author === '[deleted]';
  n.loc = norm(locText(n.clean));
  n.ownHints = stateHintsIn(n.loc);
  if (n.dead) {
    stats.deletedOrBot++;
    continue;
  }
  n.place = matchPlace(n.loc, n.ownHints, new Set());
  n.priceInfo = classifyPrice(n.clean);
  // a comment the overrides throw out must not donate its location to neighbours
  if (excludeIds[n.id]) n.place = null;
}

// hints inherited down the tree (a reply under "Brunswick, Melbourne" is in VIC)
for (const n of nodes) {
  const inherited = new Set();
  let cur = n.parentId ? byId.get(n.parentId) : null;
  let guard = 0;
  while (cur && !cur.isPost && guard++ < 20) {
    for (const h of cur.ownHints || []) inherited.add(h);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  n.inheritedHints = inherited;
  if (!n.dead && !n.place && inherited.size) {
    n.place = matchPlace(n.loc, new Set(), inherited);
    if (n.place) n.place.how += '(ancestor-hint)';
  }
}

// NOTE: the OP is the parent of every top-level comment, but answering "how much
// was your coffee" from Palm Beach does not put the answerer in Palm Beach, so the
// post never donates its location or its state hints to replies.
function ancestorPlace(node) {
  let cur = node.parentId ? byId.get(node.parentId) : null;
  let guard = 0;
  while (cur && !cur.isPost && guard++ < 20) {
    if (cur.place) return { place: cur.place, from: cur.id };
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return null;
}

function descendantPlace(node) {
  const queue = [...node.children];
  let guard = 0;
  while (queue.length && guard++ < 200) {
    const cur = byId.get(queue.shift());
    if (!cur) continue;
    if (cur.author === node.author && cur.place) return { place: cur.place, from: cur.id };
    queue.push(...cur.children);
  }
  return null;
}

const coffees = [];
const dropped = [];

for (const n of nodes) {
  if (n.dead) continue;

  const forced = forceIds[n.id];
  if (excludeIds[n.id]) {
    stats.manualExclude++;
    dropped.push({ id: n.id, why: `override: ${excludeIds[n.id]}` });
    continue;
  }

  // a force entry may set only a location or only a drink; the price is then
  // still the extracted one, and the comment still has to pass the sanity filters
  const forcedPrice = forced && forced.price !== undefined;
  const pi = n.priceInfo;
  const hasAnyPrice = pi.kind !== 'none';
  if (!hasAnyPrice && !forcedPrice) continue;

  if (pi.kind === 'ok' || forcedPrice) stats.withPrice++;
  else {
    // every candidate number was thrown out
    stats.priceRejected++;
    for (const r of pi.rejected) bump(stats.rejectReasons, r.why);
    dropped.push({ id: n.id, why: pi.rejected.map((r) => `${r.raw.trim()} ${r.why}`).join('; ') });
    continue;
  }

  let price = forcedPrice ? forced.price : pi.price;

  if (!forcedPrice) {
    if (OVERSEAS_RE.test(n.clean)) {
      stats.overseas++;
      dropped.push({ id: n.id, why: 'coffee bought overseas' });
      continue;
    }
    const homeish = HOME_RE.test(n.clean) || FREE_RE.test(n.clean);
    if (homeish && price < HOME_PRICE_CEILING) {
      stats.homeOrFree++;
      dropped.push({ id: n.id, why: 'home-made or free coffee (not a market price)' });
      continue;
    }
    // tea / straight chai are not coffee (a dirty chai has espresso in it, so it stays)
    const teaOnly =
      /\btea\b/i.test(n.clean) &&
      !/\b(coffee|latte|flat white|cappu|espresso|mocha|long black|brew)\b/i.test(n.clean);
    if (teaOnly || detectDrink(n.clean) === 'chai') {
      stats.notCoffee++;
      dropped.push({ id: n.id, why: 'not a coffee (tea / straight chai)' });
      continue;
    }
  }

  // ---- location
  let place = null;
  let confidence = null;
  let how = null;
  if (forced && forced.name) {
    const resolved = resolveAlias(forced);
    if (resolved) { place = resolved; confidence = forced.confidence || 'high'; how = 'override'; }
  }
  if (!place && n.place) {
    place = n.place;
    confidence = n.place.confidence || 'high';
    how = n.place.how;
    stats.locDirect++;
  }
  if (!place) {
    const anc = ancestorPlace(n);
    if (anc) {
      place = anc.place;
      confidence = 'medium';
      how = `inherited from ancestor ${anc.from}`;
      stats.locAncestor++;
    }
  }
  if (!place) {
    const desc = descendantPlace(n);
    if (desc) {
      place = desc.place;
      confidence = 'medium';
      how = `inherited from own reply ${desc.from}`;
      stats.locDescendant++;
    }
  }
  if (!place) {
    stats.locUnresolved++;
    dropped.push({ id: n.id, why: 'price but no resolvable location' });
    continue;
  }
  if (confidence !== 'low' && place.confidence === 'low') confidence = 'low';
  // hearsay ("7-8$ on average") or a price that is explicitly not today's
  // ("Yesterday $6.80...") is never "high", however clean the geocode is
  if (confidence === 'high' && !forcedPrice && pi.kind === 'ok' && pi.qualified) {
    confidence = 'medium';
    how += ' (price is hearsay or not same-day)';
  }

  const permalink = n.isPost
    ? `https://www.reddit.com${post.permalink}`
    : `https://www.reddit.com/r/AskAnAustralian/comments/${post.id}/comment/${n.id}/`;

  const chosen = pi.kind === 'ok' ? pi.chosen : null;
  const drink =
    forced && forced.drink !== undefined
      ? forced.drink
      : detectDrink(n.clean, chosen ? chosen.index : undefined, chosen ? chosen.raw.length : 0);

  const record = {
    id: n.id,
    price: Math.round(price * 100) / 100,
    lat: place.lat,
    lon: place.lon,
    location: place.name,
    state: place.state,
    confidence,
    drink,
    excerpt: truncate(n.clean, 180),
    author: n.author,
    permalink,
    _how: how,
  };
  // only present when true: the comment named a region, not a place. lat/lon is a
  // stand-in centroid, so the UI should not draw it as a precise pin.
  if (place.approximate) record.approximate = true;
  coffees.push(record);
}

/* ------------------------------------------------------------------ jitter */

coffees.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const groups = new Map();
for (const c of coffees) {
  // group by the CENTROID, not by the label: "Melbourne outer suburbs" borrows
  // Dandenong's coordinates, so it collides with a comment that really did say
  // Dandenong even though the two labels differ. Grouping by name would leave
  // those two exactly on top of each other.
  const key = `${c.lat.toFixed(4)}|${c.lon.toFixed(4)}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(c);
}
for (const [, list] of groups) {
  list.forEach((c, i) => {
    const [lat, lon] = jitter(c.lat, c.lon, c.id, i, list.length);
    c.lat = lat;
    c.lon = lon;
  });
}

const howById = new Map(coffees.map((c) => [c.id, c._how]));
for (const c of coffees) delete c._how;

/* ------------------------------------------------------------------ output */

const output = {
  source: {
    url: `https://www.reddit.com${post.permalink}`,
    postId: post.id,
    title: post.title,
    fetchedAt: stamp,
  },
  generatedAt: stamp,
  count: coffees.length,
  coffees,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(output, null, 2) + '\n');

/* ----------------------------------------------------------------- summary */

const prices = coffees.map((c) => c.price).sort((a, b) => a - b);
const median = prices.length
  ? prices.length % 2
    ? prices[(prices.length - 1) / 2]
    : Math.round(((prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2) * 100) / 100
  : 0;
const mean = prices.length
  ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100
  : 0;

const byConfidence = coffees.reduce((acc, c) => ((acc[c.confidence] = (acc[c.confidence] || 0) + 1), acc), {});
const byState = coffees.reduce((acc, c) => ((acc[c.state] = (acc[c.state] || 0) + 1), acc), {});

const L = [];
L.push('--- extract-coffees ---------------------------------------------');
L.push(`thread nodes (post + comments)   ${stats.totalNodes}`);
L.push(`  deleted / removed / bot        ${stats.deletedOrBot}`);
L.push(`comments with a usable price     ${stats.withPrice}`);
L.push(`comments where every number was rejected  ${stats.priceRejected}`);
for (const [why, n] of [...stats.rejectReasons].sort((a, b) => b[1] - a[1])) {
  L.push(`    ${String(n).padStart(3)}  ${why}`);
}
L.push('excluded from the map:');
L.push(`  ${String(stats.homeOrFree).padStart(3)}  home-made or free (counted, not mapped)`);
L.push(`  ${String(stats.overseas).padStart(3)}  bought overseas`);
L.push(`  ${String(stats.notCoffee).padStart(3)}  not a coffee`);
L.push(`  ${String(stats.manualExclude).padStart(3)}  manual overrides (data/overrides.json)`);
L.push(`  ${String(stats.locUnresolved).padStart(3)}  price but no resolvable location`);
L.push('locations resolved:');
L.push(`  ${String(stats.locDirect).padStart(3)}  direct match (gazetteer / alias)`);
L.push(`  ${String(stats.locAncestor).padStart(3)}  inherited from an ancestor comment`);
L.push(`  ${String(stats.locDescendant).padStart(3)}  inherited from the author's own reply`);
L.push(`mapped coffees                   ${coffees.length}`);
L.push(`  confidence                     ${JSON.stringify(byConfidence)}`);
L.push(`  by state                       ${JSON.stringify(byState)}`);
L.push(
  `price  min $${prices[0]?.toFixed(2)}  median $${median.toFixed(2)}  mean $${mean.toFixed(2)}  max $${prices[prices.length - 1]?.toFixed(2)}`
);
L.push(`wrote ${path.relative(ROOT, OUT)}`);
console.log(L.join('\n'));

if (DEBUG) {
  console.log('\n--- mapped -----------------------------------------------------');
  for (const c of coffees) {
    console.log(
      `${c.id} $${c.price.toFixed(2).padStart(5)} ${c.confidence.padEnd(6)} ${(c.location + ', ' + c.state).padEnd(28)} ${howById.get(c.id)}\n      ${c.excerpt}`
    );
  }
  console.log('\n--- located but no usable price (sanity check) ------------------');
  for (const n of nodes) {
    if (n.dead || !n.place || (n.priceInfo && n.priceInfo.kind === 'ok') || excludeIds[n.id]) continue;
    console.log(`${n.id} ${n.place.name}, ${n.place.state}\n      ${truncate(n.clean, 140)}`);
  }
  console.log('\n--- dropped ----------------------------------------------------');
  for (const d of dropped) {
    const n = byId.get(d.id);
    console.log(`${d.id} ${d.why}\n      ${truncate(n.clean, 140)}`);
  }
}
