import vm from 'node:vm';
// web/reading-history.inline.html — PAReadingHistory: the last chapter read and the recent-chapters list
// (owner 2026-11-13: "remember the current reading book ... a history feature"). The shipped script is RUN
// against a fake store: dedupe, cap, newest-first, the time label, coalesced serialized writes, and a failed
// read that never writes. Pins the marker in both Bible copies and the registration in web.mjs.
// R11 — searched: "reading.json", "Reading history", "阅读历史", "PAReadingHistory", "history" in web/ — no earlier copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('web/reading-history.inline.html');
const SCRIPT = SRC.slice(SRC.indexOf('<script id="prh-script">') + 24, SRC.lastIndexOf('</script>'));
const ST = { loaded: 'loaded', absent: 'absent', failed: 'failed' };

function load() {
  const window = {};
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', SCRIPT)(window, {});
  return window.PAReadingHistory;
}
// A store whose writes resolve only when the test says so, so in-flight overlap is observable.
function fakeStore(reply) {
  const writes = []; let inFlight = 0, maxInFlight = 0; const pending = [];
  return {
    writes, pending, get maxInFlight() { return maxInFlight; },
    read: async () => reply,
    write: (p, t) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); writes.push({ p, v: JSON.parse(t) });
      return new Promise((res) => pending.push(() => { inFlight--; res({ ok: true }); })); },
    releaseAll: async () => { while (pending.length) { pending.shift()(); await new Promise((r) => setImmediate(r)); } },
  };
}
const names = (b) => ({ en: 'B' + b, zh: '书' + b });
function attach(store, extra = {}) {
  const P = load(); let t = 1000; const notices = [];
  const h = P.attach({ store, ST, bookName: names, onPick() {}, notice: (m, k) => notices.push([m, k]), noticeOk() {}, now: () => (t += 1000), ...extra });
  return { P, h, notices };
}

test('merge: newest first, a re-read chapter moves to the top (deduped), capped at CAP', () => {
  const P = load();
  let s = null;
  s = P.merge(s, 0, 1, 1); s = P.merge(s, 0, 2, 2); s = P.merge(s, 42, 3, 3); s = P.merge(s, 0, 1, 4);
  assert.deepEqual(s.history.map((e) => [e.b, e.c]), [[0, 1], [42, 3], [0, 2]]);
  assert.deepEqual(s.last, { b: 0, c: 1, at: 4 });
  for (let i = 0; i < P.CAP + 20; i++) s = P.merge(s, 1, i + 1, 10 + i);
  assert.equal(s.history.length, P.CAP, 'capped');
  assert.equal(s.history[0].c, P.CAP + 20, 'the newest kept');
});

test('sanitize: a damaged file reads as empty; bad rows are dropped', () => {
  const P = load();
  assert.deepEqual(P.sanitize('junk'), { v: 1, last: null, history: [] });
  const s = P.sanitize({ history: [{ b: 1, c: 2, at: 5 }, { b: -1, c: 1, at: 1 }, { b: 1, c: 0, at: 1 }, null] });
  assert.deepEqual(s.history, [{ b: 1, c: 2, at: 5 }]);
  assert.deepEqual(s.last, { b: 1, c: 2, at: 5 }, 'last falls back to the newest row');
});

test('timeLabel: "Just now" under a minute, else weekday + date + time', () => {
  const P = load();
  const at = new Date(2026, 10, 13, 9, 5).getTime();
  assert.equal(P.timeLabel(at, at + 59000, 'en-US'), '刚刚 · Just now');
  const l = P.timeLabel(at, at + 61000, 'en-US');
  assert.match(l, /Fri/); assert.match(l, /Nov 13/); assert.match(l, /09:05/);
});

test('restore: returns the stored last chapter; record writes the merged file', async () => {
  const store = fakeStore({ status: 'loaded', data: { v: 1, last: { b: 0, c: 2, at: 1 }, history: [{ b: 0, c: 2, at: 1 }, { b: 0, c: 1, at: 0 }] } });
  const { h } = attach(store);
  assert.deepEqual(await h.restore(), { b: 0, c: 2 });
  h.record(0, 1); await store.releaseAll(); await h.idle();
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].p, 'reading.json');
  assert.deepEqual(store.writes[0].v.history.map((e) => e.c), [1, 2]);
  assert.deepEqual([store.writes[0].v.last.b, store.writes[0].v.last.c], [0, 1]);
});

test('coalesced writes: one in flight at a time, and the last write carries the newest chapter', async () => {
  const store = fakeStore({ status: 'absent' });
  const { h } = attach(store);
  assert.equal(await h.restore(), null, 'no file: nothing to restore');
  for (let c = 1; c <= 6; c++) h.record(5, c);     // rapid ‹ › taps
  await store.releaseAll(); await h.idle();
  assert.equal(store.maxInFlight, 1, 'serialized');
  assert.ok(store.writes.length <= 2, `coalesced: ${store.writes.length} writes for 6 taps`);
  assert.deepEqual(store.writes.at(-1).v.history.map((e) => e.c), [6, 5, 4, 3, 2, 1], 'nothing lost, newest first');
  // Mutation control: without the in-flight guard the writes overlap.
  const MUT = SCRIPT.replace('if(flushing) return flushing;', '');
  assert.notEqual(MUT, SCRIPT);
  const w = {}; new Function('window', 'document', MUT)(w, {});   // eslint-disable-line no-new-func
  const s2 = fakeStore({ status: 'absent' });
  const h2 = w.PAReadingHistory.attach({ store: s2, ST, bookName: names, onPick() {}, now: () => 1 });
  await h2.restore(); h2.record(1, 1); h2.record(1, 2);
  assert.equal(s2.maxInFlight, 2, 'the control overlaps, so the guard is what serializes');
  await s2.releaseAll();
});

