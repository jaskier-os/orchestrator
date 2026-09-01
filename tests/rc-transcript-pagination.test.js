#!/usr/bin/env node
// Unit test for buildMergedTranscriptPage. Stubs the Mongo store and the
// pc-agent JSONL export, so no orchestrator, CLI or database is needed.
//
// Covers:
//   1. Cursor round-trip: three consecutive pages reproduce the full transcript
//      with no duplicates and nothing dropped.
//   2. Phone-only permission entries from Mongo are spliced into the JSONL page
//      they belong to, and only that page.
//   3. hasMore comes from the JSONL spine, never Mongo -- Mongo is capped at
//      1000 entries and would claim history ends there.
//   4. Mongo-only fallback (JSONL unavailable) still pages, and flags
//      `truncated` when it bottoms out on the cap instead of implying the
//      conversation is complete.
//   5. Equal timestamps sort deterministically, so a cursor is never ambiguous.

import { initRcHandler, buildMergedTranscriptPage } from '../src/rc-handler.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

// --- Fixtures ------------------------------------------------------------

// The CLI pages the JSONL; this reimplements that slicing over a fixed array so
// the orchestrator's merge logic is what is under test.
function makeJsonlPager(all) {
  return (workDir, sessionId, opts) => {
    if (opts?.limit == null) return Promise.resolve(all);
    let end = all.length;
    if (opts.before) {
      const uid = Buffer.from(opts.before, 'base64').toString('utf8').split('|')[1];
      const idx = all.findIndex(e => e.uid === uid);
      end = idx >= 0 ? idx : Math.min(opts.limit, all.length);
    }
    const start = Math.max(0, end - opts.limit);
    const entries = all.slice(start, end);
    const nextCursor = entries.length > 0
      ? Buffer.from(`${entries[0].ts}|${entries[0].uid}`, 'utf8').toString('base64')
      : null;
    // ok:true -- the spine was READ successfully, even when it has no more
    // entries to give. Only an unreadable spine reports ok:false.
    return Promise.resolve({ entries, nextCursor, hasMore: start > 0, ok: true });
  };
}

/**
 * A pc-agent that predates paging: it ignores limit/before and returns the
 * whole transcript as a bare array. The orchestrator must page it anyway.
 */
function legacyJsonlExporter(all) {
  return () => Promise.resolve(all);
}

/** A spine that cannot be read at all: pc-agent offline, bad project slug. */
function unreadableJsonl() {
  return (workDir, sessionId, opts) =>
    Promise.resolve(opts?.limit == null
      ? []
      : { entries: [], nextCursor: null, hasMore: false, ok: false });
}

function jsonlEntries(n) {
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    type: i % 2 === 0 ? 'user_message' : 'rc_message',
    data: { text: `entry ${i}` },
    uid: `e-${i}`
  }));
}

let mongoTranscript = [];
function install(jsonlAll) {
  initRcHandler(
    { getTranscript: async () => mongoTranscript },
    new Map(),
    { exportJsonl: makeJsonlPager(jsonlAll) }
  );
}

function installLegacy(jsonlAll) {
  initRcHandler(
    { getTranscript: async () => mongoTranscript },
    new Map(),
    { exportJsonl: legacyJsonlExporter(jsonlAll) }
  );
}

function installUnreadable() {
  initRcHandler(
    { getTranscript: async () => mongoTranscript },
    new Map(),
    { exportJsonl: unreadableJsonl() }
  );
}

const SID = 'sess-1';
const WD = '/tmp/work';

// --- 1: cursor round-trip ------------------------------------------------

