#!/usr/bin/env node
/**
 * fetch-thread.mjs — reproducible fetch of the source Reddit thread.
 *
 * Thread: r/AskAnAustralian "How much was your coffee this morning" (post id 1vii42k)
 *
 * WHY NOT REDDIT: reddit.com returns HTTP 403 from this build environment on every
 * route we tried — www.reddit.com/...json, old.reddit.com, oauth-less api endpoints,
 * the r.jina.ai text proxy, and public redlib mirrors. Do not "fix" this script by
 * pointing it back at reddit.com; it will fail. We read the thread from the
 * Arctic Shift public archive instead (https://arctic-shift.photon-reddit.com).
 *
 * Endpoints (both verified working):
 *   POST:     /api/posts/ids?ids=1vii42k
 *   COMMENTS: /api/comments/tree?link_id=1vii42k&limit=9999
 *
 * ---------------------------------------------------------------------------
 * OBSERVED PAYLOAD SHAPES (verified against the cached files in data/raw/)
 * ---------------------------------------------------------------------------
 * thread-post.json:
 *   { data: [ { id, author, title, permalink, selftext, created_utc, ... } ] }
 *   NOTE: post objects are NOT {kind, data} wrapped — the fields sit directly on
 *   the array element. Exactly 1 element for a single-id query.
 *
 * thread-comments.json:
 *   { data: [ { kind: "t1", data: { id, author, body, score, created_utc,
 *                                   parent_id, link_id, permalink, replies } } ] }
 *   - `kind` is the literal string "t1" for comments.
 *   - `data.replies` is one of exactly two things (both observed in the cache):
 *       (a) the empty string ""  -> the comment has no replies, OR
 *       (b) { kind: "Listing", data: { dist: <number>, children: [ ... ] } }
 *           where each child is another {kind: "t1", data: {...}} node,
 *           recursively nested to arbitrary depth.
 *     No other value (null, undefined, array) appears in the cache.
 *   - The top-level `data` array holds only ROOT comments; walking `replies`
 *     recursively yields the rest. Cache as committed: 233 roots / 337 total
 *     (an earlier snapshot had 228 / 328 — the archive keeps picking up new
 *     comments, so expect the count to drift upward over time).
 *
 * Usage:
 *   node scripts/fetch-thread.mjs           # no-op if both cache files exist
 *   node scripts/fetch-thread.mjs --force   # always re-download
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'data', 'raw');
const POST_FILE = path.join(RAW_DIR, 'thread-post.json');
const COMMENTS_FILE = path.join(RAW_DIR, 'thread-comments.json');

const POST_ID = '1vii42k';
const API = 'https://arctic-shift.photon-reddit.com';
const POST_URL = `${API}/api/posts/ids?ids=${POST_ID}`;
const COMMENTS_URL = `${API}/api/comments/tree?link_id=${POST_ID}&limit=9999`;

const BLOCKED_NOTE = [
  'NOTE: reddit.com is blocked (HTTP 403) from this environment on every route —',
  'www/old/api .json endpoints, the r.jina.ai proxy, and redlib mirrors all fail.',
  'This script deliberately uses the Arctic Shift archive API instead.',
  'The last known-good responses are committed at data/raw/thread-*.json;',
  'run without --force to use them.',
].join('\n');

function die(msg) {
  console.error(`\nfetch-thread: FAILED — ${msg}\n\n${BLOCKED_NOTE}\n`);
  process.exit(1);
}

async function exists(p) {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url, label) {
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'coffee-coster/1.0 (+data build script)' },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    die(`network error fetching ${label} from ${url}: ${err.message}`);
  }
  if (res.status !== 200) {
    die(`${label} fetch returned HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    die(`${label} response was not valid JSON (${err.message}); first 200 chars: ${text.slice(0, 200)}`);
  }
}

/** Recursively count comments in the tree, validating shape as we go. */
function countComments(children, depth = 0) {
  if (!Array.isArray(children)) die(`comment tree: expected an array of nodes at depth ${depth}`);
  let n = 0;
  for (const node of children) {
    if (!node || typeof node !== 'object' || !node.data || typeof node.data !== 'object') {
      die(`comment tree: node at depth ${depth} is missing a .data object`);
    }
    if (node.kind !== 't1') die(`comment tree: expected kind "t1" at depth ${depth}, got ${JSON.stringify(node.kind)}`);
    if (typeof node.data.id !== 'string') die(`comment tree: node at depth ${depth} has no string .data.id`);
    n += 1;
    const replies = node.data.replies;
    // Observed: either "" (no replies) or {kind:"Listing", data:{children:[...]}}
    if (replies === '' || replies == null) continue;
    if (typeof replies !== 'object' || !replies.data || !Array.isArray(replies.data.children)) {
      die(`comment tree: comment ${node.data.id} has unexpected .replies shape: ${JSON.stringify(replies).slice(0, 120)}`);
    }
    n += countComments(replies.data.children, depth + 1);
  }
  return n;
}

function validatePost(payload) {
  if (!payload || !Array.isArray(payload.data) || payload.data.length === 0) {
    die('post payload does not look like { data: [ {...} ] }');
  }
  const post = payload.data[0];
  if (post.id !== POST_ID) die(`post payload id mismatch: expected ${POST_ID}, got ${post.id}`);
  for (const field of ['title', 'author', 'permalink']) {
    if (typeof post[field] !== 'string') die(`post payload is missing string field "${field}"`);
  }
  return post;
}

function validateComments(payload) {
  if (!payload || !Array.isArray(payload.data)) die('comments payload does not look like { data: [ ... ] }');
  if (payload.data.length === 0) die('comments payload contained zero root comments');
  const total = countComments(payload.data);
  if (total < 300) die(`comment tree only had ${total} comments; expected ~328 — refusing to clobber the cache`);
  return { roots: payload.data.length, total };
}

async function main() {
  const force = process.argv.slice(2).includes('--force');

  if (!force && (await exists(POST_FILE)) && (await exists(COMMENTS_FILE))) {
    console.log('fetch-thread: cache present at data/raw/thread-post.json and data/raw/thread-comments.json — skipping network.');
    console.log('fetch-thread: re-run with --force to re-download.');
    return;
  }

  await mkdir(RAW_DIR, { recursive: true });

  console.log(`fetch-thread: GET ${POST_URL}`);
  const postPayload = await fetchJson(POST_URL, 'post');
  const post = validatePost(postPayload);

  console.log(`fetch-thread: GET ${COMMENTS_URL}`);
  const commentsPayload = await fetchJson(COMMENTS_URL, 'comments');
  const { roots, total } = validateComments(commentsPayload);

  await writeFile(POST_FILE, JSON.stringify(postPayload, null, 2) + '\n');
  await writeFile(COMMENTS_FILE, JSON.stringify(commentsPayload) + '\n');

  console.log(`fetch-thread: post "${post.title}" by u/${post.author}`);
  console.log(`fetch-thread: wrote ${path.relative(ROOT, POST_FILE)}`);
  console.log(`fetch-thread: wrote ${path.relative(ROOT, COMMENTS_FILE)} — ${roots} root comments, ${total} total.`);
}

await main();