test('a failed read never writes, and is reported through the host notice', async () => {
  const store = fakeStore({ status: 'failed', error: 'boom' });
  const { h, notices } = attach(store);
  assert.equal(await h.restore(), null);
  h.record(1, 1); h.clear(); await h.idle();
  assert.equal(store.writes.length, 0, 'no write after a failed read');
  assert.equal(notices.length, 1); assert.match(notices[0][0], /unreadable.*boom/); assert.equal(notices[0][1], 'reading.json');
});

test('a chapter read while the file is still loading is kept on top of the stored history', async () => {
  let answer; const store = fakeStore(null);
  store.read = () => new Promise((r) => { answer = r; });
  const { h } = attach(store);
  const p = h.restore();
  h.record(2, 9); await h.idle();
  assert.equal(store.writes.length, 0, 'nothing written before the read answered');
  answer({ status: 'loaded', data: { history: [{ b: 0, c: 1, at: 1 }] } }); await p;
  await store.releaseAll(); await h.idle();
  assert.deepEqual(store.writes.at(-1).v.history.map((e) => [e.b, e.c]), [[2, 9], [0, 1]]);
});

test('clear empties the list (keeps the last chapter to reopen) and writes it', async () => {
  const store = fakeStore({ status: 'loaded', data: { history: [{ b: 0, c: 1, at: 1 }] } });
  const { h } = attach(store);
  await h.restore(); h.clear(); await store.releaseAll(); await h.idle();
  assert.deepEqual(store.writes.at(-1).v.history, []);
  assert.equal(h.entries().length, 0);
});