async function testCursorRoundTrip() {
  console.log('\ncursor round-trip across three pages');
  const all = jsonlEntries(30);
  mongoTranscript = [];
  install(all);

  const p1 = await buildMergedTranscriptPage(SID, WD, { limit: 10 });
  check('newest page has limit entries', p1.transcript.length === 10, `got ${p1.transcript.length}`);
  check('newest page is the tail',
    p1.transcript.map(e => e.uid).join() === all.slice(20).map(e => e.uid).join());
  check('hasMore true mid-history', p1.hasMore === true);
  check('not flagged truncated', p1.truncated === false);

  const p2 = await buildMergedTranscriptPage(SID, WD, { limit: 10, before: p1.nextCursor });
  const p3 = await buildMergedTranscriptPage(SID, WD, { limit: 10, before: p2.nextCursor });

  check('third page reaches the beginning', p3.hasMore === false);
  const walked = [...p3.transcript, ...p2.transcript, ...p1.transcript].map(e => e.uid);
  check('pages concatenate to the whole transcript',
    walked.join() === all.map(e => e.uid).join(),
    `walked=${walked.length} all=${all.length}`);
  check('no duplicates across pages', new Set(walked).size === all.length);
}

// --- 2/3: permission splice + hasMore source -----------------------------

async function testPermissionSplice() {
  console.log('\nMongo permission entries splice into the right page only');
  const all = jsonlEntries(30);
  // A permission prompt inside the OLDEST page's time window (entries 0-9).
  mongoTranscript = [
    {
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 4)).toISOString(),
      type: 'rc_permission_request',
      data: { toolName: 'Bash', requestId: 'req-1' }
    },
    // Plus noise Mongo also stores that must NOT be spliced.
    {
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 5)).toISOString(),
      type: 'rc_message',
      data: { text: 'mongo copy, jsonl is the spine' }
    }
  ];
  install(all);

  const p1 = await buildMergedTranscriptPage(SID, WD, { limit: 10 });
  check('permission NOT in the newest page',
    !p1.transcript.some(e => e.type === 'rc_permission_request'));
  check('newest page carries no duplicated mongo rc_message',
    p1.transcript.filter(e => e.data?.text === 'mongo copy, jsonl is the spine').length === 0);

  const p2 = await buildMergedTranscriptPage(SID, WD, { limit: 10, before: p1.nextCursor });
  const p3 = await buildMergedTranscriptPage(SID, WD, { limit: 10, before: p2.nextCursor });
  check('permission spliced into the page covering its timestamp',
    p3.transcript.some(e => e.type === 'rc_permission_request'),
    `p3 types=${p3.transcript.map(e => e.type).join(',')}`);
  check('permission lands in timestamp order',
    (() => {
      const idx = p3.transcript.findIndex(e => e.type === 'rc_permission_request');
      if (idx <= 0) return false;
      return p3.transcript[idx - 1].ts <= p3.transcript[idx].ts;
    })());
  check('non-permission mongo entries are not spliced',
    !p3.transcript.some(e => e.data?.text === 'mongo copy, jsonl is the spine'));
}

async function testHasMoreIgnoresMongoCap() {
  console.log('\nhasMore comes from the JSONL spine, not the capped Mongo array');
  const all = jsonlEntries(2500);
  // Mongo is at its 1000-entry cap, i.e. it has "forgotten" the beginning.
  mongoTranscript = Array.from({ length: 1000 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 1500 + i)).toISOString(),
    type: 'rc_message',
    data: { text: `mongo ${i}` }
  }));
  install(all);

  // Page back past where Mongo's memory ends.
  let page = await buildMergedTranscriptPage(SID, WD, { limit: 100 });
  for (let i = 0; i < 20; i++) {
    check(`page ${i} still reports hasMore`, page.hasMore === true, `page ${i}`);
    page = await buildMergedTranscriptPage(SID, WD, { limit: 100, before: page.nextCursor });
  }
  check('deep pagination is still serving JSONL entries', page.transcript.length === 100);
  check('deep page is not flagged truncated', page.truncated === false);
}

// --- 4: Mongo-only fallback ----------------------------------------------

