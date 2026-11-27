// The shared drawer's search box asks the node's note index (PANote.search) and shows a row whose
// `doc` a hit names, even when the row's title/preview do not contain the words — with the hit's
// snippet and where it matched. Rows without `doc`, and a page without PANote, behave as before.
// PAChat is RUN (helpers-stationery loadChatUi) with a fake PANote; the drawer's own code decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, APP_SRC } from './helpers-app.mjs';
import { WHERE, hit, tick, SETTLE_MS, ids, drawer } from './helpers-drawer-search.mjs';   // the fixture (shared with drawer-search-open)

test('a row the index names is shown with the hit snippet and a where-chip, though its own text does not match', async () => {
  const D = await drawer(async () => ({ ok: true, hits: [hit('entry-2.json')] }));
  await D.type('landlord');
  assert.deepEqual(ids(D.rows()), [], 'before the reply: nothing local matches "landlord"');
  assert.match(D.rows(), /搜索中… · Searching…/, 'while the node is owed a reply the list says so, not "No matches" (R13 round 2 #3)');
  assert.doesNotMatch(D.rows(), /No matches/);
  await tick(SETTLE_MS);
  assert.deepEqual(D.calls, ['landlord'], 'the node was asked once');
  assert.deepEqual(ids(D.rows()), ['b'], 'the hit row appears; the no-doc row c and the unmatched row a do not');
  assert.match(D.rows(), /pac-lprev">…met the #landlord about…</, 'the snippet replaces the preview');
  assert.match(D.rows(), /pac-lchip pac-lwhere">标签 · Tag</, 'the where-chip uses PANote.SEARCH_TXT');
  assert.equal(D.msg(), '', 'no failure text');
});

test('the local filter still works on its own, and a hit joins it rather than replacing it', async () => {
  const D = await drawer(async () => ({ ok: true, hits: [hit('entry-2.json', 'typed', 'roof repairs')] }));
  await D.type('roof');
  assert.deepEqual(ids(D.rows()), ['a'], 'the local match shows at once');
  await tick(SETTLE_MS);
  assert.deepEqual(ids(D.rows()), ['a', 'b'], 'both: local a (newer) and hit b');
  assert.match(D.rows(), /pac-lprev">typed about the roof</, 'a local row keeps its own preview');
  assert.match(D.rows(), /文本 · Text/, 'a typed hit says so');
});

test('CONTROL: a row without `doc` is never a hit, and without PANote nothing is asked', async () => {
  const D = await drawer(async () => ({ ok: true, hits: [hit('entry-9.json')] }));
  await D.type('landlord');
  await tick(SETTLE_MS);
  assert.deepEqual(ids(D.rows()), [], 'a hit on a file no row claims shows nothing — and row c, which has no doc, cannot be it');
  const plain = await drawer(null);
  await plain.type('roof');
  await tick(SETTLE_MS);
  assert.deepEqual(ids(plain.rows()), ['a'], 'no PANote: the local filter alone, exactly as before');
  assert.deepEqual(plain.calls, []);
});

test('debounced: only the settled query is sent; a reply to an older query is dropped', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const D = await drawer(async (q) => (q === 'lan' ? slow.then(() => ({ ok: true, hits: [hit('entry-1.json')] })) : { ok: true, hits: [hit('entry-2.json')] }));
  await D.type('la'); await tick(50); await D.type('lan');
  assert.deepEqual(D.calls, [], 'nothing sent inside the debounce window');
  await tick(SETTLE_MS);
  assert.deepEqual(D.calls, ['lan'], 'one request for the settled text');
  await D.type('landlord'); await tick(SETTLE_MS);
  release();                                   // the OLD query's reply arrives after the new one
  await tick(20);
  assert.deepEqual(D.calls, ['lan', 'landlord']);
  assert.deepEqual(ids(D.rows()), ['b'], 'the old reply (entry-1 → row a) did not overwrite the current hits');
});

test('clearing the box clears the hits', async () => {
  const D = await drawer(async () => ({ ok: true, hits: [hit('entry-2.json')] }));
  await D.type('landlord'); await tick(SETTLE_MS);
  assert.deepEqual(ids(D.rows()), ['b']);
  await D.type('');
  assert.deepEqual(ids(D.rows()), ['a', 'b', 'c'], 'every row, no snippet');
  assert.doesNotMatch(D.rows(), /pac-lwhere/);
});

test('a failed search is said once under the box, with the reason the shell carried; the local filter keeps working (R5)', async () => {
  const D = await drawer(async () => ({ ok: false, error: 'Signed out · 登录已过期 — sign in again', code: 'unauthorized' }));
  await D.type('roof'); await tick(SETTLE_MS);
  assert.equal(D.msg(), 'Signed out · 登录已过期 — sign in again', 'the shell\'s sentence reaches the user, not a generic line');
  assert.deepEqual(ids(D.rows()), ['a'], 'local matches still show');
  const T = await drawer(async () => { throw new Error('network'); });
  await T.type('roof'); await tick(SETTLE_MS);
  assert.equal(T.msg(), 'network', 'a throw is a failure too, never an unhandled rejection');
  const F = await drawer(async () => ({ ok: false, code: 'search-failed' }));
  await F.type('roof'); await tick(SETTLE_MS);
  assert.equal(F.msg(), WHERE.failed, 'no reason carried: the bilingual fallback from PANote.SEARCH_TXT');
});

test('clearing the box supersedes the in-flight query and takes the failure line with it', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const D = await drawer(async () => slow.then(() => ({ ok: false, error: 'boom' })));
  await D.type('roof'); await tick(SETTLE_MS);
  assert.deepEqual(D.calls, ['roof'], 'the query is in flight');
  await D.type('');
  release(); await tick(20);
  assert.equal(D.msg(), '', 'a failure that lands after the clear says nothing under an empty box');
  const E = await drawer(async () => ({ ok: false, error: 'boom' }));
  await E.type('roof'); await tick(SETTLE_MS);
  assert.equal(E.msg(), 'boom', 'CONTROL: the failure was shown while the query stood');
  await E.type('');
  assert.equal(E.msg(), '', 'clearing the box clears it');
  assert.deepEqual(ids(E.rows()), ['a', 'b', 'c'], 'and every row is back');
});

test('`doc` is passed through by listDrawer and the chat list, and both hosts supply it', () => {
  assert.match(CHAT, /created:it\.created, ai:it\.ai, doc:it\.doc,/, 'listDrawer passes doc');
  assert.match(CHAT, /ai:!!n\.ai, tab:'notes', doc:n\.doc,/, 'the chat ☰ list passes the augment row\'s doc');
  for (const [name, src] of Object.entries(APP_SRC)) {
    if (name.startsWith('notes')) assert.match(src, /doc:\{path:entryPath\(e\.id\)\}/, `${name}: a journal row names its file`);
    if (name.startsWith('bible')) assert.match(src, /doc:\{path:chapterFile\(n\.bookIdx,n\.chapter\),scope:n\.verseKey\|\|''\}/, `${name}: a Bible row names its chapter file and draws key`);
  }
  assert.match(CHAT, /window\.PANote&&typeof window\.PANote\.search==='function'/, 'feature-detected, never required');
});

// R13 round 2 #3: "No matches" is a verdict, said only once the node has answered (or failed).
test('"No matches" waits for the reply: an empty answer says it, a failure says it under the failure line', async () => {
  const D = await drawer(async () => ({ ok: true, hits: [] }));
  await D.type('zzz');
  assert.match(D.rows(), /搜索中… · Searching…/);
  await tick(SETTLE_MS);
  assert.match(D.rows(), /无匹配 · No matches/, 'the empty reply arrived: now it is a verdict');
  assert.doesNotMatch(D.rows(), /Searching/);
  const F = await drawer(async () => ({ ok: false, error: 'boom' }));
  await F.type('zzz');
  assert.match(F.rows(), /搜索中… · Searching…/);
  await tick(SETTLE_MS);
  assert.match(F.rows(), /无匹配 · No matches/, 'a failure is an answer too: the local filter\'s verdict stands');
  assert.equal(F.msg(), 'boom');
  const P = await drawer(null);
  await P.type('zzz');
  assert.match(P.rows(), /无匹配 · No matches/, 'CONTROL: without PANote nothing is pending, the local verdict is immediate');
});

// R13 round 2 #4: a NEW query clears the previous failure line at once and supersedes the one in flight.
test('typing on clears the failure line at once and drops a late reply to the superseded query', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const D = await drawer(async (q) => (q === 'roof' ? slow.then(() => ({ ok: false, error: 'old failure' })) : { ok: true, hits: [hit('entry-2.json')] }));
  await D.type('roof'); await tick(SETTLE_MS);
  assert.deepEqual(D.calls, ['roof'], 'the first query is in flight');
  await D.type('roofs');                       // inside the debounce window of the new query
  release(); await tick(20);                   // the OLD query's failure lands now
  assert.equal(D.msg(), '', 'a reply to a superseded query writes nothing');
  assert.match(D.rows(), /搜索中… · Searching…/, 'and the new query is still pending');
  await tick(SETTLE_MS);
  assert.deepEqual(D.calls, ['roof', 'roofs']);
  assert.deepEqual(ids(D.rows()), ['b']);
  const E = await drawer(async (q) => (q === 'roof' ? { ok: false, error: 'said once' } : { ok: true, hits: [] }));
  await E.type('roof'); await tick(SETTLE_MS);
  assert.equal(E.msg(), 'said once', 'CONTROL: the failure was shown while the query stood');
  await E.type('roofs');
  assert.equal(E.msg(), '', 'the next keystroke takes it away, before any reply');
});