test('pins: both Bible copies carry the marker and the thin wiring; web.mjs registers the component last', () => {
  for (const f of ['workspace/apps/bible/index.html', 'workspace.example/apps/bible/index.html']) {
    const s = read(f);
    assert.equal(s.split('<!--PA_INK_PEN_UI-->\n<!--PA_READING_HISTORY_UI-->').length, 2, `${f}: the marker`);
    assert.equal(s.split('const RH=PAReadingHistory.attach(').length, 2, `${f}: one attach`);
    assert.match(s, /renderVerses\(vs\); if\(vs\.length&&g===_loadSeq&&b0===bookIdx&&c0===chapter\) recordWhenRead\(g,b0,c0\);/, `${f}: recorded only when the text loaded, and then only once read (F2-09)`);
    assert.match(s, /async function load\(\)\{\n  const g=\+\+_loadSeq;\n  if\(_rhBoot\) await restoreReading\(g\);/, `${f}: restored before the first load`);
    assert.match(s, /_hashBoot=true;/, `${f}: a #b..c.. hash wins`);
    assert.match(s, /id:'bible-history',anchor:\(\)=>document\.getElementById\('search-btn'\)/, `${f}: the first-use tip`);
  }
  const web = read('web.mjs');
  const list = web.slice(web.indexOf('const PA_COMPONENTS = ['), web.indexOf('];', web.indexOf('const PA_COMPONENTS = [')));
  assert.match(list, /\{ marker: '<!--PA_READING_HISTORY_UI-->', file: 'reading-history\.inline\.html' \},\n  \/\/[^\n]*\n  \/\/[^\n]*\n  \{ marker: '<!--PA_INK_FRAME_UI-->', file: 'ink-frame\.inline\.html' \},\n$/);
});

// Behaviour of the Bible's boot/load wiring, run from the real source with fakes for everything around it.
function bootHarness(f, { restore, hash = false, dwell = 0 }) {
  const src = read(f);
  const a = src.indexOf('const RH_BOOT_WAIT_MS='), b = src.indexOf('function searchIdle(');
  const c = src.indexOf('async function load(){'), d = src.indexOf('\n}\n', c) + 3;
  const pend = new Map(); const recorded = [];
  const scroller = { scrollTop: 0, fns: new Set(), addEventListener(t, f) { this.fns.add(f); }, removeEventListener(t, f) { this.fns.delete(f); },
    scroll(y) { this.scrollTop = y; [...this.fns].forEach((f) => f()); } };
  const ctx = {
    RH: { restore, record: (b, c) => recorded.push([b, c]) }, BOOKS: Array.from({ length: 66 }, () => ['x', 'x', 50]),
    bookIdx: 42, chapter: 3, bookSel: { value: 42 }, selV: { clear() {} }, updateFab() {}, followSelection() {}, fillChapters() {},
    chLabel: {}, document: { getElementById: () => scroller }, clearTimeout, loadAnn: async () => true, INK: { load() {} }, ANN: {},
    setTimeout, Promise, renderVerses() {},
    paBible: (b, c) => new Promise((res) => { const k = `${b - 1}:${c}`, prev = pend.get(k); const go = () => res({ ok: true, data: { verses: [1] } }); pend.set(k, prev ? () => { prev(); go(); } : go); }),
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b).replace('let _hashBoot=false', `let _hashBoot=${hash}`).replace('RH_DWELL_MS=4000', `RH_DWELL_MS=${dwell}`) + src.slice(c, d) +
    ';globalThis.load=load;globalThis.getBC=()=>[bookIdx,chapter];globalThis.setBC=(x,y)=>{bookIdx=x;chapter=y;};', ctx);
  return { ctx, pend, recorded, scroller, tick: () => new Promise((r) => setTimeout(r, 0)) };
}
for (const f of ['workspace/apps/bible/index.html', 'workspace.example/apps/bible/index.html']) {
  test(`${f}: a slow reading.json read does not hold the first chapter past the boot cap`, async () => {
    const h = bootHarness(f, { restore: () => new Promise(() => {}) });
    const t0 = Date.now(); const p = h.ctx.load(); while (!h.pend.size) await h.tick();
    assert.ok(Date.now() - t0 < 3000, 'capped wait'); assert.deepEqual([...h.pend.keys()], ['42:3']);
    h.pend.get('42:3')(); await p;
  });
  test(`${f}: a hash boot never waits for the read`, async () => {
    const h = bootHarness(f, { restore: () => new Promise(() => {}), hash: true });
    h.ctx.setBC(18, 23); h.ctx.load(); await h.tick(); await h.tick();
    assert.deepEqual([...h.pend.keys()], ['18:23']);
  });
  test(`${f}: a pick made during the boot wait is not overridden by the restore`, async () => {
    let done; const h = bootHarness(f, { restore: () => new Promise((r) => { done = r; }) });
    const boot = h.ctx.load(); await h.tick();
    h.ctx.setBC(44, 1); const pick = h.ctx.load(); await h.tick(); await h.tick();
    done({ b: 0, c: 2 }); await h.tick(); await h.tick();
    assert.deepEqual([...h.ctx.getBC()], [44, 1], 'the reader\'s pick stays');
    for (const fn of h.pend.values()) fn(); await Promise.all([boot, pick]); await h.tick();   // the (zeroed) dwell
    assert.deepEqual(h.recorded, [[44, 1]], 'only the current chapter is recorded');
  });
  test(`${f}: an out-of-order chapter load is not recorded`, async () => {
    const h = bootHarness(f, { restore: async () => null }); h.ctx.load(); await h.tick(); await h.tick(); h.pend.get('42:3')(); await h.tick();
    h.recorded.length = 0;
    h.ctx.setBC(42, 4); const a = h.ctx.load(); await h.tick(); h.ctx.setBC(42, 5); const b = h.ctx.load(); await h.tick();
    h.pend.get('42:5')(); await b; h.pend.get('42:4')(); await a; await h.tick();
    assert.deepEqual(h.recorded, [[42, 5]]);
  });
  test(`${f}: F2-09 — a chapter passed through (book change auto-loads ch 1, then a pick) is not recorded; dwell or scroll records`, async () => {
    const h = bootHarness(f, { restore: async () => null, dwell: 300 });
    h.ctx.load(); await h.tick(); await h.tick(); h.pend.get('42:3')(); await h.tick();
    h.ctx.setBC(44, 1); const a = h.ctx.load(); await h.tick(); h.pend.get('44:1')(); await a;   // the book drop-down opens chapter 1
    h.ctx.setBC(44, 7); const b = h.ctx.load(); await h.tick(); h.pend.get('44:7')(); await b;   // the reader picks chapter 7 at once
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(h.recorded, [[44, 7]], 'only the chapter that stayed open; boot John 3 and the passing Acts 1 were superseded before their dwell');
    h.recorded.length = 0;
    h.ctx.setBC(44, 8); const c = h.ctx.load(); await h.tick(); h.pend.get('44:8')(); await c;
    h.scroller.scroll(10); assert.deepEqual(h.recorded, [], 'a nudge is not reading');
    h.scroller.scroll(200); assert.deepEqual(h.recorded, [[44, 8]], 'a real scroll records at once, before the dwell');
    await new Promise((r) => setTimeout(r, 400)); assert.deepEqual(h.recorded, [[44, 8]], 'once');
  });
  test(`${f}: GPT round 6 — a late older chapter never paints over the newer one`, async () => {
    const h = bootHarness(f, { restore: async () => null }); h.ctx.load(); await h.tick(); await h.tick(); h.pend.get('42:3')(); await h.tick();
    let painted = 0; h.ctx.renderVerses = () => { painted++; };
    h.ctx.setBC(42, 4); const a = h.ctx.load(); await h.tick(); h.ctx.setBC(42, 5); const b = h.ctx.load(); await h.tick();
    h.pend.get('42:5')(); await b; h.pend.get('42:4')(); await a;
    assert.equal(painted, 1);
  });
}