async function testMongoOnlyFallback() {
  console.log('\nMongo-only fallback when JSONL is unavailable');
  // JSONL export yields nothing: pc-agent offline, or the project slug did not
  // resolve. Paging must still work rather than returning an empty page.
  mongoTranscript = Array.from({ length: 1000 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    type: 'rc_message',
    data: { text: `mongo ${i}` }
  }));
  installUnreadable();

  const p1 = await buildMergedTranscriptPage(SID, WD, { limit: 50 });
  check('fallback page is served', p1.transcript.length === 50, `got ${p1.transcript.length}`);
  check('fallback page is the newest slice',
    p1.transcript[p1.transcript.length - 1].data.text === 'mongo 999');
  check('fallback reports hasMore', p1.hasMore === true);
  check('mid-history fallback page is not truncated', p1.truncated === false);

  // Walk to the very start of the capped array.
  let page = p1;
  let guard = 0;
  while (page.hasMore && guard++ < 40) {
    page = await buildMergedTranscriptPage(SID, WD, { limit: 50, before: page.nextCursor });
  }
  check('reached the start of the Mongo array', page.hasMore === false);
  check('start-of-cap is flagged truncated, not "conversation complete"',
    page.truncated === true);
}

// --- 5: deterministic ordering on equal timestamps -----------------------

async function testEqualTimestampOrdering() {
  console.log('\nequal timestamps sort deterministically');
  const ts = '2026-01-01T00:00:00.000Z';
  const all = Array.from({ length: 6 }, (_, i) => ({
    ts, type: 'rc_message', data: { text: `same-ts ${i}` }, uid: `u-${i}`
  }));
  mongoTranscript = [];
  install(all);

  const a = await buildMergedTranscriptPage(SID, WD, { limit: 3 });
  const b = await buildMergedTranscriptPage(SID, WD, { limit: 3 });
  check('identical requests return identical ordering',
    a.transcript.map(e => e.uid).join() === b.transcript.map(e => e.uid).join(),
    `${a.transcript.map(e => e.uid)} vs ${b.transcript.map(e => e.uid)}`);
  check('cursor is stable across identical requests', a.nextCursor === b.nextCursor);

  const next = await buildMergedTranscriptPage(SID, WD, { limit: 3, before: a.nextCursor });
  const overlap = next.transcript.filter(e => a.transcript.some(x => x.uid === e.uid));
  check('no overlap between adjacent equal-ts pages', overlap.length === 0,
    `overlap=${overlap.map(e => e.uid).join(',')}`);
}

// --- 6: exhausted spine must NOT fall back to Mongo ----------------------

async function testExhaustedSpineIsNotAFallback() {
  console.log('\nexhausted JSONL spine is not mistaken for an unavailable one');
  const all = jsonlEntries(10);
  // Mongo holds permission entries the user has already seen spliced into
  // earlier pages. If an exhausted spine were treated as "unavailable", these
  // would be re-served as if they were older history.
  mongoTranscript = Array.from({ length: 20 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    type: 'rc_permission_request',
    data: { toolName: 'Bash', requestId: `req-${i}` }
  }));
  install(all);

  // Page to the very beginning of the spine, then ask for one more.
  let page = await buildMergedTranscriptPage(SID, WD, { limit: 5 });
  let guard = 0;
  while (page.hasMore && guard++ < 10) {
    page = await buildMergedTranscriptPage(SID, WD, { limit: 5, before: page.nextCursor });
  }
  check('reached the start of the spine', page.hasMore === false, `guard=${guard}`);

  // One more request past the start returns nothing, NOT a pile of Mongo rows.
  const past = await buildMergedTranscriptPage(SID, WD, { limit: 5, before: page.nextCursor });
  check('past-the-start page is empty', past.transcript.length === 0,
    `got ${past.transcript.length} entries: ${past.transcript.map(e => e.type).join(',')}`);
  check('past-the-start reports no more', past.hasMore === false);
  check('past-the-start is not flagged truncated', past.truncated === false);
}

// --- 7: no duplicate permission entries across a page boundary -----------

