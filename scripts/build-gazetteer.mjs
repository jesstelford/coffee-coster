#!/usr/bin/env node
/**
 * build-gazetteer.mjs
 *
 * Builds public/data/suburbs.json — the Australian locality gazetteer that powers
 * the client-side suburb search autocomplete.
 *
 * Source: GeoNames postcode export for AU (https://download.geonames.org/export/zip/AU.zip).
 * The raw zip is cached at data/raw/AU.zip so the pipeline is reproducible offline.
 *
 * Output format (compact, to keep the mobile payload small):
 *   { generatedAt, count, fields: ["name","state","lat","lon"], suburbs: [[name,state,lat,lon], ...] }
 *
 * Node 22, ESM, zero npm dependencies.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ZIP_URL = 'https://download.geonames.org/export/zip/AU.zip';
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const ZIP_PATH = path.join(RAW_DIR, 'AU.zip');
const MEMBER = 'AU.txt';
const OUT_PATH = path.join(ROOT, 'public', 'data', 'suburbs.json');

const STATE_ABBR = new Map([
  ['new south wales', 'NSW'],
  ['victoria', 'VIC'],
  ['queensland', 'QLD'],
  ['south australia', 'SA'],
  ['western australia', 'WA'],
  ['tasmania', 'TAS'],
  ['northern territory', 'NT'],
  ['australian capital territory', 'ACT'],
]);

// Words that stay lowercase inside a name (never in first position).
// Deliberately limited to unambiguous English connectives — "de"/"la"/"van" etc. are
// load-bearing capitals in some AU place names, so they are left alone.
const MINOR_WORDS = new Set(['of', 'the', 'and', 'on', 'in', 'at']);

/* ------------------------------------------------------------------ download */

async function ensureZip() {
  mkdirSync(RAW_DIR, { recursive: true });
  if (existsSync(ZIP_PATH) && statSync(ZIP_PATH).size > 1024) {
    console.log(`[gazetteer] using cached ${rel(ZIP_PATH)} (${kb(statSync(ZIP_PATH).size)} KB)`);
    return;
  }
  console.log(`[gazetteer] downloading ${ZIP_URL} ...`);
  const res = await fetch(ZIP_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024 || buf.readUInt16LE(0) !== 0x4b50) {
    throw new Error(`downloaded file does not look like a zip (${buf.length} bytes)`);
  }
  writeFileSync(ZIP_PATH, buf);
  console.log(`[gazetteer] saved ${rel(ZIP_PATH)} (${kb(buf.length)} KB)`);
}

/* -------------------------------------------------------------------- unzip */

function hasUnzipBinary() {
  const probe = spawnSync('unzip', ['-v'], { stdio: 'ignore' });
  return probe.status === 0;
}