// R13 round 2 #2: scope matching. A doc WITHOUT a scope property claims a hit of any scope in its
// file (the journal); a doc WITH one matches exactly (the Bible passes verseKey||'').
test('a scope-less row doc matches a hit of any scope; a doc with a scope matches that scope exactly', async () => {
  const extra = [
    { id: 'v16', title: 'John 3:16', preview: 'verse note', updated: 5, doc: { path: 'notes/43-3.json', scope: 'v16' } },
    { id: 'free', title: 'Chapter note', preview: 'chapter-wide', updated: 4, doc: { path: 'notes/43-3.json', scope: '' } },
  ];
  const D = await drawer(async () => ({ ok: true, hits: [hit('notes/43-3.json', 'typed', 'God so loved', 'v16'), hit('entry-1.json', 'typed', 'legacy words', 'draw')] }), extra);
  await D.type('loved'); await tick(SETTLE_MS);
  assert.deepEqual(ids(D.rows()), ['v16', 'a'], 'the v16 hit reaches the v16 row and NOT the scope-\'\' row; the scope-less journal row a claims the \'draw\' hit');
  assert.match(D.rows(), /pac-lprev">God so loved</);
  assert.match(D.rows(), /pac-lprev">legacy words</);
  const E = await drawer(async () => ({ ok: true, hits: [hit('notes/43-3.json', 'typed', 'chapter words', '')] }), extra);
  await E.type('chapter words'); await tick(SETTLE_MS);
  assert.deepEqual(ids(E.rows()), ['free'], 'CONTROL: a scope-\'\' hit reaches the scope-\'\' row only');
});

// R13 round 3 #2: when the node's cap cut real matches the drawer says so under the box, once, and a
// later full answer clears it.
test('a truncated answer is said under the box; a complete one clears it', async () => {
  let truncated = true;
  const D = await drawer(async () => ({ ok: true, hits: [hit('entry-2.json')], truncated }));
  await D.type('grace');
  await tick(SETTLE_MS);
  assert.equal(D.msg(), WHERE.more, 'the cut is reported');
  assert.deepEqual(ids(D.rows()), ['b'], 'the hits that did arrive are shown');
  truncated = false;
  await D.type('grace abounds');
  await tick(SETTLE_MS);
  assert.equal(D.msg(), '', 'a complete answer clears the line');
});

// ── Phase 2: what the node says about handwriting goes under the box ──
test('pages still being transcribed are said under the box with the count; an ink or photo hit shows its chip', async () => {
  let pending = 12;
  const D = await drawer(async () => ({ ok: true, hits: [hit('entry-2.json', 'ink', 'Saturday pollen moderate')], truncated: false, pending, ocr: 'ready' }));
  await D.type('pollen'); await tick(SETTLE_MS);
  assert.equal(D.msg(), '正在识别 12 页 · Transcribing 12 pages', 'the count fills {n} in both languages');
  assert.deepEqual(ids(D.rows()), ['b']);
  assert.match(D.rows(), /pac-lchip pac-lwhere">手写 · Ink</, 'an ink hit says so');
  pending = 0;
  await D.type('pollen count'); await tick(SETTLE_MS);
  assert.equal(D.msg(), '', 'nothing owed: the line goes away');
  const P = await drawer(async () => ({ ok: true, hits: [hit('entry-1.json', 'photo', 'receipt total')], pending: 0, ocr: 'ready' }));
  await P.type('receipt'); await tick(SETTLE_MS);
  assert.match(P.rows(), /pac-lchip pac-lwhere">图片 · Photo</);
  assert.equal(P.msg(), '');
});

test('a node that cannot transcribe says so ONLY when pages are owed; truncation still wins over all; a phase-1 reply (no pending/ocr) says nothing', async () => {
  const N = await drawer(async () => ({ ok: true, hits: [], pending: 3, ocr: 'unavailable' }));
  await N.type('zzz'); await tick(SETTLE_MS);
  assert.equal(N.msg(), WHERE.noOcr, 'unavailable outranks the pending count: the pages will not be transcribed here');
  // R13 round 1 #6: a node with no ink pages (pending 0) must not nag about the Mac node on every search.
  const Z = await drawer(async () => ({ ok: true, hits: [hit('entry-1.json', 'typed', 'roof')], pending: 0, ocr: 'unavailable' }));
  await Z.type('roof'); await tick(SETTLE_MS);
  assert.equal(Z.msg(), '', 'nothing owed: a Linux node with typed-only notebooks says nothing under the box');
  assert.deepEqual(ids(Z.rows()), ['a']);
  const T = await drawer(async () => ({ ok: true, hits: [hit('entry-2.json')], truncated: true, pending: 3, ocr: 'unavailable' }));
  await T.type('zzz'); await tick(SETTLE_MS);
  assert.equal(T.msg(), WHERE.more, 'the cap cut real matches: that is said first');
  const B = await drawer(async () => ({ ok: true, hits: [], pending: 0, ocr: 'building' }));
  await B.type('zzz'); await tick(SETTLE_MS);
  assert.equal(B.msg(), '', 'building with nothing owed says nothing');
  const O = await drawer(async () => ({ ok: true, hits: [hit('entry-2.json')] }));
  await O.type('zzz'); await tick(SETTLE_MS);
  assert.equal(O.msg(), '', 'CONTROL: a reply without the phase 2 fields shows no OCR line');
  assert.match(CHAT, /const searchNote=r=>r\.truncated\?whereLabel\('more'\):r\.pending>0\?ocrLine\(r\):'';/, 'the precedence is ONE expression: truncation, else (owed only) the OCR line');
  assert.match(CHAT, /const ocrLine=r=>r\.ocr==='failed'\?whereLabel\('ocrFailed'\)\+\(r\.reason\?' — '\+r\.reason:''\):r\.ocr==='unavailable'\?whereLabel\('noOcr'\):whereLabel\('pending'\)/, 'failed (with reason) over unavailable over the count');
});

// R13 round 1 #1/#14: the node could transcribe but failed lately (build failed, timeout): said with
// the node's reason, and only while pages are owed.
test('ocr:failed is said under the box with the node\'s reason while pages are owed, and not when nothing is owed', async () => {
  const reason = 'swiftc: error: unable to find utility "swiftc"';
  let pending = 5;
  const D = await drawer(async () => ({ ok: true, hits: [hit('entry-1.json', 'typed', 'roof')], pending, ocr: 'failed', reason }), null, { PA_SEARCH_REFRESH_MS: 60000 });
  await D.type('roof'); await tick(SETTLE_MS);
  assert.equal(D.msg(), `${WHERE.ocrFailed} — ${reason}`, 'the failure and why, in the node\'s words');
  assert.deepEqual(ids(D.rows()), ['a'], 'typed hits are unaffected');
  pending = 0;
  await D.type('roof repairs'); await tick(SETTLE_MS);
  assert.equal(D.msg(), '', 'a failed node with nothing owed says nothing');
  const R = await drawer(async () => ({ ok: true, hits: [], pending: 1, ocr: 'failed' }), null, { PA_SEARCH_REFRESH_MS: 60000 });
  await R.type('zzz'); await tick(SETTLE_MS);
  assert.equal(R.msg(), WHERE.ocrFailed, 'no reason carried: the sentence alone');
});

// R13 round 1 #7: a reply that says pages are still being transcribed is re-asked ONCE after
// PA_SEARCH_REFRESH_MS (4 s in the shipped page) while the box holds the same text, so a hit
// transcribed meanwhile appears without a keystroke. Once only; never after the text changed.
test('a pending reply is re-asked once after the refresh interval with the same text; not twice, and not after the text changed', async () => {
  const REFRESH = 300;   // > SETTLE_MS - the 250 ms debounce: the first check lands after the reply and before the refresh
  let pending = 2, hits = [];
  const D = await drawer(async () => ({ ok: true, hits, pending, ocr: 'ready' }), null, { PA_SEARCH_REFRESH_MS: REFRESH });
  await D.type('pollen'); await tick(SETTLE_MS);
  assert.deepEqual(D.calls, ['pollen']);
  assert.equal(D.msg(), '正在识别 2 页 · Transcribing 2 pages');
  pending = 0; hits = [hit('entry-2.json', 'ink', 'Saturday pollen moderate')];   // the queue finished meanwhile
  await tick(REFRESH + 60);
  assert.deepEqual(D.calls, ['pollen', 'pollen'], 'asked once more, the same text');
  assert.equal(D.msg(), '', 'the fresh reply: nothing owed any more');
  assert.deepEqual(ids(D.rows()), ['b'], 'the ink hit transcribed after the first reply appears without a keystroke');
  await tick(REFRESH + 60);
  assert.deepEqual(D.calls, ['pollen', 'pollen'], 'and not a third time');
  // Still pending after the refresh: ONE refresh per query, not a poll.
  pending = 3; hits = [];
  const P = await drawer(async () => ({ ok: true, hits, pending, ocr: 'ready' }), null, { PA_SEARCH_REFRESH_MS: REFRESH });
  await P.type('ink'); await tick(SETTLE_MS); await tick(REFRESH + 60); await tick(REFRESH + 60);
  assert.deepEqual(P.calls, ['ink', 'ink'], 'the refresh is bounded: one, even while the node still says pending');
  // The text changed before the refresh fired: the stale refresh is dropped (the new query has its own).
  const C = await drawer(async (q) => ({ ok: true, hits: [], pending: q === 'in' ? 2 : 0, ocr: 'ready' }), null, { PA_SEARCH_REFRESH_MS: REFRESH });
  await C.type('in'); await tick(SETTLE_MS);
  await C.type('ink'); await tick(SETTLE_MS); await tick(REFRESH + 60);
  assert.deepEqual(C.calls, ['in', 'ink'], 'no refresh of "in": its text is gone; "ink" came back with nothing owed, so none for it either');
});