async function testNoDuplicatePermissionsAcrossBoundary() {
  console.log('\npermission entries are never emitted on two pages');
  const all = jsonlEntries(20);
  // Permissions sprinkled across the whole time range, including exactly on
  // the timestamps that fall on page boundaries.
  mongoTranscript = Array.from({ length: 20 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    type: 'rc_permission_request',
    data: { toolName: 'Bash', requestId: `req-${i}` }
  }));
  install(all);

  const seen = new Map();
  let page = await buildMergedTranscriptPage(SID, WD, { limit: 5 });
  let guard = 0;
  while (guard++ < 12) {
    for (const e of page.transcript) {
      if (e.type !== 'rc_permission_request') continue;
      const id = e.data.requestId;
      seen.set(id, (seen.get(id) || 0) + 1);
    }
    if (!page.hasMore) break;
    page = await buildMergedTranscriptPage(SID, WD, { limit: 5, before: page.nextCursor });
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  check('no permission entry appears on two pages', dupes.length === 0,
    `dupes=${dupes.map(([id, n]) => `${id}x${n}`).join(',')}`);
  check('every permission entry was delivered exactly once', seen.size === 20,
    `delivered ${seen.size} of 20`);
}

// --- 8: Mongo entries reach the phone carrying a uid ---------------------

async function testMongoEntriesCarryUid() {
  console.log('\nMongo entries are stamped with a uid so the phone can dedup');
  const all = jsonlEntries(6);
  mongoTranscript = [{
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, 2)).toISOString(),
    type: 'rc_permission_request',
    data: { toolName: 'Bash', requestId: 'req-x' }
  }];
  install(all);

  const page = await buildMergedTranscriptPage(SID, WD, { limit: 100 });
  const perm = page.transcript.find(e => e.type === 'rc_permission_request');
  check('permission entry present', !!perm);
  check('permission entry carries a uid', !!perm?.uid, `uid=${perm?.uid}`);
  check('uid is stable across identical requests',
    (await buildMergedTranscriptPage(SID, WD, { limit: 100 }))
      .transcript.find(e => e.type === 'rc_permission_request')?.uid === perm.uid);
}

// --- 9: an exporter that ignores the flags is paged server-side ----------

async function testLegacyExporterIsPagedAnyway() {
  console.log('\na pc-agent that ignores the paging flags is sliced server-side');
  // Caught against the live deployment: the running pc-agent predated the
  // flags, returned all 5521 entries for ?limit=10, and the orchestrator
  // served them verbatim -- defeating the entire feature.
  const all = jsonlEntries(300);
  mongoTranscript = [];
  installLegacy(all);

  const p1 = await buildMergedTranscriptPage(SID, WD, { limit: 10 });
  check('page respects the limit despite the exporter ignoring it',
    p1.transcript.length === 10, `got ${p1.transcript.length}`);
  check('page is the newest slice',
    p1.transcript[p1.transcript.length - 1].uid === all[all.length - 1].uid);
  check('hasMore is set', p1.hasMore === true);
  check('a cursor is issued', !!p1.nextCursor);

  const p2 = await buildMergedTranscriptPage(SID, WD, { limit: 10, before: p1.nextCursor });
  check('the cursor pages backward correctly',
    p2.transcript.map(e => e.uid).join() === all.slice(280, 290).map(e => e.uid).join(),
    p2.transcript.map(e => e.uid).slice(0, 3).join());
  check('adjacent pages do not overlap',
    !p2.transcript.some(e => p1.transcript.some(x => x.uid === e.uid)));
}

// --- run -----------------------------------------------------------------

(async () => {
  await testCursorRoundTrip();
  await testPermissionSplice();
  await testHasMoreIgnoresMongoCap();
  await testMongoOnlyFallback();
  await testEqualTimestampOrdering();
  await testExhaustedSpineIsNotAFallback();
  await testNoDuplicatePermissionsAcrossBoundary();
  await testMongoEntriesCarryUid();
  await testLegacyExporterIsPagedAnyway();

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