/** Extract a member using the system `unzip` binary. */
function extractWithUnzip(zipPath, member) {
  const dir = mkdtempSync(path.join(tmpdir(), 'geonames-'));
  try {
    execFileSync('unzip', ['-o', '-q', zipPath, member, '-d', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    return readFileSync(path.join(dir, member));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Extract a member using only node:zlib — parses the zip central directory and
 * inflates the raw deflate stream. Used when the `unzip` binary is unavailable.
 */
function extractWithZlib(zipPath, member) {
  const buf = readFileSync(zipPath);

  // Locate the End Of Central Directory record (scan backwards; comment <= 64KB).
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // offset of central directory

  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('zip: bad central directory signature');
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const uncompressedSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    if (name === member) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip: bad local header signature');
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compressedSize);
      let out;
      if (method === 0) out = Buffer.from(data);
      else if (method === 8) out = zlib.inflateRawSync(data);
      else throw new Error(`zip: unsupported compression method ${method}`);
      if (uncompressedSize && out.length !== uncompressedSize) {
        throw new Error(`zip: size mismatch (${out.length} != ${uncompressedSize})`);
      }
      return out;
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip: member ${member} not found`);
}

function readMember(zipPath, member, { forceZlib = false } = {}) {
  if (!forceZlib && hasUnzipBinary()) {
    try {
      const out = extractWithUnzip(zipPath, member);
      console.log(`[gazetteer] extracted ${member} with system unzip (${kb(out.length)} KB)`);
      return out;
    } catch (err) {
      console.warn(`[gazetteer] system unzip failed (${err.message}); falling back to node:zlib`);
    }
  }
  const out = extractWithZlib(zipPath, member);
  console.log(`[gazetteer] extracted ${member} with node:zlib inflateRaw (${kb(out.length)} KB)`);
  return out;
}

/* ---------------------------------------------------------------- normalise */

/**
 * Title-case a GeoNames place name.
 *
 * The AU postcode export is mostly already Title Case ("Palm Beach") but other GeoNames
 * country files ship UPPERCASE, so both are handled: an all-caps word is fully recased,
 * a word that already carries deliberate casing ("McKinnon") is preserved. Minor-word
 * and Mc- fixes then apply either way, so "Isle Of Capri" -> "Isle of Capri" and
 * "Mcalinden" -> "McAlinden".
 */
export function titleCase(raw) {
  const words = raw.trim().replace(/\s+/g, ' ').split(' ');
  return words
    .map((word, i) => {
      let out = word;
      // Fully recase words that arrive as ALL CAPS; leave mixed-case words as authored.
      if (out === out.toUpperCase()) {
        // Recase each hyphen/apostrophe/slash-delimited part: O'CONNOR -> O'Connor.
        out = out.toLowerCase().replace(/(^|[\s\-'’/().])([a-z])/g, (_m, sep, ch) => sep + ch.toUpperCase());
      }
      // Connectives stay lowercase unless they lead the name ("The Gap" keeps its capital).
      if (i > 0 && MINOR_WORDS.has(out.toLowerCase())) return out.toLowerCase();
      // Scottish/Irish prefix: Mcalinden -> McAlinden (Mac is left alone — "Mackay" is correct).
      return out.replace(/^Mc([a-z])/, (_m, ch) => 'Mc' + ch.toUpperCase());
    })
    .join(' ');
}

function kb(bytes) { return (bytes / 1024).toFixed(1); }
function rel(p) { return path.relative(ROOT, p) || p; }
function round4(n) { return Math.round(n * 1e4) / 1e4; }

/* ------------------------------------------------------------------- build */

function buildSuburbs(text) {
  const lines = text.split('\n');
  const groups = new Map(); // "name|state" -> { name, state, lat, lon, n }
  let rows = 0;
  let dropped = 0;

  for (const line of lines) {
    if (!line) continue;
    const f = line.split('\t');
    if (f.length < 11) { dropped++; continue; }
    rows++;

    const placeName = (f[2] || '').trim();
    const stateName = (f[3] || '').trim();
    const lat = Number.parseFloat(f[9]);
    const lon = Number.parseFloat(f[10]);

    if (!placeName) { dropped++; continue; }
    const state = STATE_ABBR.get(stateName.toLowerCase());
    if (!state) { dropped++; continue; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat === 0 || lon === 0) { dropped++; continue; }

    const name = titleCase(placeName);
    const key = `${name.toLowerCase()}|${state}`;
    const g = groups.get(key);
    if (g) {
      g.lat += lat; g.lon += lon; g.n++;
    } else {
      groups.set(key, { name, state, lat, lon, n: 1 });
    }
  }

  const suburbs = [...groups.values()]
    .map((g) => [g.name, g.state, round4(g.lat / g.n), round4(g.lon / g.n)])
    .sort((a, b) => a[0].localeCompare(b[0], 'en') || a[1].localeCompare(b[1]));

  return { suburbs, rows, dropped };
}

function serialise(suburbs) {
  const body = suburbs.map((s) => `    ${JSON.stringify(s)}`).join(',\n');
  return [
    '{',
    `  "generatedAt": ${JSON.stringify(new Date().toISOString())},`,
    `  "count": ${suburbs.length},`,
    '  "fields": ["name", "state", "lat", "lon"],',
    '  "suburbs": [',
    body,
    '  ]',
    '}',
    '',
  ].join('\n');
}

async function main() {
  const forceZlib = process.argv.includes('--zlib');
  await ensureZip();
  const text = readMember(ZIP_PATH, MEMBER, { forceZlib }).toString('utf8');

  const { suburbs, rows, dropped } = buildSuburbs(text);
  console.log(`[gazetteer] parsed ${rows} rows, dropped ${dropped}, ${suburbs.length} unique (name, state) pairs`);

  mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const json = serialise(suburbs);
  writeFileSync(OUT_PATH, json);
  const bytes = Buffer.byteLength(json);
  console.log(`[gazetteer] wrote ${rel(OUT_PATH)} — ${suburbs.length} entries, ${kb(bytes)} KB`);
  if (bytes > 1.5 * 1024 * 1024) {
    console.warn(`[gazetteer] WARNING: output exceeds 1.5MB (${kb(bytes)} KB)`);
  }

  // Sanity check a handful of well-known localities.
  const checks = [['Palm Beach', 'QLD'], ['Fitzroy', 'VIC'], ['Newtown', 'NSW'], ['Subiaco', 'WA']];
  for (const [name, state] of checks) {
    const hit = suburbs.find((s) => s[0] === name && s[1] === state);
    console.log(hit ? `[check] ${name}, ${state} -> ${hit[2]}, ${hit[3]}` : `[check] MISSING: ${name}, ${state}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[gazetteer] ${err.stack || err.message}`);
    process.exit(1);
  });
}
